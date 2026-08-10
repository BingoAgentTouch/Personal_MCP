import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildArtifact,
	buildCandidateArtifact,
	calibrateDataset,
	evaluateDataset,
	makeScope,
	readDataset,
	validateArtifact,
} from "../bench/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const development = readDataset(path.join(root, "bench", "datasets", "multiview-development-v1.json"));
const holdout = readDataset(path.join(root, "bench", "datasets", "multiview-holdout-v1.json"));

describe("fixture-only multiview evidence calibration", () => {
	test("selects the same feasible threshold deterministically", () => {
		const objectives = { max_fpr: 0, min_evidence_recall: 1 };
		const first = calibrateDataset(development, objectives, makeScope(development));
		const second = calibrateDataset(development, objectives, makeScope(development));
		assert.equal(first.selected?.threshold, 0.81);
		assert.deepEqual(first, second);
		assert.equal(first.selected?.evaluation.gate.fpr, 0);
		assert.equal(first.selected?.evaluation.gate.evidence_recall, 1);
	});

	test("returns a no-go when objectives have no feasible threshold", () => {
		const impossible = structuredClone(development);
		impossible.cases = [{
			case_id: "impossible-positive",
			expected_fragment_id: "fixture/positive",
			evidence_expected: true,
			placement: "middle",
			candidates: [
				{ fragment_id: "fixture/positive", single_score: 0.4, summary_score: 0.4, evidence_score: 0.8 },
			],
		}, {
			case_id: "impossible-negative",
			expected_fragment_id: "fixture/noise",
			evidence_expected: false,
			placement: "absent",
			candidates: [
				{ fragment_id: "fixture/noise", single_score: 0.4, summary_score: 0.4, evidence_score: 0.8 },
			],
		}];
		const result = calibrateDataset(impossible, { max_fpr: 0, min_evidence_recall: 1 }, makeScope(impossible));
		assert.equal(result.selected, null);
	});

	test("requires holdout success before producing a validated artifact", () => {
		const calibration = calibrateDataset(development, { max_fpr: 0, min_evidence_recall: 1 }, makeScope(development));
		const candidate = buildCandidateArtifact(calibration);
		const valid = validateArtifact(candidate, development, holdout, candidate.objectives);
		assert.equal(valid.valid, true);
		const artifact = buildArtifact(candidate, holdout, valid.evaluated);
		assert.equal(artifact.status, "validated");
		const rejected = validateArtifact(candidate, development, holdout, { max_fpr: 0, min_evidence_recall: 1.1 });
		assert.equal(rejected.valid, false);
	});

	test("reports calibrated, summary, and single-vector retrieval outcomes without memory I/O", () => {
		const report = evaluateDataset(development, 0.81);
		assert.equal(report.retrieval.query_count, development.cases.length);
		assert.equal(report.gate.fpr, 0);
		assert.equal(report.rows.every((row) => row.calibrated_top_fragment_id), true);
	});
});
