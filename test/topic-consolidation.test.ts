import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-topic-consolidation-"));
process.chdir(tempRoot);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topics = await import(pathToFileURL(path.join(projectRoot, "src/storage/topics.ts")).href);
const handlers = await import(pathToFileURL(path.join(projectRoot, "src/mcp/handlers.ts")).href);

const topicsDir = path.join(tempRoot, "memory/topics");
const fragmentsDir = path.join(tempRoot, "memory/fragments");

beforeEach(() => {
	fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	fs.mkdirSync(topicsDir, { recursive: true });
	fs.mkdirSync(fragmentsDir, { recursive: true });
});

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function createTopic(name: string, fragmentId: string, summary = `${name} 摘要`): void {
	const [date] = fragmentId.split("/");
	topics.upsertTopic(name, date, fragmentId, summary);
}

function createFragment(fragmentId: string, topicName: string, body = "fragment 内容"): void {
	const [date, id] = fragmentId.split("/");
	const dir = path.join(fragmentsDir, date);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${id}.md`),
		`# 任务：${body}\n\n**主题**：${topicName}\n\n${body}\n`,
		"utf-8",
	);
}

function responsePayload(response: { content: Array<{ text: string }> }): any {
	return JSON.parse(response.content[0].text);
}

function snapshot(root: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!fs.existsSync(root)) return result;
	const visit = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) visit(full);
			else result.set(path.relative(root, full), fs.readFileSync(full, "utf-8"));
		}
	};
	visit(root);
	return result;
}

function assertSnapshotsEqual(before: Map<string, string>, after: Map<string, string>): void {
	assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
}

