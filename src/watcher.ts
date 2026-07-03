// ============================================================
// memory-watcher — Cherry Studio 对话后台监视器
//
// 轮询 agents.db 的 session_messages 表，自动将每轮对话
// 写入 Memory MCP Server 的存储（不依赖 AI 主动调用）。
//
// 启动方式：
//   npm run watch
// 或：
//   npx tsx src/watcher.ts
// ============================================================

import initSqlJs, { type Database } from "sql.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendTurn } from "./storage/raw.js";

// ============================================================
// 配置
// ============================================================

const DB_PATH = "D:/LenovoSoftstore/CherryData/Data/agents.db";
const STATE_PATH = path.resolve("watcher-state.json");
const POLL_MS = 3000;

// ============================================================
// 状态追踪
// ============================================================

interface WatcherState {
	lastMessageId: number;
}

function loadState(): WatcherState {
	try {
		return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
	} catch {
		return { lastMessageId: 0 };
	}
}

function saveState(state: WatcherState): void {
	fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ============================================================
// Agent 映射缓存：session_id → agent_id
// ============================================================

let agentCache: Record<string, string> = {};

function buildAgentCache(db: Database): void {
	try {
		const results = db.exec("SELECT id, agent_id FROM sessions WHERE agent_id IS NOT NULL;");
		if (!results[0]) return;
		for (const row of results[0].values) {
			agentCache[row[0] as string] = row[1] as string;
		}
	} catch {
		// sessions 表可能不存在或结构不同
	}
}

// ============================================================
// 从 Cherry Studio 的 JSON content 中提取对话文本
// ============================================================

function extractContent(rawContent: string): string | null {
	try {
		const parsed = JSON.parse(rawContent);
		const msg = parsed.message;
		if (!msg || !msg.role) return null;
		const text = msg.content;
		if (typeof text === "string" && text.length > 0) return text;
		return null;
	} catch {
		if (rawContent.trim().length > 0) return rawContent.trim();
		return null;
	}
}

// ============================================================
// 主轮询
// ============================================================

let db: Database | null = null;

async function initDB(): Promise<Database> {
	const SQL = await initSqlJs();
	const buf = fs.readFileSync(DB_PATH);
	return new SQL.Database(buf);
}

function reopenDB(): void {
	try {
		if (db) db.close();
		db = null;
	} catch {
		// ignore
	}
}

async function poll(): Promise<void> {
	try {
		if (!db) {
			db = await initDB();
			buildAgentCache(db);
		}

		const state = loadState();
		const lastId = state.lastMessageId;

		const results = db.exec(
			`SELECT id, session_id, role, content, created_at
			 FROM session_messages
			 WHERE id > ${lastId}
			 ORDER BY id ASC
			 LIMIT 50`,
		);

		if (!results[0]) return;

		const rows = results[0].values;
		let maxId = lastId;

		for (const row of rows) {
			const [msgId, sessionId, role, rawContent, createdAt] = row;
			const id = Number(msgId);
			if (id > maxId) maxId = id;

			const content = extractContent(rawContent as string);
			if (!content) continue;
			if (content.trim().length < 2) continue;

			const date = (createdAt as string).slice(0, 10);

			const roleMap: Record<string, "user" | "assistant"> = {
				user: "user",
				assistant: "assistant",
			};
			const mappedRole = roleMap[role as string] ?? "user";

			// 查当前 session 归属哪个 agent
			const agentId = agentCache[sessionId as string];

			const record = appendTurn(date, mappedRole, content, agentId);
			const agentTag = agentId ? `[${agentId.slice(0, 16)}]` : "[common]";
			console.error(
				`[watcher] ${agentTag} ${date} ${record.turn_id} [${mappedRole}] ${content.slice(0, 40)}...`,
			);
		}

		if (maxId > lastId) {
			saveState({ lastMessageId: maxId });
		}
	} catch (err: any) {
		if (err.message?.includes("unable to open") || err.message?.includes("locked")) {
			reopenDB();
		}
		console.error(`[watcher] 错误：${err.message}`);
	}
}

// ============================================================
// 启动
// ============================================================

async function main() {
	console.error(`[watcher] Memory Watcher 已启动，每 ${POLL_MS / 1000}s 轮询 agents.db...`);
	console.error(`[watcher] DB: ${DB_PATH}`);
	console.error(`[watcher] 状态文件: ${STATE_PATH}`);

	const state = loadState();
	console.error(`[watcher] 上次处理到 message_id: ${state.lastMessageId}`);

	await poll();
	setInterval(poll, POLL_MS);
}

main().catch((err) => {
	console.error("[watcher] 启动失败:", err);
	process.exit(1);
});
