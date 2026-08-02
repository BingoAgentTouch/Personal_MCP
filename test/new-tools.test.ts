import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-new-tools-"));
process.chdir(tempRoot);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const raw = await import(pathToFileURL(path.join(sourceRoot, "storage/raw.ts")).href);
const fragments = await import(pathToFileURL(path.join(sourceRoot, "storage/fragments.ts")).href);
const topics = await import(pathToFileURL(path.join(sourceRoot, "storage/topics.ts")).href);
const handlers = await import(pathToFileURL(path.join(sourceRoot, "mcp/handlers.ts")).href);

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("memory_get_raw_turns", () => {
	test("supports exact, range, recent, and all queries", async () => {
		raw.appendTurn("2026-08-01", "user", "先提出问题");
		raw.appendTurn("2026-08-01", "assistant", "再给出回答");
		raw.appendTurn("2026-08-01", "user", "最后补充信息");

		const exact = await handlers.handleGetRawTurns({ date: "2026-08-01", turn_id: "turn_0002" });
		assert.equal(exact.isError, undefined);
		assert.match(exact.content[0].text, /再给出回答/);
		assert.doesNotMatch(exact.content[0].text, /先提出问题/);

		const range = await handlers.handleGetRawTurns({
			date: "2026-08-01",
			turn_start: "turn_0001",
			turn_end: "turn_0002",
		});
		assert.match(range.content[0].text, /先提出问题/);
		assert.match(range.content[0].text, /再给出回答/);
		assert.doesNotMatch(range.content[0].text, /最后补充信息/);

		const recent = await handlers.handleGetRawTurns({ date: "2026-08-01", limit: 2 });
		assert.doesNotMatch(recent.content[0].text, /先提出问题/);
		assert.match(recent.content[0].text, /再给出回答/);
		assert.match(recent.content[0].text, /最后补充信息/);

		const all = await handlers.handleGetRawTurns({ date: "2026-08-01" });
		assert.match(all.content[0].text, /先提出问题/);
		assert.match(all.content[0].text, /最后补充信息/);

		const oversized = await handlers.handleGetRawTurns({ date: "2026-08-01", limit: 10 });
		assert.equal(oversized.isError, undefined);
		assert.match(oversized.content[0].text, /先提出问题/);
	});

	test("rejects invalid limits without leaking the full transcript", async () => {
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const response = await handlers.handleGetRawTurns({ date: "2026-08-01", limit });
			assert.equal(response.isError, true, `limit ${String(limit)} should fail`);
			assert.doesNotMatch(response.content[0].text, /先提出问题|再给出回答|最后补充信息/);
		}
	});

	test("rejects conflicting or incomplete query parameters", async () => {
		const invalidInputs = [
			{ date: "2026-08-01", turn_start: "turn_0001" },
			{ date: "2026-08-01", turn_end: "turn_0002" },
			{ date: "2026-08-01", turn_id: "turn_0001", limit: 1 },
			{ date: "2026-08-01", turn_id: "turn_0001", turn_start: "turn_0001", turn_end: "turn_0002" },
			{ date: "2026-08-01", turn_start: "turn_0001", turn_end: "turn_0002", limit: 1 },
		];
		for (const input of invalidInputs) {
			const response = await handlers.handleGetRawTurns(input);
			assert.equal(response.isError, true);
			assert.doesNotMatch(response.content[0].text, /先提出问题|再给出回答|最后补充信息/);
		}
	});

	test("reports missing exact IDs and invalid ranges directly", async () => {
		const missingExact = await handlers.handleGetRawTurns({ date: "2026-08-01", turn_id: "turn_9999" });
		assert.equal(missingExact.isError, true);
		assert.match(missingExact.content[0].text, /轮次不存在/);
		assert.doesNotMatch(missingExact.content[0].text, /先提出问题|再给出回答|最后补充信息/);

		for (const input of [
			{ date: "2026-08-01", turn_start: "turn_9999", turn_end: "turn_0002" },
			{ date: "2026-08-01", turn_start: "turn_0002", turn_end: "turn_0001" },
		]) {
			const response = await handlers.handleGetRawTurns(input);
			assert.equal(response.isError, true);
			assert.match(response.content[0].text, /轮次范围无效/);
			assert.doesNotMatch(response.content[0].text, /先提出问题|再给出回答|最后补充信息/);
		}
	});

	test("filters every query mode by agent_id before selecting turns", async () => {
		raw.appendTurn("2026-08-04", "user", "A 的第一轮", "agent-a");
		raw.appendTurn("2026-08-04", "assistant", "B 的第一轮", "agent-b");
		raw.appendTurn("2026-08-04", "user", "无 agent 的历史轮次");
		raw.appendTurn("2026-08-04", "assistant", "A 的第二轮", "agent-a");

		const allA = await handlers.handleGetRawTurns({ date: "2026-08-04", agent_id: "agent-a" });
		assert.match(allA.content[0].text, /A 的第一轮/);
		assert.match(allA.content[0].text, /A 的第二轮/);
		assert.doesNotMatch(allA.content[0].text, /B 的第一轮|无 agent 的历史轮次/);

		const exactA = await handlers.handleGetRawTurns({ date: "2026-08-04", turn_id: "turn_0004", agent_id: "agent-a" });
		assert.match(exactA.content[0].text, /A 的第二轮/);
		const exactOtherAgent = await handlers.handleGetRawTurns({ date: "2026-08-04", turn_id: "turn_0002", agent_id: "agent-a" });
		assert.equal(exactOtherAgent.isError, true);
		assert.doesNotMatch(exactOtherAgent.content[0].text, /B 的第一轮/);

		const rangeA = await handlers.handleGetRawTurns({
			date: "2026-08-04",
			turn_start: "turn_0001",
			turn_end: "turn_0004",
			agent_id: "agent-a",
		});
		assert.match(rangeA.content[0].text, /A 的第一轮/);
		assert.match(rangeA.content[0].text, /A 的第二轮/);
		assert.doesNotMatch(rangeA.content[0].text, /B 的第一轮|无 agent 的历史轮次/);

		const recentA = await handlers.handleGetRawTurns({ date: "2026-08-04", limit: 1, agent_id: "agent-a" });
		assert.match(recentA.content[0].text, /A 的第二轮/);
		assert.doesNotMatch(recentA.content[0].text, /A 的第一轮/);

		const noAgent = await handlers.handleGetRawTurns({ date: "2026-08-04" });
		assert.match(noAgent.content[0].text, /无 agent 的历史轮次/);

		const missingAgent = await handlers.handleGetRawTurns({ date: "2026-08-04", agent_id: "agent-missing" });
		assert.equal(missingAgent.isError, true);
		assert.doesNotMatch(missingAgent.content[0].text, /A 的第一轮|B 的第一轮|无 agent 的历史轮次/);
	});

	test("returns readable transcript while preserving raw content", async () => {
		raw.appendTurn("2026-08-05", "user", "第一行\n**Markdown**\n含\"引号\"", "agent-transcript");
		raw.appendTurn("2026-08-05", "assistant", "回答内容", "agent-transcript");
		const response = await handlers.handleGetRawTurns({ date: "2026-08-05", agent_id: "agent-transcript" });
		const text = response.content[0].text;
		assert.match(text, /# 原始对话轮次（2026-08-05）/);
		assert.match(text, /## turn_0001 · 用户/);
		assert.match(text, /## turn_0002 · AI/);
		assert.match(text, /时间：/);
		assert.match(text, /Agent：agent-transcript/);
		assert.match(text, /第一行\n\*\*Markdown\*\*\n含"引号"/);
		assert.doesNotMatch(text, /\\n|\\"/);

		raw.appendTurn("2026-08-05", "user", "没有 agent 行");
		const noAgent = await handlers.handleGetRawTurns({ date: "2026-08-05", turn_id: "turn_0003" });
		assert.doesNotMatch(noAgent.content[0].text, /Agent：/);
	});
});

describe("memory_consolidate_topics", () => {
	test("parses fragment IDs, deduplicates entries, updates fragments, and counts new entries", () => {
		raw.appendTurn("2026-08-02", "user", "目标主题问题");
		raw.appendTurn("2026-08-02", "assistant", "目标主题回答");
		raw.appendTurn("2026-08-03", "user", "来源主题问题");
		raw.appendTurn("2026-08-03", "assistant", "来源主题回答");

		const targetFragment = fragments.createFragment({
			date: "2026-08-02",
			start_turn_id: "turn_0001",
			end_turn_id: "turn_0002",
			task_desc: "目标任务",
			result_desc: "目标结论",
			tags: [],
			topic_name: "目标主题",
		});
		const sourceFragment = fragments.createFragment({
			date: "2026-08-03",
			start_turn_id: "turn_0001",
			end_turn_id: "turn_0002",
			task_desc: "来源任务",
			result_desc: "来源结论",
			tags: [],
			topic_name: "来源主题",
		});

		topics.upsertTopic("目标主题", "2026-08-02", targetFragment.fragment_id, "目标摘要");
		topics.upsertTopic("来源主题", "2026-08-03", sourceFragment.fragment_id, "来源摘要");
		const sourceBefore = topics.getTopic("来源主题");
		assert.equal(sourceBefore?.entries[0].fragment_id, sourceFragment.fragment_id);

		const result = topics.mergeTopics(
			"目标主题",
			["来源主题"],
			path.resolve("memory/fragments"),
		);
		assert.deepEqual(result.errors, []);
		assert.equal(result.new_entries_count, 1);
		assert.equal(result.fragments_updated, 1);

		const merged = topics.getTopic("目标主题");
		assert.equal(merged?.entries.length, 2);
		assert.equal(topics.getTopic("来源主题"), null);
		assert.match(fragments.getFragmentRaw(sourceFragment.fragment_id) ?? "", /\*\*主题\*\*：目标主题/);

		const trashFiles = fs.readdirSync(path.resolve("memory/topics/.trash"));
		assert.equal(trashFiles.length, 1);
		assert.match(trashFiles[0], /^来源主题-\d+\.md\.bak$/);
	});

	test("returns typed errors and error status when a merge cannot complete", async () => {
		const response = await handlers.handleConsolidateTopics({
			action: "execute",
			merges: [{ target: "不存在的目标", sources: ["来源主题"] }],
		});
		const payload = JSON.parse(response.content[0].text);
		assert.equal(response.isError, true);
		assert.equal(payload.merged[0].status, "error");
		assert.equal(payload.errors[0].group_index, 0);
		assert.equal(typeof payload.errors[0].error, "string");
		assert.equal("errors" in payload.errors[0], false);
	});
});
