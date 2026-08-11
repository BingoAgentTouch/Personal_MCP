// O3 双格式兼容测试：v2（二进制向量）写读正确 + v1（JSON 内联向量）读兼容
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-sidecar-"));

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

function view(id: string, kind: "summary" | "evidence", dim: number, seed: number): import("../src/types.ts").EmbeddingMaterializedView {
	return {
		view_id: id,
		kind,
		input_hash: `sha256:${id}`,
		vector: Array.from({ length: dim }, (_, i) => Math.sin(seed + i) * 0.5),
		tokens: { used: 10 },
		source_spans: [{ source_field: "turns_text", start_char: 0, end_char: 10, start_token: 0, end_token: 5 }],
		disclosure: { disclosure_level: "T1", snippet: `snippet-${id}`, snippet_token_count: 5, snippet_anchor: "view_fallback" },
	};
}

test("v2 写读正确 + v1 读兼容（generation 层）", async () => {
	const policy = await fixture.validEvidencePolicy(0.81);
	const manifest = await generation.createGeneration("gen_sidecar", "sha256:sidecar", 8, "multiview", policy);
	await import("../src/mcp/handlers.ts").then((h) => h.handleStoreTurn({ date: "2026-08-10", role: "user", content: "sidecar 兼容测试" }));
	const prepared = fragments.prepareFragment({ date: "2026-08-10", start_turn_id: "turn_0001", end_turn_id: "turn_0001", task_desc: "sidecar", result_desc: "结果", tags: [], topic_name: "sidecar" });
	const { fragment_id } = fragments.commitPreparedFragment(prepared);

	const dim = 8;
	const summary = view("summary", "summary", dim, 1);
	const ev1 = view("evidence_001", "evidence", dim, 2);
	generation.writeGenerationViews(manifest, fragment_id, "sha256:src", [summary, ev1]);
	generation.finalizeGeneration("gen_sidecar");
	generation.activateGeneration("gen_sidecar");
	delta.resetDeltaForActiveGeneration();

	// --- v2 写 ---
	const sidecarPath = generation.generationMultiviewSidecarPath("gen_sidecar", fragment_id);
	const binPath = generation.generationMultiviewVectorsBinPath("gen_sidecar", fragment_id);
	const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
	assert.equal(sidecar.view_schema_version, 2, "sidecar 应为 v2");
	assert.ok(fs.existsSync(binPath), "vectors.bin 应存在");
	assert.equal(typeof sidecar.views["summary"], "object", "v2 views 值应为元数据对象");

	const record = generation.readGenerationIndex("gen_sidecar")[fragment_id];
	const readBack = generation.readGenerationMultiviewViews("gen_sidecar", fragment_id, record, dim, "full");
	assert.ok(readBack, "v2 应可读");
	assert.equal(readBack!.length, 2);
	// 读回为 float32 round-trip 值（O3 存储精度）
	const f32 = (v: number[]) => Array.from(new Float32Array(v));
	assert.deepEqual(readBack!.find((v) => v.view_id === "summary")!.vector, f32(summary.vector), "summary 向量应一致（float32 精度）");
	assert.deepEqual(readBack!.find((v) => v.view_id === "evidence_001")!.vector, f32(ev1.vector), "evidence 向量应一致（float32 精度）");

	// --- 降级为 v1（JSON 内联向量）读兼容 ---
	const v1Sidecar = {
		view_schema_version: 1,
		fragment_id,
		source_content_hash: "sha256:src",
		views: Object.fromEntries([[summary.view_id, summary.vector], [ev1.view_id, ev1.vector]]),
	};
	fs.writeFileSync(sidecarPath, `${JSON.stringify(v1Sidecar, null, 2)}\n`);
	fs.rmSync(binPath);
	// v1 兼容核心：旧格式在检索热路径（light）可读；v1 向量是 JSON 内联 double 原值（非 float32）
	const readV1 = generation.readGenerationMultiviewViews("gen_sidecar", fragment_id, record, dim, "light");
	assert.ok(readV1, "v1 旧格式在 light 检索下应可读（兼容）");
	assert.deepEqual(readV1!.find((v) => v.view_id === "evidence_001")!.vector, ev1.vector, "v1 向量应一致（JSON 内联 double 原值）");
});

test("v2 写读正确（delta 层）", async () => {
	const policy = await fixture.validEvidencePolicy(0.81);
	const manifest = await generation.createGeneration("gen_sidecar_d", "sha256:sidecard", 8, "multiview", policy);
	generation.finalizeGeneration("gen_sidecar_d");
	generation.activateGeneration("gen_sidecar_d");
	delta.resetDeltaForActiveGeneration();
	await import("../src/mcp/handlers.ts").then((h) => h.handleStoreTurn({ date: "2026-08-10", role: "user", content: "delta sidecar 测试" }));
	const prepared = fragments.prepareFragment({ date: "2026-08-10", start_turn_id: "turn_0002", end_turn_id: "turn_0002", task_desc: "delta", result_desc: "结果", tags: [], topic_name: "sidecar" });
	const { fragment_id } = fragments.commitPreparedFragment(prepared);

	const dim = 8;
	const summary = view("summary", "summary", dim, 3);
	const ev1 = view("evidence_002", "evidence", dim, 4);
	delta.upsertDeltaViews(delta.readDeltaManifest()!, fragment_id, "sha256:src2", [summary, ev1]);

	const sidecarPath = delta.multiviewSidecarPath(fragment_id);
	const binPath = delta.multiviewVectorsBinPath(fragment_id);
	const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
	assert.equal(sidecar.view_schema_version, 2, "delta sidecar 应为 v2");
	assert.ok(fs.existsSync(binPath), "delta vectors.bin 应存在");

	const deltaRec = delta.readDeltaIndex()[fragment_id];
	const readBack = delta.readDeltaMultiviewViews(fragment_id, deltaRec, dim, "full");
	assert.ok(readBack, "delta v2 应可读");
	const f32 = (v: number[]) => Array.from(new Float32Array(v));
	assert.deepEqual(readBack!.find((v) => v.view_id === "evidence_002")!.vector, f32(ev1.vector), "delta evidence 向量应一致（float32 精度）");
});
