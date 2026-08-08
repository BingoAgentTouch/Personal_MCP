import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-multiview-"));
process.chdir(tempRoot);

const generation = await import("../src/embedding/generation.ts");
const delta = await import("../src/embedding/delta.ts");
const handlers = await import("../src/mcp/handlers.ts");
const retriever = await import("../src/search/retriever.ts");
const builder = await import("../src/embedding/builder.ts");
const provider = await import("../src/embedding/provider.ts");
const fragments = await import("../src/storage/fragments.ts");
const { validEvidencePolicy } = await import("./evidence-policy-fixture.ts");

function snapshotFiles(filePaths: string[]): Map<string, string | null> {
	return new Map(filePaths.map((filePath) => [filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null]));
}

function assertSnapshot(fileSnapshot: Map<string, string | null>): void {
	for (const [filePath, content] of fileSnapshot) {
		assert.equal(fs.existsSync(filePath), content !== null, `unexpected existence change: ${filePath}`);
		if (content !== null) assert.equal(fs.readFileSync(filePath, "utf8"), content, `unexpected content change: ${filePath}`);
	}
}

function realFileOps() {
	return {
		mkdirSync: (filePath: string, options?: { recursive?: boolean }) => fs.mkdirSync(filePath, options),
		writeFileSync: (filePath: string, content: string, encoding?: BufferEncoding) => fs.writeFileSync(filePath, content, encoding),
		readFileSync: (filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding),
		renameSync: (source: string, destination: string) => fs.renameSync(source, destination),
		unlinkSync: (filePath: string) => fs.unlinkSync(filePath),
		existsSync: (filePath: string) => fs.existsSync(filePath),
		rmSync: (filePath: string, options?: { recursive?: boolean; force?: boolean }) => fs.rmSync(filePath, options),
	};
}

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function view(viewId: string, kind: "summary" | "evidence", vector: number[]) {
	return {
		view_id: viewId,
		kind,
		vector,
		input_hash: `sha256:input-${viewId}`,
		tokens: { used: 2, model_max: 512 },
		source_spans: [
			{
				source_field: kind === "summary" ? "result_desc" : "turns_text",
				start_char: 0,
				end_char: 4,
				start_token: 0,
				end_token: 2,
			},
		],
		disclosure: {
			disclosure_level: "T1" as const,
			snippet: `${viewId} disclosure`,
			snippet_token_count: 2,
			snippet_anchor: "view_fallback" as const,
		},
	};
}

