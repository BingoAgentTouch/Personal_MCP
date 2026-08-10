// ============================================================
// watcher/index.ts — 内嵌负反馈观测层（v8）
//
// 通道①（请求流）：observe(name, args) → reformulate / read_then_research
// 通道②（raw 原文）：轮询 memory/raw/{date}/turns.jsonl → 双层纠错检测 → implicit_reject
// 产出：signals/behavior.jsonl + logs/watcher.log（带轮转）
//
// 不新增任何 MCP 工具，不改 tools/handlers/storage/search/embedding。
// observe 同步执行、内部 try-catch 吞所有异常，不影响 server。
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { jaccardSimilarity } from "../embedding/provider.js";
import { listDates, readTurns } from "../storage/raw.js";
import type { TurnRecord } from "../types.js";
import { detectTurn } from "./words.js";

// ============================================================
// 配置常量（待实测标定，不冻结）
// ============================================================

const POLL_MS = 3000;
const SIMILARITY_THRESHOLD = 0.5;
const TIME_WINDOW_MS = 30_000; // 30s
const SESSION_TIMEOUT_MS = 10 * 60_000; // 10min
const LOG_MAX_BYTES = 1024 * 1024; // 1MB

const SIGNALS_DIR = path.resolve("memory/signals");
const BEHAVIOR_PATH = path.join(SIGNALS_DIR, "behavior.jsonl");
const LOGS_DIR = path.resolve("logs");
const LOG_PATH = path.join(LOGS_DIR, "watcher.log");

// ============================================================
// 观测状态
// ============================================================

interface AgentState {
	last_search_query: string | null;
	last_search_ts: number | null;
	recent_get_ts: number | null;
	last_get_fragment_id: string | null;
	pending_reformulate: boolean;
	rt_research_logged: boolean;
}

const agentStates = new Map<string, AgentState>();
const rawCursors = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function getOrCreateState(agent: string): AgentState {
	let s = agentStates.get(agent);
	if (!s) {
		s = {
			last_search_query: null,
			last_search_ts: null,
			recent_get_ts: null,
			last_get_fragment_id: null,
			pending_reformulate: false,
			rt_research_logged: false,
		};
		agentStates.set(agent, s);
	}
	return s;
}

function turnNum(turnId: string): number {
	const m = /^turn_(\d+)$/.exec(turnId);
	return m ? parseInt(m[1], 10) : 0;
}

// ============================================================
// 写入：behavior.jsonl + logs/watcher.log（best-effort）
// ============================================================

function writeBehavior(line: Record<string, unknown>): void {
	try {
		fs.mkdirSync(SIGNALS_DIR, { recursive: true });
		const record = { ts: new Date().toISOString(), source: "watcher", ...line };
		fs.appendFileSync(BEHAVIOR_PATH, JSON.stringify(record) + "\n", "utf-8");
	} catch (e) {
		writeLog(`writeBehavior failed: ${String(e)}`);
	}
}

function writeLog(msg: string): void {
	try {
		fs.mkdirSync(LOGS_DIR, { recursive: true });
		// 大小轮转：超过上限时重命名为 .old
		try {
			const stat = fs.statSync(LOG_PATH);
			if (stat.size > LOG_MAX_BYTES) {
				try { fs.unlinkSync(LOG_PATH + ".old"); } catch { /* ignore */ }
				fs.renameSync(LOG_PATH, LOG_PATH + ".old");
			}
		} catch { /* 文件不存在，正常 */ }
		fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
	} catch {
		// 日志写入失败不影响任何逻辑
	}
}

// ============================================================
// 通道①：请求流检测（observe）
// ============================================================

/**
 * 旁观 MCP 工具调用。同步执行、内部 try-catch 吞所有异常。
 * 在 index.ts 中置于 handler(args) 调用之前、独立 try-catch（try 块外）。
 */
export function observe(name: string, args: Record<string, unknown>): void {
	try {
		if (name === "search") observeSearch(args);
		else if (name === "get_fragment") observeGetFragment(args);
	} catch (e) {
		writeLog(`observe error (${name}): ${String(e)}`);
	}
}

