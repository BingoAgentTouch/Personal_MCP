// 方案 B（渐进式披露）Phase 1 测试：evidence_hint 三档披露行为 + 每查询上限 + 向后兼容
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-hint-"));

let handlers: typeof import("../src/mcp/handlers.ts");
let generation: typeof import("../src/embedding/generation.ts");
let delta: typeof import("../src/embedding/delta.ts");
let fragments: typeof import("../src/storage/fragments.ts");
let provider: typeof import("../src/embedding/provider.ts");
let builder: typeof import("../src/embedding/builder.ts");
let fixture: typeof import("./evidence-policy-fixture.ts");

test.before(async () => {
	process.chdir(tempRoot);
	handlers = await import("../src/mcp/handlers.ts");
	generation = await import("../src/embedding/generation.ts");
	delta = await import("../src/embedding/delta.ts");
	fragments = await import("../src/storage/fragments.ts");
	provider = await import("../src/embedding/provider.ts");
	builder = await import("../src/embedding/builder.ts");
	fixture = await import("./evidence-policy-fixture.ts");
});

test.after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

// 构造与 query 向量夹角为 arccos(target) 的单位向量（cosine 精确 = target）
function vectorWithCosine(target: number, qv: number[], seed: number): number[] {
	let u = Array.from({ length: qv.length }, (_, i) => Math.sin(seed * 31.7 + i * 1.3));
	const dot = u.reduce((a, b, i) => a + b * qv[i], 0);
	u = u.map((x, i) => x - dot * qv[i]);
	const nu = Math.sqrt(u.reduce((a, b) => a + b * b, 0)) || 1;
	u = u.map((x) => x / nu);
	return qv.map((x, i) => target * x + Math.sqrt(Math.max(0, 1 - target * target)) * u[i]);
}

const disclosure = (level: "T1" | "T2", snippet: string) => ({
	disclosure_level: level,
	snippet,
	snippet_token_count: Math.max(1, snippet.length),
	snippet_anchor: "view_fallback" as const,
});

function makeViews(fragId: string, seed: number, summaryCos: number, evidenceCos: number, qv: number[]) {
	return [
		{
			view_id: `v${seed}_summary`,
			kind: "summary" as const,
			input_hash: `sha256:s${seed}`,
			vector: vectorWithCosine(summaryCos, qv, seed),
			tokens: { used: 30 },
			source_spans: [{ source_field: "turns_text", start_char: 0, end_char: 30, start_token: 0, end_token: 10 }],
			disclosure: disclosure("T1", `摘要 ${seed}`),
		},
		{
			view_id: `v${seed}_evidence1`,
			kind: "evidence" as const,
			input_hash: `sha256:e${seed}`,
			vector: vectorWithCosine(evidenceCos, qv, seed + 1000),
			tokens: { used: 90 },
			source_spans: [{ source_field: "turns_text", start_char: 100, end_char: 160, start_token: 40, end_token: 60 }],
			disclosure: disclosure("T2", `中段证据 ${seed}：状态机转换失败排查`),
		},
	];
}

const DATE = "2026-08-09";
let seq = 0;
async function addFrag(summaryCos: number, evidenceCos: number, genId = "gen_hint"): Promise<string> {
	seq += 1;
	const turnNo = seq * 2 - 1;
	await handlers.handleStoreTurn({ date: DATE, role: "user", content: `片段 ${seq} 轮次 ${turnNo}：电梯状态机与门系统讨论` });
	await handlers.handleStoreTurn({ date: DATE, role: "user", content: `片段 ${seq} 轮次 ${turnNo + 1}：信号连接与参数` });
	const prepared = fragments.prepareFragment({
		date: DATE,
		start_turn_id: `turn_${String(turnNo).padStart(4, "0")}`,
		end_turn_id: `turn_${String(turnNo + 1).padStart(4, "0")}`,
		task_desc: `电梯状态机片段 ${seq}`,
		result_desc: `结果 ${seq}`,
		tags: [],
		topic_name: "hint-test",
	});
	const { fragment_id } = fragments.commitPreparedFragment(prepared);
	const manifest = generation.readGenerationManifest(genId)!;
	const qv = await queryVector("电梯状态机 报错 修复");
	generation.writeGenerationViews(manifest, fragment_id, `sha256:src${seq}`, makeViews(fragment_id, seq, summaryCos, evidenceCos, qv));
	return fragment_id;
}

