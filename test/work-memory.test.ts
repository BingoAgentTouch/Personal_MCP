import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SearchResultItem, SearchResults } from "../src/types.js";

// 隔离：先切到临时 cwd，再动态加载 work_memory（其 WORK_MEMORY_PATH 按加载时 cwd 解析）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wm-test-"));
process.chdir(tmpRoot);
const { workMemory } = await import("../src/work_memory.js");

function item(id: string, topic = "测试主题"): SearchResultItem {
	return {
		fragment_id: id,
		task_desc: `任务 ${id}`,
		result_desc: `摘要 ${id}`,
		hierarchy: { topic_name: topic },
	} as unknown as SearchResultItem;
}

// 注意：必须包一层 (id) => item(id)，直接 map(item) 会把 index 当 topic 参数传入
function results(ids: string[]): SearchResults {
	return { results: ids.map((id) => item(id)) } as unknown as SearchResults;
}

/** 同步触发 poll（私有方法；依赖已注入的假 search） */
function forcePoll(): Promise<void> {
	return (workMemory as unknown as { poll(): Promise<void> }).poll();
}

function readHot(): string {
	return fs.readFileSync(path.join(tmpRoot, "memory", "work_memory.md"), "utf8");
}

/** 统计某 fragment 在热文件里的出现次数（渲染格式可能是 （A） 或 （A · 主体）） */
function countOccurrences(text: string, id: string): number {
	const re = new RegExp(`\\（${id}(?= ·|）)`, "g");
	return (text.match(re) ?? []).length;
}

describe("work_memory 去重", () => {
	beforeEach(() => {
		// init = 停轮询 + 清空 entries + 重写热文件（写到临时 cwd，不污染真实库）
		workMemory.init();
	});

	after(() => {
		workMemory.init(); // 清掉 poll 定时器，避免测试进程挂住
	});

	test("search 结果内重复 id 只保留第一次（防御性）", () => {
		workMemory.refresh("q", results(["A", "A", "B"]));
		const text = readHot();
		assert.equal(countOccurrences(text, "A"), 1);
		assert.equal(countOccurrences(text, "B"), 1);
	});

	test("appended 已含 A，search 又命中 A → 只保留主体一份，其余 appended 保留", async () => {
		// ① poll 追加 B/C/A 进 appended（primary = X）
		workMemory.setSearchImpl(async () => results(["B", "C", "A"]));
		workMemory.refresh("q1", results(["X"]));
		await forcePoll();
		let text = readHot();
		assert.equal(countOccurrences(text, "A"), 1); // appended 的 A
		// ② search 命中 A：A 升为主体，appended 排除 A 避免双份
		workMemory.refresh("q2", results(["A", "D"]));
		text = readHot();
		assert.equal(countOccurrences(text, "A"), 1); // 只留主体一份
		const aLine = text.split("\n").find((l) => l.includes("（A"));
		assert.ok(aLine?.includes("主体"), "A 应为主体条目");
		assert.equal(countOccurrences(text, "B"), 1); // 其余 appended 保留
		assert.equal(countOccurrences(text, "C"), 1);
		assert.equal(countOccurrences(text, "D"), 1); // 新 primary
		assert.equal(countOccurrences(text, "X"), 0); // 旧 primary 被整体替换
	});

	test("不与 primary 冲突的 appended 原样保留（不误杀）", async () => {
		workMemory.setSearchImpl(async () => results(["A", "C"]));
		workMemory.refresh("q1", results(["X"]));
		await forcePoll(); // appended += A、C
		workMemory.refresh("q2", results(["D"]));
		const text = readHot();
		assert.equal(countOccurrences(text, "D"), 1); // 新 primary
		assert.equal(countOccurrences(text, "A"), 1); // appended 保留
		assert.equal(countOccurrences(text, "C"), 1);
		assert.equal(countOccurrences(text, "X"), 0); // 旧 primary 被替换
	});
});
