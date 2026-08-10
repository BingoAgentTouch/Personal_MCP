#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildArtifact,
	buildCandidateArtifact,
	calibrateDataset,
	evaluateDataset,
	makeScope,
	readDataset,
	readJson,
	validateArtifact,
	writeJson,
} from "./harness.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];
const options = new Map();
for (let index = 3; index < process.argv.length; index += 1) {
	if (process.argv[index].startsWith("--")) options.set(process.argv[index].slice(2), process.argv[++index] ?? "");
}

function optionPath(name, fallback) {
	return path.resolve(options.get(name) ?? fallback);
}
function numberOption(name, required = true) {
	const value = Number(options.get(name));
	if (required && !Number.isFinite(value)) throw new Error(`--${name} is required and must be numeric`);
	return value;
}
function usage() {
	throw new Error("Usage: node bench/run-multiview-eval.mjs evaluate|calibrate|validate [--development PATH] [--holdout PATH] [--artifact PATH] [--threshold N] [--max-fpr N] [--min-evidence-recall N] --output PATH");
}

if (!command || !["evaluate", "calibrate", "validate"].includes(command)) usage();
const developmentPath = optionPath("development", path.join(ROOT, "datasets", "multiview-development-v1.json"));
const holdoutPath = optionPath("holdout", path.join(ROOT, "datasets", "multiview-holdout-v1.json"));
const development = readDataset(developmentPath);
const holdout = readDataset(holdoutPath);

if (command === "evaluate") {
	const threshold = numberOption("threshold");
	const report = {
		report_schema_version: 1,
		report_type: "multiview-shadow-evaluation",
		development: { dataset_id: development.dataset_id, dataset_hash: development.content_hash, evaluation: evaluateDataset(development, threshold) },
		holdout: { dataset_id: holdout.dataset_id, dataset_hash: holdout.content_hash, evaluation: evaluateDataset(holdout, threshold) },
	};
	const output = writeJson(options.get("output"), report);
	console.log(JSON.stringify({ output, report_type: report.report_type, threshold }, null, 2));
} else if (command === "calibrate") {
	const objectives = { max_fpr: numberOption("max-fpr"), min_evidence_recall: numberOption("min-evidence-recall") };
	const calibration = calibrateDataset(development, objectives, makeScope(development));
	const candidateArtifact = calibration.selected ? buildCandidateArtifact(calibration) : null;
	const report = {
		report_schema_version: 1,
		report_type: "multiview-development-calibration",
		development: { dataset_id: development.dataset_id, dataset_hash: development.content_hash },
		...calibration,
		candidate_artifact: candidateArtifact,
		decision: calibration.selected ? "candidate" : "no_go",
	};
	const output = writeJson(options.get("output"), report);
	console.log(JSON.stringify({ output, decision: report.decision, threshold: calibration.selected?.threshold ?? null }, null, 2));
	if (!calibration.selected) process.exitCode = 1;
} else {
	const artifactPath = options.get("artifact");
	if (!artifactPath) throw new Error("--artifact is required for validate");
	const artifact = readJson(path.resolve(artifactPath));
	const objectives = {
		max_fpr: options.has("max-fpr") ? numberOption("max-fpr") : artifact.objectives?.max_fpr,
		min_evidence_recall: options.has("min-evidence-recall") ? numberOption("min-evidence-recall") : artifact.objectives?.min_evidence_recall,
	};
	const validation = validateArtifact(artifact, development, holdout, objectives);
	const report = {
		report_schema_version: 1,
		report_type: "multiview-holdout-validation",
		candidate_artifact_path: path.resolve(artifactPath),
		candidate_artifact_hash: artifact.artifact_hash,
		objectives: validation.objectives,
		holdout: { dataset_id: holdout.dataset_id, dataset_hash: holdout.content_hash, evaluation: validation.evaluated },
		decision: validation.valid ? "validated" : "no_go",
		validated_artifact: validation.valid ? buildArtifact(artifact, holdout, validation.evaluated) : null,
	};
	const output = writeJson(options.get("output"), report);
	console.log(JSON.stringify({ output, decision: report.decision, artifact_hash: report.validated_artifact?.artifact_hash ?? null }, null, 2));
	if (!validation.valid) process.exitCode = 1;
}
