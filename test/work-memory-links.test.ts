import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SearchResultItem, SearchResults } from "../src/types.js";

// ============================================================
// 隔离策略与 work-memory.test.ts 一致：先 chdir 临时目录，
// 再动态加载模块（WORK_MEMORY_PATH / LINKS_PATH / fragments BASE
// 均按加载时 cwd 解析），互不污染、不触真实库。
// ============================================================
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wml-test-"));
process.chdir(tmpRoot);
const { workMemory } = await import("../src/work_memory.js");
const {
	LINKS_PATH,
	loadLinks,
	computeFingerprint,
	extractJsonObject,
	normalizeLinks,
	buildLinksAsync,
	setSpawnImpl,
	resetSpawnImpl,
} = await import("../src/work_memory_links.js");

// ---------- 测试辅助 ----------

function item(id: string, topic = "测试主题"): SearchResultItem {
	return {
		fragment_id: id,
		task_desc: `任务 ${id}`,
		result_desc: `摘要 ${id}`,
		hierarchy: { topic_name: topic },
	} as unknown as SearchResultItem;
}

function results(ids: string[]): SearchResults {
	return { results: ids.map((id) => item(id)) } as unknown as SearchResults;
}

/** 在临时 cwd 下写一个真实 fragment 文件（getFragment 可读到） */
function writeFragment(id: string): void {
	const [date, fragId] = id.split("/");
	const dir = path.join(tmpRoot, "memory", "fragments", date);
	fs.mkdirSync(dir, { recursive: true });
	const md =
		`# 任务：任务 ${id}\n\n` +
		`**日期**：${date}\n` +
		`**轮次**：turn_0001 ~ turn_0002\n` +
		`**标签**：\`test\`\n` +
		`**主题**：测试主题\n\n` +
		`## 摘要\n\n任务 ${id}\n\n` +
		`## 结论\n\n摘要 ${id}\n\n` +
		`## 原文\n\n原始对话\n`;
	fs.writeFileSync(path.join(dir, `${fragId}.md`), md, "utf8");
}

/** 写一个结论很长的 fragment（用于预算裁剪测试） */
function writeFragmentLong(id: string, resultLen = 400): void {
	const [date, fragId] = id.split("/");
	const dir = path.join(tmpRoot, "memory", "fragments", date);
	fs.mkdirSync(dir, { recursive: true });
	const longSummary = "长摘要内容".repeat(Math.ceil(resultLen / 6)).slice(0, resultLen);
	const md =
		`# 任务：任务 ${id}\n\n` +
		`**日期**：${date}\n` +
		`**轮次**：turn_0001 ~ turn_0002\n` +
		`**标签**：\`test\`\n` +
		`**主题**：测试主题\n\n` +
		`## 摘要\n\n任务 ${id}\n\n` +
		`## 结论\n\n${longSummary}\n\n` +
		`## 原文\n\n原始对话\n`;
	fs.writeFileSync(path.join(dir, `${fragId}.md`), md, "utf8");
}

/** 构造长摘要 SearchResultItem（budgetReached 测试用） */
function itemLong(id: string, resultLen = 600): SearchResultItem {
	const longSummary = "长摘要内容".repeat(Math.ceil(resultLen / 6)).slice(0, resultLen);
	return {
		fragment_id: id,
		task_desc: `任务 ${id}`,
		result_desc: longSummary,
		hierarchy: { topic_name: "测试主题" },
	} as unknown as SearchResultItem;
}

/** 写链文件（覆盖） */
function writeLinks(links: Record<string, string[]>): void {
	fs.mkdirSync(path.dirname(LINKS_PATH), { recursive: true });
	const file = {
		version: 1,
		built_at: new Date().toISOString(),
		source_fingerprint: "sha256:test",
		links,
	};
	fs.writeFileSync(LINKS_PATH, JSON.stringify(file), "utf8");
}

