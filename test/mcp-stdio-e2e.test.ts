import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-stdio-e2e-"));
const memoryRoot = path.join(tempRoot, "memory");
const topicsDir = path.join(memoryRoot, "topics");
const fragmentsDir = path.join(memoryRoot, "fragments");

let client: Client;
let transport: StdioClientTransport;

before(async () => {
	fs.mkdirSync(topicsDir, { recursive: true });
	fs.mkdirSync(fragmentsDir, { recursive: true });
	transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(projectRoot, "dist/index.js")],
		cwd: tempRoot,
		stderr: "pipe",
	});
	client = new Client({ name: "memory-mcp-stdio-e2e", version: "1.0.0" });
	await client.connect(transport);
});

after(async () => {
	await client?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
	const block = result.content.find((item) => item.type === "text");
	assert.ok(block && block.type === "text");
	return block.text;
}

async function call(name: string, args: Record<string, unknown> = {}) {
	return client.callTool({ name, arguments: args });
}

function writeTopic(name: string, entries: Array<{ date: string; fragmentId: string; summary: string }>): void {
	fs.mkdirSync(topicsDir, { recursive: true });
	const dates = entries.map((entry) => entry.date).sort();
	const lines = [
		`# 主题：${name}（${dates[0]} ~ ${dates[dates.length - 1]}）`,
		"",
		`**涵盖日期**：${dates.join(", ")}`,
		"**状态**：进行中",
		"",
		"## 各阶段",
		"",
		...entries.map((entry) => `- ${entry.date}：${entry.summary}（→ daily/${entry.date}.md → ${entry.fragmentId}）`),
		"",
	].join("\n");
	fs.writeFileSync(path.join(topicsDir, `${name}.md`), lines, "utf-8");
}

function writeFragment(fragmentId: string, topic: string): void {
	const [date, id] = fragmentId.split("/");
	const dir = path.join(fragmentsDir, date);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${id}.md`), `# 任务：临时库演练\n\n**主题**：${topic}\n\n正文\n`, "utf-8");
}

function snapshot(root: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	if (!fs.existsSync(root)) return files;
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else files.set(path.relative(root, fullPath), fs.readFileSync(fullPath));
		}
	};
	visit(root);
	return files;
}

function assertSnapshotEqual(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
	assert.deepEqual(
		[...actual].map(([file, bytes]) => [file, bytes.toString("base64")]).sort(),
		[...expected].map(([file, bytes]) => [file, bytes.toString("base64")]).sort(),
	);
}