describe("C-0/C-1 multiview materialization", () => {
	beforeEach(() => {
		fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	});

	test("persists multiview identity and rejects legacy vector writes", async () => {
		const manifest = await generation.createGeneration("gen_mv_identity", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		assert.equal(manifest.representation_kind, "multiview", await validEvidencePolicy());
		assert.equal(manifest.document_recipe_id, "fragment-multiview-budgeted");
		assert.equal(manifest.aggregation_mode, "fragment-max-view-v1");
		assert.equal(manifest.evidence_policy_id, "evidence-gate-test-v1");
		assert.equal(manifest.evidence_policy?.status, "validated");
		assert.ok(manifest.representation_identity_hash.startsWith("sha256:"));
		assert.throws(
			() => generation.writeGenerationVector(manifest, "2026-08-07/frag_001", [0.5, 0.5], {
				source_content_hash: "sha256:source",
				input_hash: "sha256:input",
				tokens: { used: 2 },
			}),
			/multiview generation/,
		);
	});

	test("materializes summary and evidence views as one delta record", async () => {
		const manifest = await generation.createGeneration("gen_mv_delta", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		const deltaManifest = delta.ensureActiveDelta();
		const fragmentId = "2026-08-07/frag_002";
		const record = delta.upsertDeltaViews(
			deltaManifest,
			fragmentId,
			"sha256:source",
			[view("summary", "summary", [0.5, 0.5]), view("evidence_001", "evidence", [0.25, 0.75])],
		);

		assert.equal(record.state, "materialized");
		assert.equal(record.views?.length, 2);
		assert.equal(record.views?.[0]?.vector_dimension, 2);
		assert.ok(record.view_set_hash?.startsWith("sha256:"));
		assert.equal(fs.existsSync(delta.multiviewSidecarPath(fragmentId)), true);
		assert.equal(fs.existsSync(delta.deltaVectorPath(fragmentId)), true);
		const sidecar = JSON.parse(fs.readFileSync(delta.multiviewSidecarPath(fragmentId), "utf8"));
		assert.deepEqual(Object.keys(sidecar.views).sort(), ["evidence_001", "summary"]);
		assert.deepEqual(delta.readDeltaIndex()[fragmentId]?.views?.map((item) => item.view_id), ["summary", "evidence_001"]);
	});

	test("creates a fragment through the multiview handler path", async () => {
		const manifest = await generation.createGeneration("gen_mv_handler", "sha256:inventory", 384, "multiview", await validEvidencePolicy());
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		await handlers.handleStoreTurn({ date: "2026-08-07", role: "user", content: "multiview handler fixture" });
		const result = await handlers.handleCreateFragment({
			date: "2026-08-07",
			start_turn_id: "turn_0001",
			end_turn_id: "turn_0001",
			task_desc: "multiview handler create",
			result_desc: "summary and evidence are materialized",
			tags: ["multiview"],
			topic_name: "embedding",
		});
		assert.equal(result.isError, undefined);
		const payload = JSON.parse(result.content[0].text);
		assert.equal(payload.embedding_layer, "delta");
		const record = delta.readDeltaIndex()[payload.fragment_id];
		assert.ok(record);
		assert.equal(record?.views?.some((item) => item.kind === "summary"), true);
		assert.equal(record?.views?.some((item) => item.kind === "evidence"), true);
	});

	test("restores the previous complete view set when replacement commit fails", async () => {
		const manifest = await generation.createGeneration("gen_mv_atomic", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		const deltaManifest = delta.ensureActiveDelta();
		const fragmentId = "2026-08-07/frag_004";
		delta.upsertDeltaViews(deltaManifest, fragmentId, "sha256:old", [view("summary", "summary", [0.5, 0.5]), view("evidence_001", "evidence", [0.25, 0.75])]);
		const paths = [delta.multiviewSidecarPath(fragmentId), delta.deltaVectorPath(fragmentId), delta.deltaIndexPath(), delta.deltaManifestPath()];
		const before = snapshotFiles(paths);
		const ops = realFileOps();
		let renameCount = 0;
		const failingOps = { ...ops, renameSync: (source: string, destination: string) => {
			renameCount += 1;
			if (renameCount === 3) throw new Error("injected commit rename");
			return ops.renameSync(source, destination);
		} };
		assert.throws(
			() => delta.upsertDeltaViews(deltaManifest, fragmentId, "sha256:new", [view("summary", "summary", [0.1, 0.9]), view("evidence_002", "evidence", [0.8, 0.2])], "update", failingOps),
			/injected commit rename/,
		);
		assertSnapshot(before);
		assert.equal(fs.existsSync(path.join(tempRoot, "memory", "embedding_delta", "transactions", "multiview")), false);
	});

	test("repairs a multiview orphan with a complete rebuild payload", async () => {
		const manifest = await generation.createGeneration("gen_mv_reconcile", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		const fragmentId = "2026-08-07/frag_005";
		const fragmentsDir = path.join(tempRoot, "memory", "fragments", "2026-08-07");
		fs.mkdirSync(fragmentsDir, { recursive: true });
		fs.writeFileSync(path.join(fragmentsDir, "frag_005.md"), "# fixture\n", "utf8");
		const result = await delta.reconcileOrphans(async (id) => ({
			representation_kind: "multiview" as const,
			sourceHash: "sha256:repair",
			views: [view("summary", "summary", [0.5, 0.5]), view("evidence_001", "evidence", [0.3, 0.7])],
		}));
		assert.equal(result.repaired_orphans, 1);
		assert.equal(result.pending_count, 0);
		assert.ok(result.repaired_orphans >= 1);
		assert.equal(delta.readDeltaIndex()[fragmentId]?.operation, "reconcile");
		assert.equal(delta.readDeltaIndex()[fragmentId]?.views?.length, 2);
	});

	test("records pending when a multiview orphan rebuild fails", async () => {
		const manifest = await generation.createGeneration("gen_mv_pending", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		const fragmentId = "2026-08-07/frag_006";
		const fragmentsDir = path.join(tempRoot, "memory", "fragments", "2026-08-07");
		fs.mkdirSync(fragmentsDir, { recursive: true });
		fs.writeFileSync(path.join(fragmentsDir, "frag_006.md"), "# fixture\n", "utf8");
		const result = await delta.reconcileOrphans(async () => { throw new Error("injected rebuild"); });
		assert.equal(result.repaired_orphans, 0);
		assert.ok(result.pending_count >= 1);
		assert.equal(delta.readDeltaIndex()[fragmentId]?.state, "pending");
		assert.equal(fs.existsSync(delta.multiviewSidecarPath(fragmentId)), false);
	});

	test("keeps the public result fragment-level for multiview retrieval", async () => {
		const manifest = await generation.createGeneration("gen_mv_search", "sha256:inventory", 384, "multiview", await validEvidencePolicy());
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		await handlers.handleStoreTurn({ date: "2026-08-07", role: "user", content: "multiview search fixture" });
		const created = await handlers.handleCreateFragment({
			date: "2026-08-07",
			start_turn_id: "turn_0001",
			end_turn_id: "turn_0001",
			task_desc: "C2 multiview retrieval",
			result_desc: "fragment-level result only",
			tags: ["c2"],
			topic_name: "embedding",
		});
		assert.equal(created.isError, undefined);
		const result = await retriever.search("C2 multiview retrieval", 5);
		assert.equal(result.results.length, 1);
		const item = result.results[0] as Record<string, unknown>;
		assert.equal("views" in item, false);
		assert.equal("view_id" in item, false);
		assert.equal("source_spans" in item, false);
		assert.equal("vector" in item, false);
		assert.equal(typeof item.matched_view, "string");
		assert.ok("matched_source_range" in item);
		assert.ok("matched_snippet" in item);
		assert.ok("snippet_anchor" in item);
		assert.ok(["fragment-max-view-v1", "fragment-summary-only-shadow-v1"].includes(item.raw_similarity_mode as string));
	});

	test("anchors evidence disclosure to the persisted span and preserves base/delta provenance", async () => {
		const query = "EVIDENCE_TOKEN";
		const stored = fragments.createFragment({
			date: "2026-08-07",
			start_turn_id: "turn_0001",
			end_turn_id: "turn_0001",
			task_desc: "disclosure fixture",
			result_desc: "persisted evidence range",
			tags: ["disclosure"],
			topic_name: "embedding",
		});
		const fragmentId = stored.fragment_id;
		const fragmentPath = path.join(tempRoot, "memory", "fragments", "2026-08-07", `${fragmentId.split("/")[1]}.md`);
		const raw = fs.readFileSync(fragmentPath, "utf8");
		fs.writeFileSync(fragmentPath, `${raw}\n## 原文\n\nOUTSIDE_BEFORE\nINSIDE EVIDENCE_TOKEN verified fact\nOUTSIDE_AFTER\n`, "utf8");
		const fragment = fragments.getFragment(fragmentId)!;
		const sourceHash = builder.sourceContentHash({
			task_desc: fragment.task_desc,
			result_desc: fragment.result_desc,
			tags: fragment.tags,
			topic_name: fragment.topic_name,
			turns_text: fragment.turns_text,
		});
		const manifest = await generation.createGeneration("gen_mv_disclosure", "sha256:inventory", 384, "multiview", await validEvidencePolicy(0.1));
		generation.setGenerationExpectedCount(manifest.generation_id, 1);
		const start = fragment.turns_text.indexOf("INSIDE EVIDENCE_TOKEN");
		const end = fragment.turns_text.indexOf("OUTSIDE_AFTER");
		assert.ok(start >= 0 && end > start);
		const span = { source_field: "turns_text", start_char: start, end_char: end, start_token: 0, end_token: 8 };
		const queryVector = await provider.encode((await builder.buildQueryInput(query, manifest)).text);
		const summaryVector = new Array(queryVector.length).fill(0);
		const persistedViews = [
			{
				view_id: "summary",
				kind: "summary" as const,
				vector: summaryVector,
				input_hash: "sha256:summary",
				tokens: { used: 1, model_max: 512 },
				source_spans: [],
				disclosure: { disclosure_level: "T1" as const, snippet: "summary", snippet_token_count: 1, snippet_anchor: "view_fallback" as const },
			},
			{
				view_id: "evidence_001",
				kind: "evidence" as const,
				vector: queryVector,
				input_hash: "sha256:evidence",
				tokens: { used: 1, model_max: 512 },
				source_spans: [span],
				disclosure: { disclosure_level: "T2" as const, snippet: "INSIDE EVIDENCE_TOKEN verified fact", snippet_token_count: 4, snippet_anchor: "view_fallback" as const },
			},
		];
		generation.writeGenerationViews(manifest, fragmentId, sourceHash, persistedViews);
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();

		const base = (await retriever.search(query, 1)).results[0]!;
		assert.equal(base.embedding_layer, "base");
		assert.equal(base.delta_id, null);
		assert.equal(base.base_generation_id, manifest.generation_id);
		assert.equal(base.matched_view, "evidence_001");
		assert.deepEqual(base.matched_source_range, span);
		assert.equal(base.snippet_anchor, "lexical_overlap");
		assert.match(base.matched_snippet ?? "", /EVIDENCE_TOKEN/);
		assert.doesNotMatch(base.matched_snippet ?? "", /OUTSIDE_BEFORE|OUTSIDE_AFTER/);

		const deltaManifest = delta.ensureActiveDelta();
		const fallbackQuery = "NO_MATCH_TOKEN";
		const fallbackVector = await provider.encode((await builder.buildQueryInput(fallbackQuery, manifest)).text);
		delta.upsertDeltaViews(deltaManifest, fragmentId, sourceHash, [
			{ ...persistedViews[0], vector: new Array(fallbackVector.length).fill(0) },
			{
				...persistedViews[1],
				vector: fallbackVector,
				disclosure: { disclosure_level: "T2", snippet: "OUTSIDE_BEFORE", snippet_token_count: 1, snippet_anchor: "view_fallback" },
			},
		]);
		const fromDelta = (await retriever.search(fallbackQuery, 1)).results[0]!;
		assert.equal(fromDelta.embedding_layer, "delta");
		assert.equal(fromDelta.base_generation_id, manifest.generation_id);
		assert.equal(fromDelta.delta_id, deltaManifest.delta_id);
		assert.equal(fromDelta.matched_view, "evidence_001");
		assert.deepEqual(fromDelta.matched_source_range, span);
		assert.equal(fromDelta.matched_snippet, null);
		assert.equal(fromDelta.snippet_anchor, null);
	});

	test("rejects invalid view sets before creating sidecar or index entries", async () => {
		const manifest = await generation.createGeneration("gen_mv_invalid", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.finalizeGeneration(manifest.generation_id);
		generation.activateGeneration(manifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		const deltaManifest = delta.ensureActiveDelta();
		const fragmentId = "2026-08-07/frag_003";
		assert.throws(
			() => delta.upsertDeltaViews(deltaManifest, fragmentId, "sha256:source", [view("evidence_001", "evidence", [0.25, 0.75])]),
			/exactly one summary view/,
		);
		assert.equal(fs.existsSync(delta.multiviewSidecarPath(fragmentId)), false);
		assert.equal(delta.readDeltaIndex()[fragmentId], undefined);
	});
});