/** 同步触发 poll（私有方法；依赖已注入的假 search） */
function forcePoll(): Promise<void> {
	return (workMemory as unknown as { poll(): Promise<void> }).poll();
}

function readHot(): string {
	return fs.readFileSync(path.join(tmpRoot, "memory", "work_memory.md"), "utf8");
}

/** 统计某 fragment 在热文件里的出现次数 */
function countOccurrences(text: string, id: string): number {
	const re = new RegExp(`\\（${id}(?= ·|）)`, "g");
	return (text.match(re) ?? []).length;
}

// ---------- 测试 ----------

describe("work_memory 联想链（work_memory_links）", () => {
	beforeEach(() => {
		workMemory.init();
		// 清空链文件，各测试自建
		fs.rmSync(LINKS_PATH, { force: true });
	});

	after(() => {
		workMemory.init(); // 清掉 poll 定时器，避免测试进程挂住
	});

	describe("loadLinks（§12.1-1）", () => {
		test("链文件不存在 → 空数组", () => {
			assert.deepEqual(loadLinks("2026-08-05/frag_012"), []);
		});

		test("条目无出边 → 空数组", () => {
			writeLinks({ "2026-08-05/frag_012": ["2026-08-01/frag_008"] });
			assert.deepEqual(loadLinks("2026-08-01/frag_008"), []);
		});

		test("正常 → 返回出边列表", () => {
			writeLinks({
				"2026-08-05/frag_012": ["2026-08-01/frag_008", "2026-07-26/frag_005"],
			});
			assert.deepEqual(loadLinks("2026-08-05/frag_012"), [
				"2026-08-01/frag_008",
				"2026-07-26/frag_005",
			]);
		});

		test("链文件损坏（非法 JSON）→ 空数组，不抛异常", () => {
			fs.mkdirSync(path.dirname(LINKS_PATH), { recursive: true });
			fs.writeFileSync(LINKS_PATH, "{not valid json", "utf8");
			assert.deepEqual(loadLinks("2026-08-05/frag_012"), []);
		});
	});

	describe("通道⓪ 链扩散（§12.1-2 扩散 / -3 深度 / -4 去重 / -5 存在性）", () => {
		test("命中条目 → 直接邻居以 appended 形态追加", async () => {
			// 链：X → [B, C]；X 是 primary，B/C 是链上邻居
			writeLinks({ "2026-01-01/frag_X": ["2026-01-01/frag_B", "2026-01-01/frag_C"] });
			writeFragment("2026-01-01/frag_B");
			writeFragment("2026-01-01/frag_C");
			// 关掉关键词通道：searchImpl 返回空，保证 B/C 只能来自链
			workMemory.setSearchImpl(async () => results([]));
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			await forcePoll();

			const text = readHot();
			assert.equal(countOccurrences(text, "2026-01-01/frag_X"), 1); // 主体
			assert.equal(countOccurrences(text, "2026-01-01/frag_B"), 1); // 链邻居
			assert.equal(countOccurrences(text, "2026-01-01/frag_C"), 1);
		});

		test("深度=1：A→B→C 只带出 B，不递归带出 C", async () => {
			// 链：A → [B]；B → [C]。poll 时 A 是 primary：
			// 通道⓪ 遍历快照里的 A，带出 B；B 是新 push 的，不在快照里，不会被遍历 → C 不带出
			writeLinks({
				"2026-01-01/frag_A": ["2026-01-01/frag_B"],
				"2026-01-01/frag_B": ["2026-01-01/frag_C"],
			});
			writeFragment("2026-01-01/frag_B");
			writeFragment("2026-01-01/frag_C");
			workMemory.setSearchImpl(async () => results([]));
			workMemory.refresh("q", results(["2026-01-01/frag_A"]));
			await forcePoll();

			const text = readHot();
			assert.equal(countOccurrences(text, "2026-01-01/frag_A"), 1);
			assert.equal(countOccurrences(text, "2026-01-01/frag_B"), 1); // 直接邻居带出
			assert.equal(countOccurrences(text, "2026-01-01/frag_C"), 0); // 不递归
		});

		test("去重复用：邻居已在 entries → 不重复追加", async () => {
			// X → [B]；B 已通过关键词通道成为 appended 之后，链通道不应重复追加。
			// 这里直接构造：X primary，B 已作为 primary（同次 refresh 带两个 primary），
			// 链仍指向 B → 不重复。
			writeLinks({ "2026-01-01/frag_X": ["2026-01-01/frag_B"] });
			writeFragment("2026-01-01/frag_B");
			workMemory.setSearchImpl(async () => results([]));
			workMemory.refresh("q", results(["2026-01-01/frag_X", "2026-01-01/frag_B"]));
			await forcePoll();

			const text = readHot();
			assert.equal(countOccurrences(text, "2026-01-01/frag_B"), 1); // 只有一份
		});

		test("存在性校验：链指向不存在的 fragment → 跳过，不抛异常", async () => {
			writeLinks({
				"2026-01-01/frag_X": ["2026-01-01/frag_B", "2026-01-01/frag_GONE"],
			});
			writeFragment("2026-01-01/frag_B"); // 只写 B；GONE 不写
			workMemory.setSearchImpl(async () => results([]));
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			await forcePoll();

			const text = readHot();
			assert.equal(countOccurrences(text, "2026-01-01/frag_X"), 1);
			assert.equal(countOccurrences(text, "2026-01-01/frag_B"), 1); // 存在的带出
			assert.equal(countOccurrences(text, "2026-01-01/frag_GONE"), 0); // 不存在的跳过
		});

		test("预算裁剪（§12.1-6）：链扩散超预算 → 停止，appended 不超 APPENDED_BUDGET", async () => {
			// 40 个链邻居、每条 summary ~400 字符 → 追加 ~20 条就超 10240 预算，必须中途停止
			const neighbors: string[] = [];
			const links: Record<string, string[]> = {};
			for (let i = 0; i < 40; i++) {
				const nid = `2026-01-01/frag_N${String(i).padStart(2, "0")}`;
				neighbors.push(nid);
				writeFragmentLong(nid);
			}
			links["2026-01-01/frag_X"] = neighbors;
			writeLinks(links);
			workMemory.setSearchImpl(async () => results([]));
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			await forcePoll();

			const appendedChars = (workMemory as unknown as { appendedChars(): number }).appendedChars();
			assert.ok(appendedChars <= 10240, `appended ${appendedChars} 字符不应超预算 10240`);
			const text = readHot();
			const appendedCount = neighbors.filter((n) => text.includes(`（${n}`)).length;
			assert.ok(appendedCount > 0, "至少追加了一部分邻居");
			assert.ok(appendedCount < 40, `40 个邻居应被预算裁剪（实际追加 ${appendedCount}）`);
		});

		test("顺序：链扩散先于关键词检索", async () => {
			writeLinks({ "2026-01-01/frag_X": ["2026-01-01/frag_B"] });
			writeFragment("2026-01-01/frag_B");
			const order: string[] = [];
			workMemory.setSearchImpl(async () => {
				order.push("keyword");
				return results(["2026-01-01/frag_C"]);
			});
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			await forcePoll();

			// 链邻居 B 已追加后，关键词通道才跑（通过热文件内容间接验证顺序：
			// poll 结束后热文件同时有 B 和 C，且 B 在 C 前面——链先扩散）
			const text = readHot();
			const bIdx = text.indexOf("（2026-01-01/frag_B");
			const cIdx = text.indexOf("（2026-01-01/frag_C");
			assert.ok(bIdx !== -1 && cIdx !== -1, "B 和 C 都应在热文件里");
			assert.ok(bIdx < cIdx, "链邻居 B 应在关键词结果 C 之前（通道⓪ 先于通道①）");
			// keywords = [query, ...topics]（此处 2 个），一次 poll 调 2 次 searchImpl，仅验证被调用过
			assert.equal(order.length, 2);
		});
	});
});

