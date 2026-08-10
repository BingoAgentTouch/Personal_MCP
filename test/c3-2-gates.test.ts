import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-c3-2-gates-"));
process.chdir(tempRoot);

const generation = await import("../src/embedding/generation.ts");
const delta = await import("../src/embedding/delta.ts");
const { validEvidencePolicy } = await import("./evidence-policy-fixture.ts");

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

async function createReadyMultiviewFixture(generationId: string, fragmentId: string) {
	const manifest = await generation.createGeneration(generationId, "sha256:inventory", 2, "multiview", await validEvidencePolicy());
	generation.setGenerationExpectedCount(manifest.generation_id, 1);
	generation.writeGenerationViews(manifest, fragmentId, "sha256:source", [
		view("summary", "summary", [0.5, 0.5]),
		view("evidence_001", "evidence", [0.25, 0.75]),
	]);
	const ready = generation.finalizeGeneration(manifest.generation_id);
	return { manifest: ready, record: generation.readGenerationIndex(ready.generation_id)[fragmentId], fragmentId };
}

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("C3-2 gate checks", () => {
	beforeEach(() => {
		fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	});

	test("rejects a policy-less multiview creation before manifest writes", async () => {
		await assert.rejects(
			generation.createGeneration("gen_c32_policyless", "sha256:inventory", 2, "multiview", null as never),
			/validated evidence policy snapshot missing/,
		);
		assert.equal(fs.existsSync(generation.generationManifestPath("gen_c32_policyless")), false);
	});

	test("accepts a clean multiview generation and exposes diagnostic view counts", async () => {
		const { manifest, record, fragmentId } = await createReadyMultiviewFixture("gen_c32_clean", "2026-08-07/frag_100");
		const rows = [{ fragment_id: fragmentId, source_content_hash: "sha256:source" }];

		const validation = generation.validateGenerationRecords(manifest, { [fragmentId]: record! }, rows);

		assert.equal(validation.valid, true);
		assert.deepEqual(validation.view_counts, { total: 2, summary: 1, evidence: 1 });
		assert.doesNotThrow(() => generation.assertGenerationReadyForActivation(manifest, validation));
	});

	test("fails readiness when coverage is incomplete", async () => {
		const { manifest, record, fragmentId } = await createReadyMultiviewFixture("gen_c32_coverage", "2026-08-07/frag_101");
		const coverageBroken = {
			...manifest,
			expected_count: 2,
			materialized_count: 1,
			failed_count: 0,
			searchable_coverage: 0.5,
			state: "ready" as const,
		};
		generation.writeGenerationManifest(coverageBroken);
		const readyManifest = generation.readGenerationManifest(coverageBroken.generation_id)!;
		const rows = [{ fragment_id: fragmentId, source_content_hash: "sha256:source" }];

		const validation = generation.validateGenerationRecords(readyManifest, { [fragmentId]: record! }, rows);

		assert.equal(validation.valid, false);
		assert.match(validation.failures.join("\n"), /expected_count mismatch|searchable_coverage mismatch/);
		assert.throws(() => generation.assertGenerationReadyForActivation(readyManifest, validation), /generation validation failed for activation|generation does not have full searchable coverage/);
	});

	test("rejects corrupt multiview artifacts", async () => {
		const { manifest, record, fragmentId } = await createReadyMultiviewFixture("gen_c32_corrupt", "2026-08-07/frag_102");
		const sidecarPath = generation.generationMultiviewSidecarPath(manifest.generation_id, fragmentId);
		fs.writeFileSync(sidecarPath, "{not valid json\n", "utf8");
		const rows = [{ fragment_id: fragmentId, source_content_hash: "sha256:source" }];

		const validation = generation.validateGenerationRecords(manifest, { [fragmentId]: record! }, rows);

		assert.equal(validation.valid, false);
		assert.match(validation.failures.join("\n"), /multiview payload is missing or corrupt/);
		assert.deepEqual(validation.view_counts, { total: 0, summary: 0, evidence: 0 });
		assert.throws(() => generation.assertGenerationReadyForActivation(manifest, validation), /generation validation failed for activation/);
	});

	test("keeps legacy policy-less multiview state readable but blocks mutations", async () => {
		const { manifest, fragmentId } = await createReadyMultiviewFixture("gen_c32_legacy", "2026-08-07/frag_104");
		const legacy = { ...manifest, evidence_policy: null, evidence_policy_id: "evidence-gate-legacy" };
		generation.writeGenerationManifest(legacy);
		const persisted = generation.readGenerationManifest(legacy.generation_id)!;
		assert.equal(persisted.evidence_policy, null);
		assert.throws(() => generation.activateGeneration(persisted.generation_id), /validated evidence policy snapshot missing/);
		assert.equal(fs.existsSync(generation.activePointerPath()), false);
		assert.equal(fragmentId, "2026-08-07/frag_104");
	});

	test("treats an empty delta as safe and a populated delta as unsafe", async () => {
		const { manifest, fragmentId } = await createReadyMultiviewFixture("gen_c32_delta", "2026-08-07/frag_103");
		const readyManifest = generation.readGenerationManifest(manifest.generation_id)!;

		const emptyRisk = delta.getMigrationSwitchDeltaRisk();
		assert.equal(emptyRisk.has_delta, false);
		assert.equal(emptyRisk.safe, true);
		assert.equal(emptyRisk.reason, "no delta");
		assert.doesNotThrow(() => delta.assertMigrationSwitchDeltaSafe());

		generation.activateGeneration(readyManifest.generation_id);
		delta.resetDeltaForActiveGeneration();
		const deltaManifest = delta.ensureActiveDelta();
		delta.upsertDeltaViews(deltaManifest, fragmentId, "sha256:source", [
			view("summary", "summary", [0.5, 0.5]),
			view("evidence_001", "evidence", [0.25, 0.75]),
		]);

		const risk = delta.getMigrationSwitchDeltaRisk();
		assert.equal(risk.has_delta, true);
		assert.equal(risk.record_count, 1);
		assert.equal(risk.materialized_count, 1);
		assert.equal(risk.safe, false);
		assert.match(risk.reason, /delta has non-empty records: 1/);
		assert.throws(() => delta.assertMigrationSwitchDeltaSafe(), /delta has non-empty records: 1/);
		assert.equal(generation.validateGenerationRecords(readyManifest, generation.readGenerationIndex(readyManifest.generation_id), [{ fragment_id: fragmentId, source_content_hash: "sha256:source" }]).valid, true);
	});
});