async function queryVector(query: string): Promise<number[]> {
	const active = generation.getActiveGeneration();
	const built = await builder.buildQueryInput(query, active ?? undefined);
	const vec = await provider.encode(built.text);
	return Array.from(vec);
}

async function search(query: string, topK = 10): Promise<import("../src/types.ts").SearchResultItem[]> {
	const res = await handlers.handleSearch({ query, top_k: topK });
	assert.equal(res.isError, undefined, res.content?.[0]?.text);
	return JSON.parse(res.content[0].text).results;
}

test("三档披露：过竞争门无 hint / 未过竞争门但过披露门有 hint / 未过披露门无 hint", async () => {
	const policy = await fixture.validEvidencePolicy(0.81);
	assert.equal(policy.disclosure_threshold, undefined); // 缺省 → 自适应式，验证向后兼容
	const manifest = await generation.createGeneration("gen_hint", "sha256:hint", 384, "multiview", policy);

	const fragA = await addFrag(0.3, 0.9); // 过竞争门（0.9 ≥ 0.81 且 > summary 0.3）
	const fragB = await addFrag(0.3, 0.65); // 未过竞争门，但 0.65 ≥ max(0.5, 0.8×0.3=0.24)=0.5 → 过披露门
	const fragC = await addFrag(0.3, 0.3); // 未过披露门（0.3 < 0.5）

	generation.finalizeGeneration("gen_hint");
	generation.activateGeneration("gen_hint");
	delta.resetDeltaForActiveGeneration();

	const results = await search("电梯状态机 报错 修复");
	const byId = new Map(results.map((r) => [r.fragment_id, r]));
	const a = byId.get(fragA)!;
	const b = byId.get(fragB)!;
	const c = byId.get(fragC)!;
	assert.ok(a, "fragA 应被召回");
	assert.ok(b, "fragB 应被召回");
	assert.ok(c, "fragC 应被召回");

	// A：过竞争门 → 完整披露模式，无 hint
	assert.equal(a.evidence_hint, undefined);
	assert.equal(a.raw_similarity_mode, "fragment-max-view-v1");
	// B：未过竞争门但过披露门 → 有 hint
	assert.ok(b.evidence_hint, "fragB 应有 evidence_hint");
	assert.equal(b.raw_similarity_mode, "fragment-summary-only-shadow-v1");
	assert.equal(b.evidence_hint!.score, 0.65);
	assert.ok(b.evidence_hint!.view_id.endsWith("_evidence1"));
	assert.ok(b.evidence_hint!.source_range.includes("turns_text"));
	assert.ok(b.evidence_hint!.snippet.length > 0);
	// C：未过披露门 → 无 hint
	assert.equal(c.evidence_hint, undefined);
	assert.equal(c.raw_similarity_mode, "fragment-summary-only-shadow-v1");
});

test("每查询 hint 上限（默认 2 条）", async () => {
	const policy = await fixture.validEvidencePolicy(0.81);
	const manifest = await generation.createGeneration("gen_hint_cap", "sha256:hintcap", 384, "multiview", policy);
	for (let i = 0; i < 4; i++) await addFrag(0.3, 0.65, "gen_hint_cap"); // 4 个都过披露门 → 候选 4 条
	generation.finalizeGeneration("gen_hint_cap");
	generation.activateGeneration("gen_hint_cap");
	delta.resetDeltaForActiveGeneration();

	const results = await search("电梯状态机 报错 修复");
	const hints = results.filter((r) => r.evidence_hint);
	assert.ok(hints.length >= 1, "至少应有 hint 被保留");
	assert.ok(hints.length <= 2, `hint 数量 ${hints.length} 不应超过上限 2`);
	// 保留的是分数最高的（排序在前）
	const scores = hints.map((r) => r.evidence_hint!.score);
	assert.deepEqual([...scores].sort((a, b) => b - a), scores, "hint 应按分数降序保留");
});
