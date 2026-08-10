import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, datasetHash, gateMetrics, rankOf, retrievalMetrics, sha256 } from "./metrics.mjs";

export function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readDataset(filePath) {
	const dataset = readJson(filePath);
	if (!dataset || dataset.schema_version !== 1 || !Array.isArray(dataset.cases) || typeof dataset.dataset_id !== "string") {
		throw new Error(`invalid multiview evaluation dataset: ${filePath}`);
	}
	const actual = datasetHash(dataset);
	if (dataset.content_hash !== actual) throw new Error(`dataset content hash mismatch: ${filePath}`);
	return dataset;
}

export function makeScope(dataset, config = {}) {
	return {
		model_id: config.model_id ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
		tokenizer_id: config.tokenizer_id ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
		document_recipe_id: config.document_recipe_id ?? "fragment-multiview-budgeted",
		document_recipe_version: config.document_recipe_version ?? 1,
		multiview_policy: config.multiview_policy ?? {
			evidence_window_tokens: 288,
			evidence_overlap_tokens: 48,
			disclosure_snippet_tokens: 80,
		},
		aggregation_mode: "fragment-max-view-v1",
		raw_similarity_mode: "fragment-max-view-v1",
	};
}

export function scopeHash(scope) {
	return sha256(canonicalJson(scope));
}

function sortResults(results) {
	return [...results].sort((left, right) => right.score - left.score || left.fragment_id.localeCompare(right.fragment_id));
}

export function scoreCase(item, threshold, mode = "calibrated") {
	const evidencePassed = item.evidence_score >= threshold;
	const score = mode === "single"
		? item.single_score
		: mode === "summary"
			? item.summary_score
			: Math.max(item.summary_score, evidencePassed ? item.evidence_score : Number.NEGATIVE_INFINITY);
	return { fragment_id: item.fragment_id, score, evidence_passed: evidencePassed };
}

export function evaluateDataset(dataset, threshold, topK = 3) {
	if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error("threshold must be a finite score in [-1, 1]");
	const rows = dataset.cases.map((caseItem) => {
		const calibrated = sortResults(caseItem.candidates.map((candidate) => scoreCase(candidate, threshold, "calibrated")));
		const summary = sortResults(caseItem.candidates.map((candidate) => scoreCase(candidate, threshold, "summary")));
		const single = sortResults(caseItem.candidates.map((candidate) => scoreCase(candidate, threshold, "single")));
		const expected = caseItem.expected_fragment_id;
		const expectedCandidate = caseItem.candidates.find((candidate) => candidate.fragment_id === expected);
		if (!expectedCandidate) throw new Error(`dataset case lacks expected candidate: ${caseItem.case_id}`);
		return {
			case_id: caseItem.case_id,
			evidence_expected: caseItem.evidence_expected,
			placement: caseItem.placement,
			rank: rankOf(calibrated, expected),
			summary_rank: rankOf(summary, expected),
			single_rank: rankOf(single, expected),
			evidence_score: expectedCandidate.evidence_score,
			evidence_passed: expectedCandidate.evidence_score >= threshold,
			calibrated_top_fragment_id: calibrated[0]?.fragment_id ?? null,
			summary_top_fragment_id: summary[0]?.fragment_id ?? null,
			single_top_fragment_id: single[0]?.fragment_id ?? null,
		};
	});
	const startedAt = performance.now();
	const retrieval = retrievalMetrics(rows, topK);
	const elapsedMs = performance.now() - startedAt;
	return {
		threshold,
		top_k: topK,
		rows,
		retrieval,
		gate: gateMetrics(rows),
		duplicate_fragment_rate: 0,
		vector_count: dataset.cases.reduce((sum, item) => sum + item.candidates.length * 2, 0),
		storage_vector_units: dataset.cases.reduce((sum, item) => sum + item.candidates.length * 2, 0),
		latency_ms: elapsedMs,
	};
}

export function candidateThresholds(dataset) {
	return [...new Set(dataset.cases.flatMap((item) => item.candidates.map((candidate) => candidate.evidence_score)))].sort((left, right) => left - right);
}

function stableEvaluation(evaluation) {
	const { latency_ms: _ignored, ...stable } = evaluation;
	return stable;
}

