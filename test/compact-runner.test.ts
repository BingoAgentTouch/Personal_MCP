import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = "D:/AgentStore/memory-mcp-server";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-compact-"));
const memoryRoot = path.join(tempRoot, "memory");
const fragmentDir = path.join(memoryRoot, "fragments", "2026-08-03");
const migrateRunner = path.join(projectRoot, "migrate_embeddings.mjs");
const compactRunner = path.join(projectRoot, "compact_embeddings.mjs");

before(() => {
	fs.mkdirSync(fragmentDir, { recursive: true });
	fs.writeFileSync(
		path.join(fragmentDir, "frag_001.md"),
		"# 任务：compact 测试\n\n**日期**：2026-08-03\n**轮次**：turn_0001 ~ turn_0001\n**标签**：`test`\n**主题**：compact\n\n## 摘要\n\ncompact 测试\n\n## 结论\n\n验证 compaction runner\n\n## 原文\n\n[用户]：验证 compaction runner\n",
		"utf8",
	);
});

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function run(script: string, command: string, generation?: string): any {
	const args = [script, command, "--memory-root", memoryRoot];
	if (generation) args.push("--generation", generation);
	return JSON.parse(execFileSync(process.execPath, args, { cwd: tempRoot, encoding: "utf8" }));
}

describe("offline embedding compaction runner", () => {
	test("runs preflight, build, validate, switch, and unlock flow", () => {
		const built = run(migrateRunner, "build", "gen_base_a");
		assert.equal(built.state, "ready");
		const switched = run(migrateRunner, "switch", "gen_base_a");
		assert.equal(switched.pointer.active_generation_id, "gen_base_a");

		const preflight = run(compactRunner, "preflight");
		assert.equal(preflight.active_generation_id, "gen_base_a");
		assert.equal(preflight.lock.locked, true);
		assert.equal(JSON.parse(fs.readFileSync(path.join(memoryRoot, "embedding_delta", "manifest.json"), "utf8")).state, "sealed");

		const compactBuilt = run(compactRunner, "build", "gen_compact_a");
		assert.equal(compactBuilt.state, "ready");
		const valid = run(compactRunner, "validate", "gen_compact_a");
		assert.equal(valid.valid, true);
		const switchedCompact = run(compactRunner, "switch", "gen_compact_a");
		assert.equal(switchedCompact.pointer.active_generation_id, "gen_compact_a");
		assert.ok(switchedCompact.archived_delta_path);
		assert.ok(fs.existsSync(path.join(memoryRoot, "embedding_delta", "manifest.json")));
		assert.equal(fs.existsSync(path.join(memoryRoot, ".embedding-compaction.lock")), false);
	});
});