function observeSearch(args: Record<string, unknown>): void {
	const query = typeof args.query === "string" ? args.query : String(args.query ?? "");
	if (!query) return;
	const agentRaw = args.agent_id;
	const agent = agentRaw != null ? String(agentRaw) : "(anon)";
	const agentIdForLog = agentRaw != null ? String(agentRaw) : null;
	const s = getOrCreateState(agent);
	const now = Date.now();

	// read_then_research 检测：get_fragment 后 30s 内又 search
	if (s.recent_get_ts != null && now - s.recent_get_ts < TIME_WINDOW_MS) {
		if (!s.rt_research_logged) {
			writeBehavior({
				type: "read_then_research",
				agent_id: agentIdForLog,
				fragment_id: s.last_get_fragment_id,
				confidence: "suspect",
			});
			s.rt_research_logged = true;
		}
	}

	// reformulate 检测：连续两次 search query 相似度 < 0.5
	if (s.last_search_query != null && s.last_search_ts != null && now - s.last_search_ts < SESSION_TIMEOUT_MS) {
		const sim = jaccardSimilarity(query, s.last_search_query);
		if (sim < SIMILARITY_THRESHOLD) {
			if (!s.pending_reformulate) {
				writeBehavior({
					type: "reformulate",
					agent_id: agentIdForLog,
					query_prev: s.last_search_query,
					query_next: query,
					similarity: Math.round(sim * 10000) / 10000,
					confidence: "suspect",
				});
				s.pending_reformulate = true;
			}
		} else {
			// 相似度高，恢复正常，允许下次 reformulate 再记
			s.pending_reformulate = false;
		}
	} else {
		// 超时或首次，视为新会话
		s.pending_reformulate = false;
	}

	s.last_search_query = query;
	s.last_search_ts = now;
}

function observeGetFragment(args: Record<string, unknown>): void {
	const agentRaw = args.agent_id;
	const agent = agentRaw != null ? String(agentRaw) : "(anon)";
	const s = getOrCreateState(agent);
	s.recent_get_ts = Date.now();
	s.last_get_fragment_id = args.fragment_id != null ? String(args.fragment_id) : null;
	s.rt_research_logged = false; // 重置去重标记，允许下次 read_then_research 再记
}

// ============================================================
// 通道②：raw 原文轮询检测
// ============================================================

/** 扫描所有日期目录的新增 turn，做双层纠错检测。 */
export function flushChannel2(): void {
	for (const date of listDates()) {
		const afterNum = rawCursors.get(date) ?? 0;
		let turns: TurnRecord[];
		try {
			turns = readTurns(date);
		} catch (e) {
			writeLog(`readTurns failed (${date}): ${String(e)}`);
			continue;
		}
		const newTurns = turns.filter((t) => turnNum(t.turn_id) > afterNum);
		for (const turn of newTurns) {
			const det = detectTurn(turn.role, turn.content);
			if (det) {
				writeBehavior({
					type: "implicit_reject",
					agent_id: turn.agent_id ?? null,
					date,
					turn_id: turn.turn_id,
					turn_timestamp: turn.timestamp,
					from: det.from,
					user_text: det.user_text,
					signal_word: det.signal_word,
					confidence: "suspect",
				});
			}
		}
		if (newTurns.length > 0) {
			const maxNum = newTurns.reduce((m, t) => Math.max(m, turnNum(t.turn_id)), afterNum);
			rawCursors.set(date, maxNum);
		}
	}
}

// ============================================================
// 游标初始化
// ============================================================

/**
 * 初始化游标：各文件初始游标 = 当前最大 turn 序号（只处理启动后新写入）。
 * 保证「随会话拉起」的语义干净，不回填历史。
 */
export function initCursors(): void {
	for (const date of listDates()) {
		let turns: TurnRecord[];
		try {
			turns = readTurns(date);
		} catch {
			continue;
		}
		const maxNum = turns.reduce((m, t) => Math.max(m, turnNum(t.turn_id)), 0);
		rawCursors.set(date, maxNum);
	}
	writeLog(`initCursors: ${rawCursors.size} dates`);
}

/** 历史回填：所有 date 游标重置为 0，然后全量扫描。 */
export function backfill(): void {
	writeLog("backfill: starting (reset all cursors to 0)");
	for (const date of listDates()) {
		rawCursors.set(date, 0);
	}
	flushChannel2();
	writeLog("backfill: done");
}

// ============================================================
// 生命周期
// ============================================================

/** 启动观测层：初始化游标 + 启动轮询定时器。返回 stop 函数。 */
export function startWatcher(): () => void {
	if (started) {
		writeLog("startWatcher: already started, skip");
		return () => undefined;
	}
	started = true;
	initCursors();
	pollTimer = setInterval(() => {
		try {
			flushChannel2();
		} catch (e) {
			writeLog(`poll error: ${String(e)}`);
		}
	}, POLL_MS);
	writeLog(`watcher started, poll=${POLL_MS}ms`);
	return stopWatcher;
}

/** 停止观测层：清除定时器。 */
export function stopWatcher(): void {
	if (pollTimer != null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	started = false;
	writeLog("watcher stopped");
}

// ============================================================
// 测试辅助
// ============================================================

/** 重置内部状态（agent 状态 + 游标），供测试隔离用。 */
export function resetWatcherState(): void {
	agentStates.clear();
	rawCursors.clear();
}
