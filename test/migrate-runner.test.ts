import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = "D:/AgentStore/memory-mcp-server";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-migration-"));
const memoryRoot = path.join(tempRoot, "memory");
const fragmentDir = path.join(memoryRoot, "fragments", "2026-08-03");
const runner = path.join(projectRoot, "migrate_embeddings.mjs");

before(() => {
	fs.mkdirSync(fragmentDir, { recursive: true });
	fs.writeFileSync(
		path.join(fragmentDir, "frag_001.md"),
		"# 任务：迁移测试\n\n**日期**：2026-08-03\n**轮次**：turn_0001 ~ turn_0001\n**标签**：`test`\n**主题**：迁移\n\n## 摘要\n\n迁移测试\n\n## 结论\n\n验证 generation runner\n\n## 原文\n\n[用户]：验证 migration runner\n",
		"utf8",
	);
});

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function run(command: string, generation?: string): any {
	const args = [runner, command, "--memory-root", memoryRoot];
	if (generation) args.push("--generation", generation);
	return JSON.parse(execFileSync(process.execPath, args, { cwd: tempRoot, encoding: "utf8" }));
}

describe("offline embedding migration runner", () => {
	test("runs inventory, build, validate, switch and rollback", () => {
		const inventory = run("inventory");
		assert.equal(inventory.fragment_count, 1);
		const built = run("build", "gen_test_a");
		assert.equal(built.state, "ready");
		assert.equal(built.materialized, 1);
		const valid = run("validate", "gen_test_a");
		assert.equal(valid.valid, true);
		const switched = run("switch", "gen_test_a");
		assert.equal(switched.pointer.active_generation_id, "gen_test_a");
		const pointerPath = path.join(memoryRoot, "embedding_active.json");
		assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).active_generation_id, "gen_test_a");
	});
});