// ============================================================
// 阶段二：headless 异步建链（纯函数 + 假 spawn）
// ============================================================

/** 假 spawn：可编程 stdout/stderr/exit code；记录调用次数与最后一次调用 */
function fakeSpawn(stdoutText: string, exitCode: number, stderrText = "") {
	let calls = 0;
	let captured: { command: string; args: string[]; options: { cwd: string } } | null = null;
	setSpawnImpl((command, args, options) => {
		calls++;
		captured = { command, args, options };
		return {
			stdout: {
				on(event: string, cb: (d: Buffer) => void) {
					if (event === "data") queueMicrotask(() => cb(Buffer.from(stdoutText, "utf8")));
					return { on() {} };
				},
			},
			stderr: {
				on(event: string, cb: (d: Buffer) => void) {
					if (event === "data" && stderrText) queueMicrotask(() => cb(Buffer.from(stderrText, "utf8")));
					return { on() {} };
				},
			},
			on(event: string, cb: (code: number | null) => void) {
				if (event === "close") queueMicrotask(() => cb(exitCode));
				return { on() {} };
			},
		};
	});
	return {
		get captured() {
			return captured;
		},
		get calls() {
			return calls;
		},
	};
}

const SAMPLE_ENTRIES = [
	{ fragment_id: "2026-01-01/frag_A", title: "任务 A", summary: "摘要 A", topic: "主题" },
	{ fragment_id: "2026-01-01/frag_B", title: "任务 B", summary: "摘要 B", topic: "主题" },
];

