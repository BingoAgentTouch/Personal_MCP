import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const analyzer = await import("../analyze_signals.mjs");

function writeSignals(searches: unknown[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-epoch-"));
	const signals = path.join(root, "signals");
	fs.mkdirSync(signals, { recursive: true });
	fs.writeFileSync(path.join(signals, "search.jsonl"), `${searches.map((item) => JSON.stringify(item)).join("\n")}\n`);
	fs.writeFileSync(path.join(signals, "get_fragment.jsonl"), "");
	return root;
}

function report(root: string) {
	return analyzer.run(["--memory-root", root, "--report", path.join(root, "report.json"), "--dry-run", "--dry-run-report", path.join(root, "dry.json")]);
}

const result = { fragment_id: "2026-08-04/frag_001", rank: 1, raw_similarity: 0.6, weight: 0.5, score: 0.3, matched_view: "evidence_001" };

describe("epoch-aware search signals", () => {
	test("keeps legacy and versioned observations in separate episode groups", () => {
		const root = writeSignals([
			{ ts: "2026-08-04T10:00:00.000Z", query: "legacy", agent_id: "a", results: [result] },
			{ signal_schema_version: 2, ts: "2026-08-04T10:01:00.000Z", query: "multiview", agent_id: "a", generation_id: "gen_mv", representation_identity_hash: "sha256:identity", retrieval_epoch: "fragment-multiview-v1", raw_similarity_mode: "fragment-max-view-v1", results: [result] },
		]);
		try {
			const reports = report(root);
			assert.equal(reports.phase0.observation_groups.length, 2);
			assert.equal(reports.phase0.episodes.length, 2);
			assert.equal(reports.dryRun.records.length, 0);
			assert.equal(reports.dryRun.counts.mixed_observations_blocked, true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("permits a single versioned observation group in dry-run", () => {
		const root = writeSignals([
			{ signal_schema_version: 2, ts: "2026-08-04T10:00:00.000Z", query: "first", agent_id: "a", generation_id: "gen_mv", representation_identity_hash: "sha256:identity", retrieval_epoch: "fragment-multiview-v1", raw_similarity_mode: "fragment-max-view-v1", results: [result] },
			{ signal_schema_version: 2, ts: "2026-08-04T10:01:00.000Z", query: "second", agent_id: "a", generation_id: "gen_mv", representation_identity_hash: "sha256:identity", retrieval_epoch: "fragment-multiview-v1", raw_similarity_mode: "fragment-max-view-v1", results: [result] },
		]);
		try {
			const reports = report(root);
			assert.equal(reports.dryRun.observation_group.key.includes("fragment-max-view-v1"), true);
			assert.equal(reports.dryRun.counts.mixed_observations_blocked, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