export function calibrateDataset(dataset, objectives, scope = makeScope(dataset)) {
	const maxFpr = Number(objectives.max_fpr);
	const minEvidenceRecall = Number(objectives.min_evidence_recall);
	if (!Number.isFinite(maxFpr) || maxFpr < 0 || maxFpr > 1) throw new Error("--max-fpr must be within [0, 1]");
	if (!Number.isFinite(minEvidenceRecall) || minEvidenceRecall < 0 || minEvidenceRecall > 1) throw new Error("--min-evidence-recall must be within [0, 1]");
	const candidates = candidateThresholds(dataset).map((threshold) => ({ threshold, evaluation: stableEvaluation(evaluateDataset(dataset, threshold)) }));
	const feasible = candidates.filter(({ evaluation }) => (evaluation.gate.fpr ?? 0) <= maxFpr && (evaluation.gate.evidence_recall ?? 0) >= minEvidenceRecall);
	const selected = [...feasible].sort((left, right) =>
		(right.evaluation.gate.evidence_recall ?? -1) - (left.evaluation.gate.evidence_recall ?? -1) ||
		(left.evaluation.gate.fpr ?? Infinity) - (right.evaluation.gate.fpr ?? Infinity) ||
		left.threshold - right.threshold,
	)[0] ?? null;
	return {
		dataset_id: dataset.dataset_id,
		dataset_hash: dataset.content_hash,
		scope,
		scope_hash: scopeHash(scope),
		objectives: { max_fpr: maxFpr, min_evidence_recall: minEvidenceRecall },
		candidate_count: candidates.length,
		selected,
	};
}

export function buildCandidateArtifact(calibration) {
	if (!calibration.selected) throw new Error("cannot build a candidate artifact without a feasible threshold");
	const artifact = {
		artifact_schema_version: 1,
		artifact_type: "multiview-evidence-gate-policy",
		status: "candidate",
		policy_id: `evidence-gate-${calibration.scope_hash.slice(7, 19)}-${String(calibration.selected.threshold).replace(".", "_")}`,
		calibration_scope: calibration.scope,
		calibration_scope_hash: calibration.scope_hash,
		evidence_threshold: calibration.selected.threshold,
		raw_similarity_mode: "fragment-max-view-v1",
		development: { dataset_id: calibration.dataset_id, dataset_hash: calibration.dataset_hash, metrics: calibration.selected.evaluation },
		holdout: null,
		objectives: calibration.objectives,
		artifact_hash: "",
	};
	artifact.artifact_hash = sha256(canonicalJson({ ...artifact, artifact_hash: undefined }));
	return artifact;
}

export function buildArtifact(candidate, holdout, holdoutEvaluation) {
	const artifact = {
		...candidate,
		status: "validated",
		holdout: { dataset_id: holdout.dataset_id, dataset_hash: holdout.content_hash, metrics: holdoutEvaluation },
		artifact_hash: "",
	};
	artifact.artifact_hash = sha256(canonicalJson({ ...artifact, artifact_hash: undefined }));
	return artifact;
}

export function validateArtifact(artifact, development, holdout, objectives) {
	if (!artifact || artifact.artifact_schema_version !== 1 || !["candidate", "validated"].includes(artifact.status)) throw new Error("unsupported calibration artifact");
	const expectedHash = sha256(canonicalJson({ ...artifact, artifact_hash: undefined }));
	if (artifact.artifact_hash !== expectedHash) throw new Error("calibration artifact hash mismatch");
	if (artifact.development?.dataset_hash !== development.content_hash) throw new Error("calibration artifact development dataset mismatch");
	const expectedScopeHash = scopeHash(makeScope(development));
	if (artifact.calibration_scope_hash !== expectedScopeHash) throw new Error("calibration artifact scope mismatch");
	const evaluated = evaluateDataset(holdout, artifact.evidence_threshold);
	const maxFpr = Number(objectives.max_fpr ?? artifact.objectives?.max_fpr);
	const minEvidenceRecall = Number(objectives.min_evidence_recall ?? artifact.objectives?.min_evidence_recall);
	if (!Number.isFinite(maxFpr) || !Number.isFinite(minEvidenceRecall)) throw new Error("validation objectives missing");
	const valid = (evaluated.gate.fpr ?? 0) <= maxFpr && (evaluated.gate.evidence_recall ?? 0) >= minEvidenceRecall;
	return { valid, evaluated, objectives: { max_fpr: maxFpr, min_evidence_recall: minEvidenceRecall } };
}

export function writeJson(outputPath, value) {
	if (!outputPath) throw new Error("--output is required");
	const resolved = path.resolve(outputPath);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return resolved;
}