describe("Topic consolidation Stage 4", () => {
	test("T4-01: dry-run returns a validated plan without changing files", async () => {
		createTopic("目标主题", "2026-08-01/frag_001");
		createTopic("来源主题", "2026-08-02/frag_002");
		createFragment("2026-08-02/frag_002", "来源主题");
		const before = snapshot(path.join(tempRoot, "memory"));

		const payload = responsePayload(await handlers.handleConsolidateTopics({
			action: "execute",
			dry_run: true,
			merges: [{ target: "目标主题", sources: ["来源主题"] }],
		}));

		assert.equal(payload.dry_run, true);
		assert.equal(payload.validated, true);
		assert.deepEqual(payload.changes.topics_to_update, ["目标主题"]);
		assert.deepEqual(payload.changes.topics_to_remove, ["来源主题"]);
		assert.deepEqual(payload.changes.fragments_to_update, ["2026-08-02/frag_002"]);
		assert.equal(payload.changes.backups_to_create, 1);
		assert.equal(payload.merged[0].new_entries_count, 1);
		assert.equal(payload.merged[0].fragments_updated, 1);
		assertSnapshotsEqual(before, snapshot(path.join(tempRoot, "memory")));
		assert.ok(fs.existsSync(topics.resolveTopicPath("来源主题")));
	});

	test("T4-02/T4-15: execute applies the same plan statistics as dry-run", async () => {
		createTopic("目标主题", "2026-08-01/frag_001");
		createTopic("来源主题", "2026-08-02/frag_002");
		createFragment("2026-08-02/frag_002", "来源主题");
		const request = { action: "execute" as const, merges: [{ target: "目标主题", sources: ["来源主题"] }] };
		const dryRun = responsePayload(await handlers.handleConsolidateTopics({ ...request, dry_run: true }));
		const executed = responsePayload(await handlers.handleConsolidateTopics(request));

		assert.equal(executed.validated, true);
		assert.equal(executed.dry_run, false);
		assert.equal(executed.merged[0].new_entries_count, dryRun.merged[0].new_entries_count);
		assert.equal(executed.merged[0].fragments_updated, dryRun.merged[0].fragments_updated);
		assert.deepEqual(executed.changes, dryRun.changes);
		assert.equal(topics.getTopic("来源主题"), null);
		assert.match(fs.readFileSync(path.join(fragmentsDir, "2026-08-02/frag_002.md"), "utf-8"), /\*\*主题\*\*：目标主题/);
		assert.equal(fs.readdirSync(path.join(topicsDir, ".trash")).length, 1);
	});

	test("T4-03: any invalid group prevents writes to an otherwise valid group", async () => {
		createTopic("目标一", "2026-08-01/frag_001");
		createTopic("来源一", "2026-08-02/frag_002");
		createFragment("2026-08-02/frag_002", "来源一");
		createTopic("目标二", "2026-08-03/frag_003");
		const before = snapshot(path.join(tempRoot, "memory"));

		const payload = responsePayload(await handlers.handleConsolidateTopics({
			action: "execute",
			merges: [
				{ target: "目标一", sources: ["来源一"] },
				{ target: "目标二", sources: ["不存在的来源"] },
			],
		}));

		assert.equal(payload.validated, false);
		assert.equal(payload.merged[0].status, "error");
		assert.ok(payload.errors.some((error: any) => error.group_index === 1));
		assertSnapshotsEqual(before, snapshot(path.join(tempRoot, "memory")));
		assert.ok(fs.existsSync(topics.resolveTopicPath("来源一")));
	});

	test("T4-04/T4-05: target and source list must be valid and unambiguous", async () => {
		createTopic("目标主题", "2026-08-01/frag_001");
		createTopic("来源主题", "2026-08-02/frag_002");
		createFragment("2026-08-02/frag_002", "来源主题");
		const before = snapshot(path.join(tempRoot, "memory"));
		const cases = [
			{ target: "不存在的目标", sources: ["来源主题"] },
			{ target: "目标主题", sources: [] },
			{ target: "目标主题", sources: ["目标主题"] },
			{ target: "目标主题", sources: ["来源主题", "来源主题"] },
		];

		for (const merge of cases) {
			const payload = responsePayload(await handlers.handleConsolidateTopics({ action: "execute", merges: [merge] }));
			assert.equal(payload.validated, false);
			assert.equal(payload.merged[0].status, "error");
		}
		assertSnapshotsEqual(before, snapshot(path.join(tempRoot, "memory")));
	});

	test("T4-06/T4-07/T4-08: active groups reject cross-group source and target conflicts", async () => {
		const conflictCases = [
			{
				merges: [
					{ target: "目标一", sources: ["来源一"] },
					{ target: "目标二", sources: ["来源一"] },
				],
				entries: [["目标一", "2026-08-01/frag_001"], ["目标二", "2026-08-02/frag_002"], ["来源一", "2026-08-03/frag_003"]],
			},
			{
				merges: [
					{ target: "目标一", sources: ["目标二"] },
					{ target: "目标三", sources: ["目标一"] },
				],
				entries: [["目标一", "2026-08-04/frag_004"], ["目标二", "2026-08-05/frag_005"], ["目标三", "2026-08-06/frag_006"]],
			},
			{
				merges: [
					{ target: "目标一", sources: ["来源一"] },
					{ target: "目标一", sources: ["来源二"] },
				],
				entries: [["目标一", "2026-08-07/frag_007"], ["来源一", "2026-08-08/frag_008"], ["来源二", "2026-08-09/frag_009"]],
			},
		];
		for (const conflictCase of conflictCases) {
			for (const [name, id] of conflictCase.entries) {
				createTopic(name, id);
				createFragment(id, name);
			}
			const payload = responsePayload(await handlers.handleConsolidateTopics({ action: "execute", dry_run: true, merges: conflictCase.merges }));
			assert.equal(payload.validated, false);
			assert.ok(payload.errors.length > 0);
			fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
			fs.mkdirSync(topicsDir, { recursive: true });
			fs.mkdirSync(fragmentsDir, { recursive: true });
		}
	});

	test("T4-09/T4-10: missing, malformed, and escaping fragment IDs fail before writes", async () => {
		createTopic("目标主题", "2026-08-01/frag_001");
		createTopic("缺失片段主题", "2026-08-02/frag_002");
		createTopic("非法片段主题", "2026-08-03/not-a-fragment");
		const before = snapshot(path.join(tempRoot, "memory"));

		for (const source of ["缺失片段主题", "非法片段主题"]) {
			const payload = responsePayload(await handlers.handleConsolidateTopics({
				action: "execute",
				merges: [{ target: "目标主题", sources: [source] }],
			}));
			assert.equal(payload.validated, false);
		}
		assertSnapshotsEqual(before, snapshot(path.join(tempRoot, "memory")));
		assert.ok(!fs.existsSync(path.join(tempRoot, "outside")));
	});

	test("T4-11: old topic backlink must exist exactly once", async () => {
		createTopic("目标主题", "2026-08-01/frag_001");
		createTopic("缺失回指", "2026-08-02/frag_002");
		createFragment("2026-08-02/frag_002", "其他主题");
		createTopic("重复回指", "2026-08-03/frag_003");
		const duplicatePath = path.join(fragmentsDir, "2026-08-03/frag_003.md");
		createFragment("2026-08-03/frag_003", "重复回指");
		fs.appendFileSync(duplicatePath, "**主题**：重复回指\n", "utf-8");

		for (const source of ["缺失回指", "重复回指"]) {
			const payload = responsePayload(await handlers.handleConsolidateTopics({
				action: "execute",
				merges: [{ target: "目标主题", sources: [source] }],
			}));
			assert.equal(payload.validated, false);
		}
		assert.equal(fs.existsSync(topics.resolveTopicPath("缺失回指")), true);
		assert.equal(fs.existsSync(topics.resolveTopicPath("重复回指")), true);
	});

	test("T4-12: fragment update counts only actual planned replacements", async () => {
		createTopic("目标主题", "2026-08-01/frag_001");
		createTopic("来源主题", "2026-08-02/frag_002");
		createFragment("2026-08-02/frag_002", "来源主题");
		const payload = responsePayload(await handlers.handleConsolidateTopics({
			action: "execute",
			dry_run: true,
			merges: [{ target: "目标主题", sources: ["来源主题"] }],
		}));
		assert.equal(payload.merged[0].fragments_updated, 1);
		assert.deepEqual(payload.changes.fragments_to_update, ["2026-08-02/frag_002"]);
	});

	test("T4-13: new entries count deduplicates entries already in target", async () => {
		createTopic("目标主题", "2026-08-01/frag_001");
		createTopic("来源主题", "2026-08-01/frag_001", "来源重复条目");
		// The source entry is already in the target by the same date/fragment key.
		createFragment("2026-08-01/frag_001", "来源主题");
		const payload = responsePayload(await handlers.handleConsolidateTopics({
			action: "execute",
			dry_run: true,
			merges: [{ target: "目标主题", sources: ["来源主题"] }],
		}));
		assert.equal(payload.validated, true);
		assert.equal(payload.merged[0].new_entries_count, 0);
	});

	test("T4-14: skipped groups do not participate in conflicts", async () => {
		createTopic("目标一", "2026-08-01/frag_001");
		createTopic("目标二", "2026-08-02/frag_002");
		createTopic("来源主题", "2026-08-03/frag_003");
		createFragment("2026-08-03/frag_003", "来源主题");
		const payload = responsePayload(await handlers.handleConsolidateTopics({
			action: "execute",
			dry_run: true,
			merges: [
				{ target: "目标一", sources: ["来源主题"], skip: true },
				{ target: "目标二", sources: ["来源主题"] },
			],
		}));
		assert.equal(payload.validated, true);
		assert.equal(payload.skipped[0].status, "skipped");
		assert.equal(payload.merged[0].status, "ok");
	});
});
