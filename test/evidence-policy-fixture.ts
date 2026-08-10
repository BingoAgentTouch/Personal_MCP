import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvidenceGatePolicySnapshot } from "../src/types.ts";
import { getTokenizerManifest } from "../src/embedding/builder.ts";
import { currentEvidencePolicyScope, evidencePolicyScopeHash } from "../src/embedding/evidence-policy.ts";
import { MODEL_ID } from "../src/embedding/provider.ts";

const HASH = `sha256:${"a".repeat(64)}`;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonical(child)]));
	}
	return value;
}

function sha256(value: unknown): string {
	return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

export async function validEvidencePolicy(threshold = 0.5): Promise<EvidenceGatePolicySnapshot> {
	const tokenizer = await getTokenizerManifest();
	return {
		policy_schema_version: 1,
		policy_id: "evidence-gate-test-v1",
		status: "validated",
		calibration_scope_hash: evidencePolicyScopeHash(
			currentEvidencePolicyScope(MODEL_ID, tokenizer.tokenizer_id),
		),
		calibration_artifact_hash: HASH,
		evidence_threshold: threshold,
		raw_similarity_mode: "fragment-max-view-v1",
		development_dataset_hash: `sha256:${"b".repeat(64)}`,
		holdout_dataset_hash: `sha256:${"c".repeat(64)}`,
	};
}

export async function writeValidatedEvidenceArtifact(filePath: string, threshold = 0.5): Promise<void> {
	const tokenizer = await getTokenizerManifest();
	const calibrationScope = currentEvidencePolicyScope(MODEL_ID, tokenizer.tokenizer_id);
	const artifact = {
		artifact_schema_version: 1,
		artifact_type: "multiview-evidence-gate-policy",
		status: "validated",
		policy_id: "evidence-gate-test-v1",
		calibration_scope: calibrationScope,
		calibration_scope_hash: evidencePolicyScopeHash(calibrationScope),
		evidence_threshold: threshold,
		raw_similarity_mode: "fragment-max-view-v1",
		development: { dataset_id: "test-development", dataset_hash: `sha256:${"b".repeat(64)}` },
		holdout: { dataset_id: "test-holdout", dataset_hash: `sha256:${"c".repeat(64)}` },
		artifact_hash: "",
	};
	const { artifact_hash: _ignored, ...body } = artifact;
	artifact.artifact_hash = sha256(body);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
