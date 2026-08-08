import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-multiview-c30-"));
process.chdir(tempRoot);

const generation = await import("../src/embedding/generation.ts");
const { validEvidencePolicy } = await import("./evidence-policy-fixture.ts");

function view(view_id: string, kind: "summary" | "evidence", vector: number[]) {
	return {
		view_id,
		kind,
		vector,
		input_hash: `sha256:${view_id}:input`,
		tokens: { used: 2, model_max: 512 },
		source_spans: [
			{
				source_field: kind === "summary" ? "result_desc" : "turns_text",
				start_char: 0,
				end_char: 2,
				start_token: 0,
				end_token: 2,
			},
		],
		disclosure: {
			disclosure_level: kind === "summary" ? "T1" : "T2",
			snippet: `${view_id} snippet`,
			snippet_token_count: 2,
			snippet_anchor: "view_fallback" as const,
		},
	};
}

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("multiview generation lifecycle", () => {
	beforeEach(() => {
		fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	});

	test("creates, writes, round-trips, and finalizes a multiview generation", async () => {
		const manifest = await generation.createGeneration("gen_mv_c30", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.setGenerationExpectedCount(manifest.generation_id, 1);

		const record = generation.writeGenerationViews(manifest, "2026-08-07/frag_300", "sha256:source", [
			view("summary", "summary", [0.5, 0.5]),
			view("evidence_001", "evidence", [0.25, 0.75]),
		]);

		assert.equal(record.state, "materialized");
		assert.equal(generation.readGenerationIndex(manifest.generation_id)["2026-08-07/frag_300"]?.state, "materialized");

		const roundTrip = generation.readGenerationMultiviewViews(
			manifest.generation_id,
			"2026-08-07/frag_300",
			generation.readGenerationIndex(manifest.generation_id)["2026-08-07/frag_300"],
			2,
		);
		assert.ok(roundTrip);
		assert.deepEqual(roundTrip?.map((entry) => entry.view_id), ["summary", "evidence_001"]);
		assert.deepEqual(roundTrip?.map((entry) => entry.vector), [[0.5, 0.5], [0.25, 0.75]]);

		const finalized = generation.finalizeGeneration(manifest.generation_id);
		assert.equal(finalized.state, "ready");
		assert.equal(finalized.expected_count, 1);
		assert.equal(finalized.materialized_count, 1);
		assert.equal(finalized.failed_count, 0);
	});

	test("rejects invalid multiview views without leaving fragment files behind", async () => {
		const manifest = await generation.createGeneration("gen_mv_c30_invalid", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.setGenerationExpectedCount(manifest.generation_id, 1);

		assert.throws(
			() => generation.writeGenerationViews(manifest, "2026-08-07/frag_301", "sha256:source", [
				view("evidence_001", "evidence", [0.25, 0.75]),
			]),
			/exactly one summary view/,
		);

		assert.equal(fs.existsSync(generation.generationMultiviewSidecarPath(manifest.generation_id, "2026-08-07/frag_301")), false);
		assert.equal(generation.readGenerationIndex(manifest.generation_id)["2026-08-07/frag_301"], undefined);
	});

	test("returns null for a corrupt multiview sidecar", async () => {
		const manifest = await generation.createGeneration("gen_mv_c30_corrupt", "sha256:inventory", 2, "multiview", await validEvidencePolicy());
		generation.setGenerationExpectedCount(manifest.generation_id, 1);
		generation.writeGenerationViews(manifest, "2026-08-07/frag_302", "sha256:source", [
			view("summary", "summary", [0.5, 0.5]),
			view("evidence_001", "evidence", [0.25, 0.75]),
		]);

		const sidecarPath = generation.generationMultiviewSidecarPath(manifest.generation_id, "2026-08-07/frag_302");
		fs.writeFileSync(sidecarPath, "{not valid json\n", "utf8");

		const record = generation.readGenerationIndex(manifest.generation_id)["2026-08-07/frag_302"];
		assert.equal(generation.readGenerationMultiviewViews(manifest.generation_id, "2026-08-07/frag_302", record, 2), null);
	});
});
