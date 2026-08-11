// O1 轻量签名验收：检索热路径（light）损坏文件以轻量信号报告，完整审计（full）保留全量检测
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-audit-light-"));

let generation: typeof import("../src/embedding/generation.ts");
let delta: typeof import("../src/embedding/delta.ts");
let fragments: typeof import("../src/storage/fragments.ts");
let fixture: typeof import("./evidence-policy-fixture.ts");

test.before(async () => {
	process.chdir(tempRoot);
	generation = await import("../src/embedding/generation.ts");
	delta = await import("../src/embedding/delta.ts");
	fragments = await import("../src/storage/fragments.ts");
	fixture = await import("./evidence-policy-fixture.ts");
});

test.after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function view(id: string, kind: "summary" | "evidence", dim: number): import("../src/types.ts").EmbeddingMaterializedView {
	return {
		view_id: id,
		kind,
		input_hash: `sha256:${id}`,
		vector: Array.from({ length: dim }, (_, i) => (i + 1) / dim),
		tokens: { used: 10 },
		source_spans: [{ source_field: "turns_text", start_char: 0, end_char: 10, start_token: 0, end_token: 5 }],
		disclosure: { disclosure_level: "T1", snippet: `snippet-${id}`, snippet_token_count: 5, snippet_anchor: "view_fallback" },
	};
}

test("light 检索模式：损坏视图以 corrupt 轻量信号报告；full 审计同样检测", async () => {
	const policy = await fixture.validEvidencePolicy(0.81);
	const manifest = await generation.createGeneration("gen_audit_light", "sha256:audit", 8, "multiview", policy);
	await import("../src/mcp/handlers.ts").then((h) => h.handleStoreTurn({ date: "2026-08-10", role: "user", content: "O1 审计测试轮次" }));
	const prepared = fragments.prepareFragment({ date: "2026-08-10", start_turn_id: "turn_0001", end_turn_id: "turn_0001", task_desc: "审计片段", result_desc: "结果", tags: [], topic_name: "audit" });
	const { fragment_id } = fragments.commitPreparedFragment(prepared);
	generation.writeGenerationViews(manifest, fragment_id, "sha256:src", [view("v_summary", "summary", 8), view("v_ev1", "evidence", 8)]);
	generation.finalizeGeneration("gen_audit_light");
	generation.activateGeneration("gen_audit_light");
	delta.resetDeltaForActiveGeneration();

	// 健康基线：无损坏
	const healthy = delta.buildEffectiveEmbeddingView("light");
	assert.equal(healthy.health.corrupt_vectors, 0, "健康库 light 模式 corrupt 应为 0");

	// 损坏 sidecar（O3 v2：删除 vectors.bin → light 的存在性校验应报告 corrupt）
	const binPath = generation.generationMultiviewVectorsBinPath("gen_audit_light", fragment_id);
	fs.rmSync(binPath);

	const light = delta.buildEffectiveEmbeddingView("light");
	assert.ok(light.health.corrupt_vectors >= 1, "light 模式应报告 corrupt（轻量信号：维度校验）");
	const full = delta.buildEffectiveEmbeddingView("full");
	assert.ok(full.health.corrupt_vectors >= 1, "full 审计也应报告 corrupt");
});
