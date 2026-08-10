import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { EvidenceGatePolicySnapshot } from "../types.js";
import { DEFAULT_MULTIVIEW_POLICY, MULTIVIEW_AGGREGATION_MODE, MULTIVIEW_DOCUMENT_RECIPE_ID, MULTIVIEW_DOCUMENT_RECIPE_VERSION } from "./builder.js";

export interface EvidenceCalibrationArtifact {
	artifact_schema_version: 1;
	artifact_type: "multiview-evidence-gate-policy";
	status: "validated";
	policy_id: string;
	calibration_scope: EvidencePolicyScope;
	calibration_scope_hash: string;
	evidence_threshold: number;
	/** 渐进式披露（方案 B）：可选披露门下限；不参与 scope hash。 */
	disclosure_threshold?: number;
	raw_similarity_mode: "fragment-max-view-v1";
	development: { dataset_id: string; dataset_hash: string };
	holdout: { dataset_id: string; dataset_hash: string };
	artifact_hash: string;
}

export interface EvidencePolicyScope {
	model_id: string;
	tokenizer_id: string;
	document_recipe_id: string;
	document_recipe_version: number;
	multiview_policy: typeof DEFAULT_MULTIVIEW_POLICY;
	aggregation_mode: "fragment-max-view-v1";
	raw_similarity_mode: "fragment-max-view-v1";
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function currentEvidencePolicyScope(modelId: string, tokenizerId: string): EvidencePolicyScope {
	return {
		model_id: modelId,
		tokenizer_id: tokenizerId,
		document_recipe_id: MULTIVIEW_DOCUMENT_RECIPE_ID,
		document_recipe_version: MULTIVIEW_DOCUMENT_RECIPE_VERSION,
		multiview_policy: DEFAULT_MULTIVIEW_POLICY,
		aggregation_mode: MULTIVIEW_AGGREGATION_MODE,
		raw_similarity_mode: "fragment-max-view-v1",
	};
}

export function evidencePolicyScopeHash(scope: EvidencePolicyScope): string {
	return sha256(canonicalJson(scope));
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function assertValidatedEvidencePolicy(
	policy: EvidenceGatePolicySnapshot | null | undefined,
	expectedScope: EvidencePolicyScope,
): asserts policy is EvidenceGatePolicySnapshot {
	if (!policy || policy.policy_schema_version !== 1 || policy.status !== "validated") {
		throw new Error("validated evidence policy snapshot missing");
	}
	if (!policy.policy_id || !isSha256(policy.calibration_scope_hash) || !isSha256(policy.calibration_artifact_hash)) {
		throw new Error("validated evidence policy snapshot is incomplete");
	}
	if (
		!isSha256(policy.development_dataset_hash) ||
		!isSha256(policy.holdout_dataset_hash) ||
		!Number.isFinite(policy.evidence_threshold) ||
		policy.evidence_threshold < -1 ||
		policy.evidence_threshold > 1
	) {
		throw new Error("validated evidence policy snapshot is invalid");
	}
	if (policy.raw_similarity_mode !== "fragment-max-view-v1") {
		throw new Error("validated evidence policy snapshot mode mismatch");
	}
	if (policy.calibration_scope_hash !== evidencePolicyScopeHash(expectedScope)) {
		throw new Error("validated evidence policy snapshot scope mismatch");
	}
}

export function hasValidatedEvidencePolicy(
	policy: EvidenceGatePolicySnapshot | null | undefined,
	expectedScope: EvidencePolicyScope,
): policy is EvidenceGatePolicySnapshot {
	try {
		assertValidatedEvidencePolicy(policy, expectedScope);
		return true;
	} catch {
		return false;
	}
}

export function readValidatedEvidencePolicy(filePath: string, expectedScope: EvidencePolicyScope): EvidenceGatePolicySnapshot {
	const artifact = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvidenceCalibrationArtifact;
	if (artifact.artifact_schema_version !== 1 || artifact.artifact_type !== "multiview-evidence-gate-policy" || artifact.status !== "validated") {
		throw new Error("evidence policy artifact is not validated");
	}
	const { artifact_hash: storedHash, ...body } = artifact;
	if (storedHash !== sha256(canonicalJson({ ...body, artifact_hash: undefined }))) throw new Error("evidence policy artifact hash mismatch");
	const expectedScopeHash = evidencePolicyScopeHash(expectedScope);
	if (artifact.calibration_scope_hash !== expectedScopeHash || canonicalJson(artifact.calibration_scope) !== canonicalJson(expectedScope)) {
		throw new Error("evidence policy artifact scope mismatch");
	}
	if (!Number.isFinite(artifact.evidence_threshold) || artifact.evidence_threshold < -1 || artifact.evidence_threshold > 1) throw new Error("invalid evidence policy threshold");
	if (!artifact.policy_id || artifact.raw_similarity_mode !== "fragment-max-view-v1" || !artifact.development?.dataset_hash || !artifact.holdout?.dataset_hash) {
		throw new Error("evidence policy artifact is incomplete");
	}
	const policy: EvidenceGatePolicySnapshot = {
		policy_schema_version: 1,
		policy_id: artifact.policy_id,
		status: "validated",
		calibration_scope_hash: artifact.calibration_scope_hash,
		calibration_artifact_hash: artifact.artifact_hash,
		evidence_threshold: artifact.evidence_threshold,
		// 渐进式披露（方案 B）：可选披露门下限；artifact 未携带时检索侧用自适应式默认。
		...(artifact.disclosure_threshold !== undefined && Number.isFinite(artifact.disclosure_threshold)
			? { disclosure_threshold: artifact.disclosure_threshold as number }
			: {}),
		raw_similarity_mode: artifact.raw_similarity_mode,
		development_dataset_hash: artifact.development.dataset_hash,
		holdout_dataset_hash: artifact.holdout.dataset_hash,
	};
	assertValidatedEvidencePolicy(policy, expectedScope);
	return policy;
}