describe("work_memory 联想链 · 阶段二（headless 异步建链）", () => {
	beforeEach(() => {
		workMemory.init();
		fs.rmSync(LINKS_PATH, { force: true });
	});

	after(() => {
		resetSpawnImpl();
		workMemory.init();
	});

	describe("computeFingerprint（§7.2）", () => {
		test("内容相同 → 指纹相同；顺序不同 → 指纹不同", () => {
			const a = computeFingerprint(["A", "B"]);
			const b = computeFingerprint(["A", "B"]);
			const c = computeFingerprint(["B", "A"]);
			assert.equal(a, b);
			assert.notEqual(a, c);
		});
	});

	describe("extractJsonObject（LLM stdout 容错解析）", () => {
		test("纯 JSON → 解析成功", () => {
			assert.deepEqual(extractJsonObject('{"a":["b"]}'), { a: ["b"] });
		});

		test("markdown 围栏 → 剥离后解析", () => {
			assert.deepEqual(extractJsonObject('```json\n{"a":["b"]}\n```'), { a: ["b"] });
		});

		test("LLM 多说话（前后有解释文字）→ 提取最外层 {}", () => {
			assert.deepEqual(extractJsonObject('好的，以下是结果：\n{"a":["b"]}\n希望有帮助。'), { a: ["b"] });
		});

		test("完全无 JSON → null", () => {
			assert.equal(extractJsonObject("没有任何输出"), null);
		});
	});

	describe("normalizeLinks（LLM 输出规范化）", () => {
		const validIds = new Set(["A", "B", "C"]);

		test("合法输入原样保留", () => {
			assert.deepEqual(normalizeLinks({ A: ["B"], B: ["A"] }, validIds), { A: ["B"], B: ["A"] });
		});

		test("编造的 fragment_id 被丢弃", () => {
			assert.deepEqual(normalizeLinks({ A: ["B"], FAKE: ["A"] }, validIds), { A: ["B"] });
		});

		test("非字符串值 / 自环被过滤", () => {
			assert.deepEqual(normalizeLinks({ A: ["B", 42, "A"] }, validIds), { A: ["B"] });
		});

		test("出度 >2 截断到 2", () => {
			assert.deepEqual(normalizeLinks({ A: ["B", "C", "B", "C"] }, validIds), { A: ["B", "C"] });
		});

		test("非对象输入 → null", () => {
			assert.equal(normalizeLinks("not object", validIds), null);
		});
	});

	describe("buildLinksAsync（§8.1 假 spawn 全链路）", () => {
		test("stdout 合法 JSON → 落盘带服务端元数据，ok=true", async () => {
			fakeSpawn('{"2026-01-01/frag_A":["2026-01-01/frag_B"]}', 0);
			const result = await buildLinksAsync({
				entries: SAMPLE_ENTRIES,
				fingerprint: "sha256:fp",
				cwd: tmpRoot,
				workMemoryPath: path.join(tmpRoot, "memory", "work_memory.md"),
			});
			assert.equal(result.ok, true);
			assert.equal(result.linksCount, 1);

			const file = JSON.parse(fs.readFileSync(LINKS_PATH, "utf8"));
			assert.equal(file.version, 1);
			assert.equal(file.source_fingerprint, "sha256:fp"); // 服务端补的指纹
			assert.ok(typeof file.built_at === "string" && file.built_at.length > 0);
			assert.deepEqual(file.links, { "2026-01-01/frag_A": ["2026-01-01/frag_B"] });
		});

		test("exit != 0 → ok=false，不落盘", async () => {
			fakeSpawn("", 1, "boom");
			const result = await buildLinksAsync({
				entries: SAMPLE_ENTRIES,
				fingerprint: "sha256:fp",
				cwd: tmpRoot,
				workMemoryPath: path.join(tmpRoot, "memory", "work_memory.md"),
			});
			assert.equal(result.ok, false);
			assert.ok(!fs.existsSync(LINKS_PATH), "失败不应落盘");
		});

		test("stdout 无合法 JSON → ok=false，不落盘", async () => {
			fakeSpawn("今天天气不错，不给你 JSON", 0);
			const result = await buildLinksAsync({
				entries: SAMPLE_ENTRIES,
				fingerprint: "sha256:fp",
				cwd: tmpRoot,
				workMemoryPath: path.join(tmpRoot, "memory", "work_memory.md"),
			});
			assert.equal(result.ok, false);
			assert.ok(!fs.existsSync(LINKS_PATH));
		});

		test("LLM 多说话但含 JSON → 容错提取后落盘", async () => {
			fakeSpawn('分析完成。\n```json\n{"2026-01-01/frag_A":["2026-01-01/frag_B"]}\n```\n以上。', 0);
			const result = await buildLinksAsync({
				entries: SAMPLE_ENTRIES,
				fingerprint: "sha256:fp",
				cwd: tmpRoot,
				workMemoryPath: path.join(tmpRoot, "memory", "work_memory.md"),
			});
			assert.equal(result.ok, true);
			assert.deepEqual(
				JSON.parse(fs.readFileSync(LINKS_PATH, "utf8")).links,
				{ "2026-01-01/frag_A": ["2026-01-01/frag_B"] },
			);
		});

		test("任务文本包含锁定版本参数与条目内嵌", async () => {
			const fake = fakeSpawn("{}", 0);
			await buildLinksAsync({
				entries: SAMPLE_ENTRIES,
				fingerprint: "sha256:fp",
				cwd: tmpRoot,
				workMemoryPath: path.join(tmpRoot, "memory", "work_memory.md"),
			});
			const cap = fake.captured!;
			// npx 锁版本（Windows npx.cmd；测试环境 win32）
			if (process.env.MEMORY_DSH_BIN) {
				assert.equal(cap.command, process.execPath);
				assert.equal(cap.args[0], process.env.MEMORY_DSH_BIN);
			} else {
				assert.match(cap.command, /npx/);
				assert.match(cap.args.join(" "), /@deepseek-ai\/dsh@0\.1\.0-rc\.6/);
			}
			assert.equal(cap.args[1], "--profile");
			assert.equal(cap.args[2], "headless");
			assert.equal(cap.options.cwd, tmpRoot);
			assert.match(cap.args[3], /2026-01-01\/frag_A/); // 任务文本内嵌条目
		});
	});

	describe("maybeTriggerLinkBuild（§7 触发与防重，集成）", () => {
		/** 访问私有方法 */
		function triggerBuild(): void {
			(workMemory as unknown as { maybeTriggerLinkBuild(): void }).maybeTriggerLinkBuild();
		}
		function linkInFlight(): boolean {
			return (workMemory as unknown as { linkBuildInFlight: boolean }).linkBuildInFlight;
		}

		test("有条目 + 无链文件 → 触发 spawn", async () => {
			const fake = fakeSpawn("{}", 0);
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			triggerBuild();
			assert.ok(fake.captured !== null, "应触发 headless spawn");
			// 等微任务完成落盘，再复位进行中标志
			await new Promise((r) => setTimeout(r, 10));
			assert.equal(linkInFlight(), false);
		});

		test("链文件指纹与当前一致 → 不触发", async () => {
			const fake = fakeSpawn("{}", 0);
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			// 先写入与当前条目集合一致的链文件
			const ids = ["2026-01-01/frag_X"];
			fs.mkdirSync(path.dirname(LINKS_PATH), { recursive: true });
			fs.writeFileSync(
				LINKS_PATH,
				JSON.stringify({ version: 1, built_at: "x", source_fingerprint: computeFingerprint(ids), links: {} }),
				"utf8",
			);
			triggerBuild();
			assert.equal(fake.captured, null, "指纹一致，不应触发");
		});

		test("建链进行中 → 不重复触发", async () => {
			const fake = fakeSpawn("{}", 0);
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			triggerBuild();
			assert.equal(fake.calls, 1);
			// 未等 close（进行中标志仍 true），再触发 → 不重复 spawn
			triggerBuild();
			assert.equal(fake.calls, 1, "进行中不应重复触发");
		});

		test("追加触顶 → schedule 触发建链（budgetReached 信号，§7.1 修复）", async () => {
			// 修复背景：trimToBudget 裁剪条件（> 预算）与 schedule 停轮询条件（>= 预算）
			// 之间存在缝隙——追加超线 → trim 裁回线内 → appendedChars 永远 < 预算 →
			// 「存满」几乎不可达。以「追加后曾触顶」budgetReached 信号代替。
			const fake = fakeSpawn("{}", 0);
			// 25 条长摘要（每条 ~600 字符渲染）→ 追加过程必然越过 10240 预算线
			const neighbors: string[] = [];
			for (let i = 0; i < 25; i++) {
				const nid = `2026-01-01/frag_N${String(i).padStart(2, "0")}`;
				neighbors.push(nid);
				writeFragmentLong(nid);
			}
			workMemory.setSearchImpl(async () =>
				({ results: neighbors.map((id) => itemLong(id, 600)) }) as unknown as SearchResults,
			);
			workMemory.refresh("q", results(["2026-01-01/frag_X"]));
			// 清 timer 模拟真实 timer 触发后的状态，再手动 poll（poll 末尾 schedule 会检查 budgetReached）
			(workMemory as unknown as { stop(): void }).stop();
			await forcePoll();
			// poll 追加触顶 → budgetReached=true → schedule → maybeTriggerLinkBuild → spawn
			assert.equal(fake.calls, 1, "触顶应触发一次建链");
			// 等待微任务落盘完成
			await new Promise((r) => setTimeout(r, 20));
			assert.ok(fs.existsSync(LINKS_PATH), "链文件应已落盘");
			const file = JSON.parse(fs.readFileSync(LINKS_PATH, "utf8"));
			assert.ok(file.source_fingerprint.startsWith("sha256:"), "服务端补齐内容指纹");
		});
	});
});