describe("compiled MCP server over stdio", () => {
	test("lists the new tools with the hardened schemas", async () => {
		const listed = await client.listTools();
		const rawTool = listed.tools.find((tool) => tool.name === "memory_get_raw_turns");
		const consolidateTool = listed.tools.find((tool) => tool.name === "memory_consolidate_topics");
		assert.ok(rawTool);
		assert.ok(consolidateTool);
		assert.deepEqual(rawTool.inputSchema.properties?.limit, {
			type: "integer",
			minimum: 1,
			description: "模式3：返回最近 N 轮，必须为正整数",
		});
		assert.equal((consolidateTool.inputSchema.properties?.threshold as Record<string, unknown>).minimum, 0);
		assert.equal((consolidateTool.inputSchema.properties?.threshold as Record<string, unknown>).maximum, 1);
	});

	test("exercises exact, range, recent, all, agent filtering, and JSONL resource compatibility", async () => {
		for (const [role, content, agent_id] of [
			["user", "A 的第一轮", "agent-a"],
			["assistant", "B 的第一轮", "agent-b"],
			["user", "无 agent 的历史轮次", undefined],
			["assistant", "A 的第二轮\n**Markdown**\n含\"引号\"", "agent-a"],
		] as const) {
			const result = await call("memory_store_turn", { date: "2026-08-02", role, content, ...(agent_id ? { agent_id } : {}) });
			assert.equal(result.isError, undefined);
		}

		const exact = await call("memory_get_raw_turns", { date: "2026-08-02", turn_id: "turn_0004", agent_id: "agent-a" });
		assert.match(text(exact), /A 的第二轮\n\*\*Markdown\*\*\n含"引号"/);
		assert.doesNotMatch(text(exact), /B 的第一轮|无 agent 的历史轮次/);

		const range = await call("memory_get_raw_turns", { date: "2026-08-02", turn_start: "turn_0001", turn_end: "turn_0004", agent_id: "agent-a" });
		assert.match(text(range), /A 的第一轮/);
		assert.match(text(range), /A 的第二轮/);
		assert.doesNotMatch(text(range), /B 的第一轮|无 agent 的历史轮次/);

		const recent = await call("memory_get_raw_turns", { date: "2026-08-02", limit: 1, agent_id: "agent-a" });
		assert.match(text(recent), /A 的第二轮/);
		assert.doesNotMatch(text(recent), /A 的第一轮/);

		const all = await call("memory_get_raw_turns", { date: "2026-08-02" });
		assert.match(text(all), /A 的第一轮|B 的第一轮|无 agent 的历史轮次/);

		const invalid = await call("memory_get_raw_turns", { date: "2026-08-02", limit: 0 });
		assert.equal(invalid.isError, true);
		assert.doesNotMatch(text(invalid), /A 的第一轮|B 的第一轮|无 agent 的历史轮次/);

		const rawResource = await client.readResource({ uri: "memory://raw/2026-08-02" });
		assert.equal(rawResource.contents[0].mimeType, "application/jsonl");
		assert.equal(rawResource.contents[0].text?.split("\n").length, 4);
		for (const line of rawResource.contents[0].text?.split("\n") ?? []) assert.doesNotThrow(() => JSON.parse(line));
	});

	test("detects calibrated Chinese topic pairs above unrelated topics", async () => {
		writeTopic("对话系统", [{ date: "2026-08-01", fragmentId: "2026-08-01/frag_001", summary: "对话状态与消息输入" }]);
		writeTopic("对话系统改造", [{ date: "2026-08-02", fragmentId: "2026-08-02/frag_002", summary: "改造对话状态和输入流程" }]);
		writeTopic("对话系统与输入控制", [{ date: "2026-08-03", fragmentId: "2026-08-03/frag_003", summary: "对话输入控制与状态" }]);
		writeTopic("数据库备份", [{ date: "2026-08-04", fragmentId: "2026-08-04/frag_004", summary: "备份数据库快照" }]);

		const detected = await call("memory_consolidate_topics", { action: "detect" });
		const payload = JSON.parse(text(detected));
		assert.equal(payload.threshold, 0.3);
		assert.ok(payload.pairs.length >= 2);
		assert.ok(payload.pairs.every((pair: { similarity: number }) => pair.similarity >= 0.3));
		assert.ok(payload.pairs.some((pair: any) => [pair.topic_a.name, pair.topic_b.name].includes("对话系统改造")));
		assert.ok(!payload.pairs.some((pair: any) => [pair.topic_a.name, pair.topic_b.name].includes("数据库备份")));
		for (let index = 1; index < payload.pairs.length; index++) {
			assert.ok(payload.pairs[index - 1].similarity >= payload.pairs[index].similarity);
		}
	});

	test("rehearses dry-run, caught rollback, execute, trash backup, backlink update, and cleanup", async () => {
		writeFragment("2026-08-02/frag_002", "对话系统改造");
		const sourcePath = path.join(topicsDir, "对话系统改造.md");
		const sourceBytes = fs.readFileSync(sourcePath);
		const request = {
			action: "execute",
			merges: [{ target: "对话系统", sources: ["对话系统改造"] }],
		};
		const before = snapshot(memoryRoot);

		const dryRun = await call("memory_consolidate_topics", { ...request, dry_run: true });
		const dryPayload = JSON.parse(text(dryRun));
		assert.equal(dryPayload.validated, true);
		assert.equal(dryPayload.dry_run, true);
		assert.deepEqual(dryPayload.changes.topics_to_remove, ["对话系统改造"]);
		assert.deepEqual(dryPayload.changes.fragments_to_update, ["2026-08-02/frag_002"]);
		assertSnapshotEqual(snapshot(memoryRoot), before);

		const trashBlocker = path.join(topicsDir, ".trash");
		fs.writeFileSync(trashBlocker, "blocker\n", "utf-8");
		const beforeRollback = snapshot(memoryRoot);
		const failed = await call("memory_consolidate_topics", request);
		const failedPayload = JSON.parse(text(failed));
		assert.equal(failed.isError, true);
		assert.equal(failedPayload.committed, false);
		assert.equal(failedPayload.recovery_failed, undefined);
		assert.ok(failedPayload.errors.some((item: { group_index: number }) => item.group_index === -1));
		assert.ok(failedPayload.merged.every((item: { status: string }) => item.status === "error"));
		assertSnapshotEqual(snapshot(memoryRoot), beforeRollback);
		assert.equal(fs.existsSync(path.join(topicsDir, ".transactions")), false);
		fs.unlinkSync(trashBlocker);

		const execute = await call("memory_consolidate_topics", request);
		const executePayload = JSON.parse(text(execute));
		assert.equal(execute.isError, undefined);
		assert.equal(executePayload.validated, true);
		assert.equal(executePayload.committed, true);
		assert.equal(executePayload.merged[0].new_entries_count, dryPayload.merged[0].new_entries_count);
		assert.equal(executePayload.merged[0].fragments_updated, dryPayload.merged[0].fragments_updated);
		assert.equal(fs.existsSync(sourcePath), false);
		assert.match(fs.readFileSync(path.join(fragmentsDir, "2026-08-02/frag_002.md"), "utf-8"), /\*\*主题\*\*：对话系统/);
		const trashFiles = fs.readdirSync(path.join(topicsDir, ".trash"));
		const sourceTrash = trashFiles.find((file) => file.startsWith("对话系统改造-"));
		assert.ok(sourceTrash);
		assert.deepEqual(fs.readFileSync(path.join(topicsDir, ".trash", sourceTrash)), sourceBytes);
		assert.equal(fs.existsSync(path.join(topicsDir, ".transactions")), false);
	});

	test("rejects an invalid batch with isError and zero writes", async () => {
		writeTopic("有效目标", [{ date: "2026-08-05", fragmentId: "2026-08-05/frag_005", summary: "有效目标摘要" }]);
		writeTopic("有效来源", [{ date: "2026-08-06", fragmentId: "2026-08-06/frag_006", summary: "有效来源摘要" }]);
		writeFragment("2026-08-06/frag_006", "有效来源");
		const before = snapshot(memoryRoot);

		const result = await call("memory_consolidate_topics", {
			action: "execute",
			merges: [
				{ target: "有效目标", sources: ["有效来源"] },
				{ target: "不存在目标", sources: ["不存在来源"] },
			],
		});
		const payload = JSON.parse(text(result));
		assert.equal(result.isError, true);
		assert.equal(payload.validated, false);
		assert.ok(payload.errors.length > 0);
		assert.ok(payload.merged.every((item: { status: string }) => item.status === "error"));
		assertSnapshotEqual(snapshot(memoryRoot), before);
		assert.equal(fs.existsSync(path.join(topicsDir, ".transactions")), false);
	});
});
