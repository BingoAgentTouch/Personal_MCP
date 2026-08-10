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
const { writeValidatedEvidenceArtifact } = await import("./evidence-policy-fixture.ts");

before(() => {
	fs.mkdirSync(fragmentDir, { recursive: true });
	fs.writeFileSync(
		path.join(fragmentDir, "frag_001.md"),
		"# 任务：迁移测试\n\n**日期**：2026-08-03\n**轮次**：turn_0001 ~ turn_0001\n**标签**：`test`\n**主题**：迁移\n\n## 摘要\n\n迁移测试\n\n## 结论\n\n验证 generation runner\n\n## 原文\n\n[用户]：验证 migration runner\n",
		"utf8",
	);
});

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function run(command: string, generation?: string, extra: string[] = []): any {
	const args = [runner, command, "--memory-root", memoryRoot];
	if (generation) args.push("--generation", generation);
	args.push(...extra);
	return JSON.parse(execFileSync(process.execPath, args, { cwd: tempRoot, encoding: "utf8" }));
}

function runFailure(command: string, generation?: string, extra: string[] = []): string {
	const args = [runner, command, "--memory-root", memoryRoot];
	if (generation) args.push("--generation", generation);
	args.push(...extra);
	try {
		execFileSync(process.execPath, args, { cwd: tempRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		throw new Error("expected migration command to fail");
	} catch (error) {
		return String((error as { stderr?: Buffer | string }).stderr ?? error);
	}
}

describe("offline embedding migration runner", () => {
	test("rejects a multiview build without a validated artifact", () => {
		const stderr = runFailure("build", "gen_mv_missing", ["--representation", "multiview"]);
		assert.match(stderr, /--evidence-policy is required for multiview build/);
		assert.equal(fs.existsSync(path.join(memoryRoot, "embedding_generations", "gen_mv_missing")), false);
	});

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

	test("builds and switches a policy-backed multiview generation in a temporary root", async () => {
		const artifactPath = path.join(tempRoot, "validated-evidence-policy.json");
		await writeValidatedEvidenceArtifact(artifactPath, 0.1);
		const built = run("build", "gen_mv_runner", ["--representation", "multiview", "--evidence-policy", artifactPath]);
		assert.equal(built.state, "ready");
		assert.equal(built.representation_kind, "multiview");
		const manifest = JSON.parse(fs.readFileSync(path.join(memoryRoot, "embedding_generations", "gen_mv_runner", "manifest.json"), "utf8"));
		assert.equal(manifest.evidence_policy.status, "validated");
		assert.equal(manifest.evidence_policy_id, "evidence-gate-test-v1");
		assert.equal(run("validate", "gen_mv_runner").valid, true);
		assert.equal(run("switch", "gen_mv_runner").pointer.active_generation_id, "gen_mv_runner");
	});
});
