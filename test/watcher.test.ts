// ============================================================
// watcher 观测层测试
//
// 覆盖方案 §13 测试验证清单：
//   通道①（请求流）：reformulate 触发/去重/超时/anon/异常隔离
//   通道②（raw 原文）：implicit_reject/转述/误报过滤/跨日/初始游标/agent_id=null
//   detectTurn 单元测试
//   backfill 历史回填
// ============================================================

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-watcher-"));
process.chdir(tempRoot);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watcher = await import(pathToFileURL(path.join(projectRoot, "src/watcher/index.ts")).href);
const words = await import(pathToFileURL(path.join(projectRoot, "src/watcher/words.ts")).href);
const raw = await import(pathToFileURL(path.join(projectRoot, "src/storage/raw.ts")).href);

beforeEach(() => {
	fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	fs.rmSync(path.join(tempRoot, "logs"), { recursive: true, force: true });
	watcher.resetWatcherState();
});

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ============================================================
// 辅助
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function behaviorLines(): any[] {
	const fp = path.join(tempRoot, "memory/signals/behavior.jsonl");
	if (!fs.existsSync(fp)) return [];
	const text = fs.readFileSync(fp, "utf-8").trim();
	if (!text) return [];
	return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function behaviorByType(type: string): Array<Record<string, unknown>> {
	return behaviorLines().filter((l) => l.type === type);
}

// ============================================================
// 通道①：请求流检测
// ============================================================

describe("通道①：reformulate", () => {
	test("连续两次 search 不同问法 → 1 条 reformulate", () => {
		watcher.observe("search", { query: "如何实现登录功能" });
		watcher.observe("search", { query: "数据库连接池配置方法" });
		const refs = behaviorByType("reformulate");
		assert.equal(refs.length, 1);
		assert.equal(refs[0].query_prev, "如何实现登录功能");
		assert.equal(refs[0].query_next, "数据库连接池配置方法");
		assert.equal(refs[0].confidence, "suspect");
		assert.ok(typeof refs[0].similarity === "number");
	});

	test("连续三次 search 逐次改问法 → 只 1 条 reformulate（去重）", () => {
		watcher.observe("search", { query: "alpha" });
		watcher.observe("search", { query: "beta" }); // reformulate (1st)
		watcher.observe("search", { query: "gamma" }); // 去重
		assert.equal(behaviorByType("reformulate").length, 1);
	});

	test("相似度恢复后去重标记重置，允许下次再记", () => {
		// 两次相同 query（高相似度）不触发 reformulate，且重置 pending
		watcher.observe("search", { query: "项目进度 开发状态" });
		watcher.observe("search", { query: "项目进度 开发状态" }); // sim=1.0，不记，重置 pending
		assert.equal(behaviorByType("reformulate").length, 0);
		// 之后不同 query 再次触发
		watcher.observe("search", { query: "完全不同的查询内容xyz" });
		assert.equal(behaviorByType("reformulate").length, 1);
	});

	test("两次 search 间隔 > 10min → 重置状态，不记 reformulate", () => {
		const realNow = Date.now;
		let t = 1_000_000;
		Date.now = () => t;
		try {
			watcher.observe("search", { query: "first query" });
			t += 11 * 60 * 1000; // 11min
			watcher.observe("search", { query: "second query" }); // 超时，不记
			assert.equal(behaviorByType("reformulate").length, 0);
		} finally {
			Date.now = realNow;
		}
	});

	test("agent_id 缺失时归入 anon 照常检测，写入 agent_id=null", () => {
		watcher.observe("search", { query: "查询甲" });
		watcher.observe("search", { query: "查询乙" });
		const refs = behaviorByType("reformulate");
		assert.equal(refs.length, 1);
		assert.equal(refs[0].agent_id, null);
	});
});

describe("通道①：read_then_research", () => {
	test("search → get_fragment → search(30s 内) → read_then_research", () => {
		watcher.observe("search", { query: "something" });
		watcher.observe("get_fragment", { fragment_id: "2026-08-07/frag_001" });
		watcher.observe("search", { query: "other thing" });
		const rts = behaviorByType("read_then_research");
		assert.equal(rts.length, 1);
		assert.equal(rts[0].fragment_id, "2026-08-07/frag_001");
		assert.equal(rts[0].confidence, "suspect");
	});

	test("重复 get→search 模式 → 只记首条（去重）", () => {
		watcher.observe("search", { query: "aaa" });
		watcher.observe("get_fragment", { fragment_id: "f1" });
		watcher.observe("search", { query: "bbb" }); // read_then_research (1st)
		watcher.observe("search", { query: "ccc" }); // 去重
		assert.equal(behaviorByType("read_then_research").length, 1);
	});

	test("get_fragment 后超过 30s 再 search → 不记 read_then_research", () => {
		const realNow = Date.now;
		let t = 2_000_000;
		Date.now = () => t;
		try {
			watcher.observe("search", { query: "xxx" });
			watcher.observe("get_fragment", { fragment_id: "f1" });
			t += 31_000; // 31s
			watcher.observe("search", { query: "yyy" });
			assert.equal(behaviorByType("read_then_research").length, 0);
		} finally {
			Date.now = realNow;
		}
	});
});

describe("通道①：异常隔离", () => {
	test("observe 对异常输入不抛错", () => {
		// 无 query 字段
		watcher.observe("search", {});
		// null args（模拟极端情况）
		watcher.observe("search", null as unknown as Record<string, unknown>);
		// 未知工具名
		watcher.observe("unknown_tool", { foo: "bar" });
		// 不抛即通过
		assert.ok(true);
	});
});

// ============================================================
// 通道②：raw 原文检测
// ============================================================

describe("通道②：implicit_reject", () => {
	test("user 消息命中纠错词 → implicit_reject（含 turn_timestamp）", () => {
		raw.appendTurn("2026-08-07", "user", "这样不对，重新做", undefined);
		watcher.flushChannel2();
		const imps = behaviorByType("implicit_reject");
		assert.equal(imps.length, 1);
		assert.equal(imps[0].from, "user");
		assert.equal(imps[0].date, "2026-08-07");
		assert.match(imps[0].turn_id, /^turn_\d+$/);
		// turn_timestamp 必须存在（P0-3）
		assert.ok(imps[0].turn_timestamp);
		assert.equal(typeof imps[0].turn_timestamp, "string");
		assert.equal(imps[0].signal_word, "不对");
		assert.equal(imps[0].confidence, "suspect");
	});

	test("assistant 转述前缀命中 → from=assistant_transcript", () => {
		raw.appendTurn("2026-08-07", "assistant", "用户反馈：雨声太大了，调 -12dB", undefined);
		watcher.flushChannel2();
		const imps = behaviorByType("implicit_reject");
		assert.equal(imps.length, 1);
		assert.equal(imps[0].from, "assistant_transcript");
		assert.equal(imps[0].signal_word, "太大");
	});

	test("assistant 无转述前缀 → 不产生 implicit_reject（误报过滤）", () => {
		raw.appendTurn("2026-08-07", "assistant", "楼层场景 audio_zone 混响不对", undefined);
		watcher.flushChannel2();
		assert.equal(behaviorByType("implicit_reject").length, 0);
	});

	test("user 正常内容不命中", () => {
		raw.appendTurn("2026-08-07", "user", "请帮我查看项目进度", undefined);
		watcher.flushChannel2();
		assert.equal(behaviorByType("implicit_reject").length, 0);
	});

	test("跨日：两日都有新 turn → 都能处理", () => {
		raw.appendTurn("2026-08-06", "user", "背景风格不对", undefined);
		raw.appendTurn("2026-08-07", "user", "音效不行", undefined);
		watcher.flushChannel2();
		const imps = behaviorByType("implicit_reject");
		assert.equal(imps.length, 2);
		const dates = imps.map((l) => l.date).sort();
		assert.deepEqual(dates, ["2026-08-06", "2026-08-07"]);
	});

	test("初始游标：启动时已有历史 → 不产生历史信号；新写入才触发", () => {
		// 写历史 turn
		raw.appendTurn("2026-08-07", "user", "历史不对的内容", undefined);
		// 初始化游标（吸收历史）
		watcher.initCursors();
		watcher.flushChannel2();
		assert.equal(behaviorByType("implicit_reject").length, 0);
		// 写新 turn
		raw.appendTurn("2026-08-07", "user", "新的不对", undefined);
		watcher.flushChannel2();
		assert.equal(behaviorByType("implicit_reject").length, 1);
	});

	test("agent_id 缺失的 turn → implicit_reject 的 agent_id 为 null", () => {
		raw.appendTurn("2026-08-07", "user", "不对", undefined);
		watcher.flushChannel2();
		const imps = behaviorByType("implicit_reject");
		assert.equal(imps.length, 1);
		assert.equal(imps[0].agent_id, null);
	});

	test("agent_id 存在的 turn → implicit_reject 的 agent_id 为实际值", () => {
		raw.appendTurn("2026-08-07", "user", "不对", "agent_abc");
		watcher.flushChannel2();
		const imps = behaviorByType("implicit_reject");
		assert.equal(imps.length, 1);
		assert.equal(imps[0].agent_id, "agent_abc");
	});

	test("同一条 turn 不会被重复处理（游标去重）", () => {
		raw.appendTurn("2026-08-07", "user", "不对", undefined);
		watcher.flushChannel2();
		watcher.flushChannel2(); // 再次 flush
		assert.equal(behaviorByType("implicit_reject").length, 1);
	});
});

// ============================================================
// detectTurn 单元测试
// ============================================================

describe("detectTurn 单元测试", () => {
	test("user 消息命中纠错词", () => {
		const r = words.detectTurn("user", "这样不对");
		assert.ok(r);
		assert.equal(r!.from, "user");
		assert.equal(r!.signal_word, "不对");
	});

	test("user 正常内容不命中", () => {
		assert.equal(words.detectTurn("user", "请帮我查看进度"), null);
	});

	test("assistant 转述前缀命中", () => {
		const r = words.detectTurn("assistant", "用户反馈：雨声太大了");
		assert.ok(r);
		assert.equal(r!.from, "assistant_transcript");
		assert.equal(r!.signal_word, "太大");
	});

	test("assistant 转述前缀（引号分隔）命中", () => {
		// 真实数据 08-05 turn_0021 格式：用户反馈"雨声太大了"
		const r = words.detectTurn("assistant", "用户反馈\"楼层内的雨声还是太大了\"");
		assert.ok(r);
		assert.equal(r!.from, "assistant_transcript");
		assert.equal(r!.signal_word, "太大");
	});

	test("assistant 转述前缀（全角引号分隔）命中", () => {
		const r = words.detectTurn("assistant", "用户反馈“雨声太大了”");
		assert.ok(r);
		assert.equal(r!.from, "assistant_transcript");
		assert.equal(r!.signal_word, "太大");
	});

	test("assistant 转述前缀（无分隔符直接接文字）命中", () => {
		// 真实数据 07-14 turn_0018 格式：用户反馈对话功能不可用
		// 注意：此句不含纠错词，不会命中 implicit_reject，但前缀应被识别
		// 用含纠错词的例子验证
		const r = words.detectTurn("assistant", "用户反馈对话速度太快了");
		assert.ok(r);
		assert.equal(r!.from, "assistant_transcript");
		assert.equal(r!.signal_word, "太快");
	});

	test("assistant 转述前缀（无分隔符）但无纠错词不命中", () => {
		// 07-14 turn_0018「用户反馈对话功能不可用」——前缀识别但无纠错词，不命中
		assert.equal(words.detectTurn("assistant", "用户反馈对话功能不可用"), null);
	});

	test("assistant 无转述前缀不命中（误报过滤）", () => {
		assert.equal(words.detectTurn("assistant", "混响不对"), null);
	});

	test("assistant 技术描述含纠错词但无转述前缀仍被过滤", () => {
		// 真实场景误报测试：08-05「楼层场景 audio_zone 混响不对」是 AI 描述配置错误
		assert.equal(words.detectTurn("assistant", "楼层场景 audio_zone 混响不对，需要调整"), null);
	});

	test("assistant 转述前缀但无纠错词不命中", () => {
		assert.equal(words.detectTurn("assistant", "用户反馈：这个设计很好"), null);
	});

	test("user_text 超过 200 字符被截断", () => {
		const long = "不对" + "x".repeat(300);
		const r = words.detectTurn("user", long);
		assert.ok(r);
		assert.ok(r!.user_text.length <= 201); // 200 + 省略号
	});
});

// ============================================================
// backfill 历史回填
// ============================================================

describe("backfill", () => {
	test("backfill 处理历史 turn（游标重置为 0）", () => {
		raw.appendTurn("2026-08-07", "user", "历史不对", undefined);
		// 不 initCursors，直接 backfill
		watcher.backfill();
		assert.equal(behaviorByType("implicit_reject").length, 1);
	});

	test("backfill 处理多日历史", () => {
		raw.appendTurn("2026-08-06", "user", "这个错了", undefined);
		raw.appendTurn("2026-08-07", "user", "重新做", undefined);
		watcher.backfill();
		assert.equal(behaviorByType("implicit_reject").length, 2);
	});
});

// ============================================================
// 兼容性
// ============================================================

describe("兼容性", () => {
	test("flushChannel2 不写 memory/raw（观测后 memory/raw 无新增）", () => {
		raw.appendTurn("2026-08-07", "user", "不对", undefined);
		const beforeSize = fs.statSync(
			path.join(tempRoot, "memory/raw/2026-08-07/turns.jsonl"),
		).size;
		watcher.flushChannel2();
		const afterSize = fs.statSync(
			path.join(tempRoot, "memory/raw/2026-08-07/turns.jsonl"),
		).size;
		assert.equal(beforeSize, afterSize);
	});

	test("信号写入 memory/signals/behavior.jsonl（非其他位置）", () => {
		raw.appendTurn("2026-08-07", "user", "不对", undefined);
		watcher.flushChannel2();
		assert.ok(fs.existsSync(path.join(tempRoot, "memory/signals/behavior.jsonl")));
	});

	test("日志写入 logs/watcher.log", () => {
		watcher.initCursors();
		assert.ok(fs.existsSync(path.join(tempRoot, "logs/watcher.log")));
	});
});
