import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
	ActiveEmbeddingPointer,
	EmbeddingGenerationManifest,
	EmbeddingGenerationRecord,
	EvidenceGatePolicySnapshot,
	EmbeddingMaterializedView,
	EmbeddingSourceSpan,
	EmbeddingViewDisclosure,
} from "../types.js";
import type { EffectiveMultiviewView } from "./delta.js";
import { embeddingModelId, embeddingNormalize, embeddingPooling, embeddingQuantized, embeddingRuntimeIdentity, getEmbeddingDimension } from "./provider.js";
import {
	MULTIVIEW_AGGREGATION_MODE,
	MULTIVIEW_DOCUMENT_RECIPE_ID,
	MULTIVIEW_DOCUMENT_RECIPE_VERSION,
	MULTIVIEW_POLICY_VERSION,
	MULTIVIEW_RETRIEVAL_EPOCH,
	DEFAULT_MULTIVIEW_POLICY,
	DOCUMENT_RECIPE_ID,
	DOCUMENT_RECIPE_VERSION,
	QUERY_RECIPE_ID,
	QUERY_RECIPE_VERSION,
	getTokenizerManifest,
} from "./builder.js";
import { assertValidatedEvidencePolicy, currentEvidencePolicyScope } from "./evidence-policy.js";

const MEMORY_BASE = path.resolve("memory");
const GENERATIONS_BASE = path.join(MEMORY_BASE, "embedding_generations");
const ACTIVE_POINTER_PATH = path.join(MEMORY_BASE, "embedding_active.json");

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function hashBytes(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonicalize(item)]),
		);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function manifestHash(manifest: Omit<EmbeddingGenerationManifest, "manifest_content_hash">): string {
	return hashBytes(canonicalJson(manifest));
}

function generationDir(generationId: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(generationId)) throw new Error(`invalid generation id: ${generationId}`);
	return path.join(GENERATIONS_BASE, generationId);
}

export function representationKind(manifest: Pick<EmbeddingGenerationManifest, "representation_kind" | "document_recipe_id">): "single" | "multiview" {
	if (manifest.representation_kind === "multiview" || manifest.document_recipe_id === MULTIVIEW_DOCUMENT_RECIPE_ID) return "multiview";
	return "single";
}

export function isMultiviewGeneration(manifest: Pick<EmbeddingGenerationManifest, "representation_kind" | "document_recipe_id">): boolean {
	return representationKind(manifest) === "multiview";
}

function parseFragmentId(fragmentId: string): [string, string] {
	const [date, id, extra] = fragmentId.split("/");
	if (!date || !id || extra || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^frag_\d+$/.test(id)) {
		throw new Error(`invalid fragment id: ${fragmentId}`);
	}
	return [date, id];
}

export function activePointerPath(): string {
	return ACTIVE_POINTER_PATH;
}

export function generationManifestPath(generationId: string): string {
	return path.join(generationDir(generationId), "manifest.json");
}

export function generationIndexPath(generationId: string): string {
	return path.join(generationDir(generationId), "generation_index.json");
}

export function generationVectorPath(generationId: string, fragmentId: string): string {
	const [date, id] = parseFragmentId(fragmentId);
	return path.join(generationDir(generationId), "vectors", date, `${id}.embedding`);
}

export function generationMultiviewSidecarPath(generationId: string, fragmentId: string): string {
	const [date, id] = parseFragmentId(fragmentId);
	return path.join(generationDir(generationId), "vectors", date, id, "views.json");
}

/** O3：multiview 视图向量二进制文件（view_schema_version=2 的 sidecar 配套，Float32Array 按 view_id 排序拼接）。 */
export function generationMultiviewVectorsBinPath(generationId: string, fragmentId: string): string {
	const [date, id] = parseFragmentId(fragmentId);
	return path.join(generationDir(generationId), "vectors", date, id, "vectors.bin");
}

function atomicWrite(filePath: string, content: string): void {
	ensureDir(path.dirname(filePath));
	const tempPath = `${filePath}.tmp`;
	fs.writeFileSync(tempPath, content, "utf8");
	fs.renameSync(tempPath, filePath);
}

let generationTransactionSequence = 0;

function nextGenerationTransactionId(): string {
	generationTransactionSequence += 1;
	return `multiview-${Date.now()}-${process.pid}-${generationTransactionSequence}`;
}

function generationTransactionRoot(generationId: string, operationId: string): string {
	return path.join(generationDir(generationId), "transactions", operationId);
}

function removeIfExists(filePath: string): void {
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

interface GenerationTransactionTarget {
	livePath: string;
	stagedPath: string;
	originalContent: string | Buffer | null;
}

function writeGenerationTransactionState(
	transactionRoot: string,
	state: string,
	targets: GenerationTransactionTarget[],
): void {
	ensureDir(transactionRoot);
	fs.writeFileSync(
		path.join(transactionRoot, "transaction.json"),
		`${JSON.stringify({ state, targets: targets.map(({ livePath, stagedPath, originalContent }) => ({ livePath, stagedPath, existed: originalContent !== null })) }, null, 2)}\n`,
		"utf8",
	);
}

function rollbackGenerationTransaction(targets: GenerationTransactionTarget[]): void {
	for (const target of [...targets].reverse()) {
		removeIfExists(target.livePath);
		if (target.originalContent !== null) {
			ensureDir(path.dirname(target.livePath));
			// O3：Buffer（向量二进制）不带 utf8 编码写回，避免破坏二进制内容
			fs.writeFileSync(target.livePath, target.originalContent, Buffer.isBuffer(target.originalContent) ? undefined : "utf8");
		}
	}
}

function commitGenerationFragmentFiles(
	generationId: string,
	fragmentId: string,
	contents: Array<{ livePath: string; content: string | Buffer }>,
): void {
	const transactionRoot = generationTransactionRoot(generationId, nextGenerationTransactionId());
	const targets: GenerationTransactionTarget[] = contents.map(({ livePath }, index) => ({
		livePath,
		stagedPath: path.join(transactionRoot, "staged", `${index}.tmp`),
		// O3：向量二进制文件（Buffer）原样保留；文本文件 utf8 读（兼容 string）
		originalContent: fs.existsSync(livePath) ? fs.readFileSync(livePath) : null,
	}));
	try {
		ensureDir(path.join(transactionRoot, "staged"));
		writeGenerationTransactionState(transactionRoot, "prepared", targets);
		for (let index = 0; index < contents.length; index += 1) {
			fs.writeFileSync(targets[index].stagedPath, contents[index].content, "utf8");
		}
		writeGenerationTransactionState(transactionRoot, "committing", targets);
		for (const target of targets) {
			removeIfExists(target.livePath);
			ensureDir(path.dirname(target.livePath));
			fs.renameSync(target.stagedPath, target.livePath);
		}
		writeGenerationTransactionState(transactionRoot, "completed", targets);
		fs.rmSync(transactionRoot, { recursive: true, force: true });
	} catch (error) {
		try {
			rollbackGenerationTransaction(targets);
			fs.rmSync(transactionRoot, { recursive: true, force: true });
		} catch (rollbackError) {
			try {
				writeGenerationTransactionState(transactionRoot, "rollback_failed", targets);
			} catch {
				// Preserve the transaction directory even if its state marker cannot be updated.
			}
			throw new Error(
				`multiview generation transaction failed for ${generationId}/${fragmentId}: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		throw error;
	}
}

function viewSetHash(views: EmbeddingMaterializedView[]): string {
	return hashBytes(canonicalJson(views));
}

function readJsonVector(filePath: string): number[] | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : null;
	} catch {
		return null;
	}
}

function coverageEquals(left: number, right: number): boolean {
	return Math.abs(left - right) <= Number.EPSILON;
}

export function assertMultiviewGenerationPolicy(manifest: EmbeddingGenerationManifest): void {
	if (!isMultiviewGeneration(manifest)) return;
	if (manifest.view_schema_version !== 1 && manifest.view_schema_version !== 2) throw new Error(`multiview view schema mismatch: ${manifest.generation_id}`); // O3：冻结 v2，兼容 v1 旧库
	if (manifest.document_policy_version !== MULTIVIEW_POLICY_VERSION) throw new Error(`multiview document policy mismatch: ${manifest.generation_id}`);
	if (!manifest.multiview_policy) throw new Error(`multiview policy missing: ${manifest.generation_id}`);
	if (manifest.aggregation_mode !== MULTIVIEW_AGGREGATION_MODE) throw new Error(`multiview aggregation mismatch: ${manifest.generation_id}`);
	if (manifest.retrieval_epoch !== MULTIVIEW_RETRIEVAL_EPOCH) throw new Error(`multiview retrieval epoch mismatch: ${manifest.generation_id}`);
	if (manifest.document_recipe_id !== MULTIVIEW_DOCUMENT_RECIPE_ID || manifest.document_recipe_version !== MULTIVIEW_DOCUMENT_RECIPE_VERSION) {
		throw new Error(`multiview document recipe mismatch: ${manifest.generation_id}`);
	}
	assertValidatedEvidencePolicy(
		manifest.evidence_policy,
		currentEvidencePolicyScope(manifest.embedding_model_id, manifest.tokenizer_id),
	);
	if (manifest.evidence_policy_id !== manifest.evidence_policy.policy_id) {
		throw new Error(`multiview evidence policy snapshot mismatch: ${manifest.generation_id}`);
	}
}

function validateGenerationMultiviewManifest(manifest: EmbeddingGenerationManifest): void {
	if (!isMultiviewGeneration(manifest)) {
		throw new Error(`multiview generation write requires multiview generation: ${manifest.generation_id}`);
	}
	assertMultiviewGenerationPolicy(manifest);
}

export interface MaterializedGenerationView {
	view_id: string;
	kind: "summary" | "evidence";
	vector: number[];
	input_hash: string;
	tokens: Record<string, unknown>;
	source_spans: EmbeddingSourceSpan[];
	disclosure: EmbeddingViewDisclosure;
}

export interface GenerationValidationRow {
	fragment_id: string;
	source_content_hash: string;
}

export interface GenerationDiagnosticViewCounts {
	total: number;
	summary: number;
	evidence: number;
}

export interface GenerationValidationResult {
	generation_id: string;
	representation_kind: "single" | "multiview";
	valid: boolean;
	failures: string[];
	expected_count: number;
	materialized_count: number;
	failed_count: number;
	searchable_coverage: number;
	source_inventory_hash: string;
	live_inventory_hash?: string;
	view_counts?: GenerationDiagnosticViewCounts;
}

export function readGenerationManifest(generationId: string): EmbeddingGenerationManifest | null {
	const filePath = generationManifestPath(generationId);
	if (!fs.existsSync(filePath)) return null;
	const manifest = JSON.parse(fs.readFileSync(filePath, "utf8")) as EmbeddingGenerationManifest;
	const { manifest_content_hash: storedHash, ...payload } = manifest;
	if (storedHash !== manifestHash(payload)) throw new Error(`generation manifest hash mismatch: ${generationId}`);
	if (manifest.generation_id !== generationId) throw new Error(`generation id mismatch: ${generationId}`);
	return manifest;
}

export function writeGenerationManifest(manifest: EmbeddingGenerationManifest): void {
	const { manifest_content_hash: _ignored, ...payload } = manifest;
	const complete = { ...manifest, manifest_content_hash: manifestHash(payload) };
	atomicWrite(generationManifestPath(manifest.generation_id), `${JSON.stringify(complete, null, 2)}\n`);
}

export function readActivePointer(): ActiveEmbeddingPointer | null {
	if (!fs.existsSync(ACTIVE_POINTER_PATH)) return null;
	return JSON.parse(fs.readFileSync(ACTIVE_POINTER_PATH, "utf8")) as ActiveEmbeddingPointer;
}

export function activePointerSnapshotHash(pointer: ActiveEmbeddingPointer): string {
	return hashBytes(canonicalJson(pointer));
}

export function assertActivePointerSnapshot(pointer: ActiveEmbeddingPointer): void {
	if (pointer.pointer_schema_version !== 1) throw new Error(`unsupported active pointer schema: ${pointer.pointer_schema_version}`);
	if (!/^[A-Za-z0-9._-]+$/.test(pointer.active_generation_id)) throw new Error(`invalid active pointer generation id: ${pointer.active_generation_id}`);
	const manifest = readGenerationManifest(pointer.active_generation_id);
	if (!manifest) throw new Error(`pointer generation missing: ${pointer.active_generation_id}`);
	if (manifest.manifest_content_hash !== pointer.active_manifest_hash) throw new Error(`pointer manifest hash mismatch: ${pointer.active_generation_id}`);
	if (manifest.state !== "ready" && manifest.state !== "active") throw new Error(`pointer generation is not activatable: ${pointer.active_generation_id}`);
}

export function serializeActivePointerSnapshot(pointer: ActiveEmbeddingPointer): string {
	assertActivePointerSnapshot(pointer);
	return `${JSON.stringify(pointer, null, 2)}\n`;
}

export function getActiveGeneration(): EmbeddingGenerationManifest | null {
	const pointer = readActivePointer();
	if (!pointer) return null;
	const manifest = readGenerationManifest(pointer.active_generation_id);
	if (!manifest) throw new Error(`active generation manifest missing: ${pointer.active_generation_id}`);
	if (manifest.state !== "ready" && manifest.state !== "active") throw new Error(`active generation is not ready: ${manifest.generation_id}`);
	if (manifest.manifest_content_hash !== pointer.active_manifest_hash) throw new Error("active pointer manifest hash mismatch");
	return manifest;
}

export async function createGeneration(
	generationId: string,
	sourceInventoryHash: string,
	dimension?: number,
	representationKind?: "single",
): Promise<EmbeddingGenerationManifest>;
export async function createGeneration(
	generationId: string,
	sourceInventoryHash: string,
	dimension: number | undefined,
	representationKind: "multiview",
	evidencePolicy: EvidenceGatePolicySnapshot,
): Promise<EmbeddingGenerationManifest>;
export async function createGeneration(
	generationId: string,
	sourceInventoryHash: string,
	dimension?: number,
	representationKind: "single" | "multiview" = "single",
	evidencePolicy: EvidenceGatePolicySnapshot | null = null,
): Promise<EmbeddingGenerationManifest> {
	if (readGenerationManifest(generationId)) throw new Error(`generation already exists: ${generationId}`);
	const resolvedDimension = dimension ?? await getEmbeddingDimension();
	const tokenizer = await getTokenizerManifest();
	const isMultiview = representationKind === "multiview";
	if (isMultiview) {
		assertValidatedEvidencePolicy(evidencePolicy, currentEvidencePolicyScope(embeddingModelId(), tokenizer.tokenizer_id));
	}
	const manifest: EmbeddingGenerationManifest = {
		manifest_schema_version: 2,
		generation_id: generationId,
		state: "building",
		representation_kind: representationKind,
		document_policy_version: isMultiview ? MULTIVIEW_POLICY_VERSION : null,
		multiview_policy: isMultiview ? DEFAULT_MULTIVIEW_POLICY : null,
		view_schema_version: isMultiview ? 2 : null,  // O3：冻结 v2（sidecar 双格式兼容已就绪，读兼容 v1/v2）
		aggregation_mode: isMultiview ? MULTIVIEW_AGGREGATION_MODE : "fragment-single-vector-v1",
		evidence_policy_id: isMultiview ? evidencePolicy!.policy_id : null,
		evidence_policy: isMultiview ? evidencePolicy! : null,
		retrieval_epoch: isMultiview ? MULTIVIEW_RETRIEVAL_EPOCH : "fragment-single-vector-v1",
		document_recipe_id: isMultiview ? MULTIVIEW_DOCUMENT_RECIPE_ID : DOCUMENT_RECIPE_ID,
		document_recipe_version: isMultiview ? MULTIVIEW_DOCUMENT_RECIPE_VERSION : DOCUMENT_RECIPE_VERSION,
		query_recipe_id: QUERY_RECIPE_ID,
		query_recipe_version: QUERY_RECIPE_VERSION,
		embedding_model_id: embeddingModelId(),
		embedding_model_revision: null,
		tokenizer_id: tokenizer.tokenizer_id,
		tokenizer_revision: tokenizer.tokenizer_revision,
		runtime_identity: embeddingRuntimeIdentity(),
		pooling: embeddingPooling(),
		normalize: embeddingNormalize(),
		quantized: embeddingQuantized(),
		dimension: resolvedDimension,
		model_max_length: tokenizer.model_max_length,
		special_token_reserve: tokenizer.special_token_reserve,
		source_schema_version: 1,
		source_inventory_hash: sourceInventoryHash,
		representation_identity_hash: "",
		manifest_content_hash: "",
		expected_count: 0,
		materialized_count: 0,
		failed_count: 0,
		searchable_coverage: 0,
	};
	manifest.representation_identity_hash = hashBytes(canonicalJson({
		representation_kind: manifest.representation_kind,
		document_policy_version: manifest.document_policy_version,
		multiview_policy: manifest.multiview_policy,
		view_schema_version: manifest.view_schema_version,
		aggregation_mode: manifest.aggregation_mode,
		evidence_policy_id: manifest.evidence_policy_id,
		evidence_policy: manifest.evidence_policy,
		retrieval_epoch: manifest.retrieval_epoch,
		document_recipe_id: manifest.document_recipe_id,
		document_recipe_version: manifest.document_recipe_version,
		query_recipe_id: manifest.query_recipe_id,
		query_recipe_version: manifest.query_recipe_version,
		embedding_model_id: manifest.embedding_model_id,
		tokenizer_id: manifest.tokenizer_id,
		runtime_identity: manifest.runtime_identity,
		pooling: manifest.pooling,
		normalize: manifest.normalize,
		quantized: manifest.quantized,
		dimension: manifest.dimension,
		model_max_length: manifest.model_max_length,
		special_token_reserve: manifest.special_token_reserve,
	}));
	writeGenerationManifest(manifest);
	atomicWrite(generationIndexPath(generationId), "{}\n");
	return readGenerationManifest(generationId)!;
}

export function readGenerationIndex(generationId: string): Record<string, EmbeddingGenerationRecord> {
	const filePath = generationIndexPath(generationId);
	if (!fs.existsSync(filePath)) return {};
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, EmbeddingGenerationRecord>;
}

export function writeGenerationVector(
	manifest: EmbeddingGenerationManifest,
	fragmentId: string,
	vector: number[],
	record: Omit<EmbeddingGenerationRecord, "fragment_id" | "generation_id" | "vector_hash" | "dimension" | "state">,
): EmbeddingGenerationRecord {
	if (isMultiviewGeneration(manifest)) throw new Error(`single-view vector write is not allowed for multiview generation: ${manifest.generation_id}`);
	if (manifest.state !== "building") throw new Error(`generation is not writable: ${manifest.generation_id}`);
	if (vector.length !== manifest.dimension || vector.some((value) => !Number.isFinite(value))) {
		throw new Error(`invalid vector for ${fragmentId}`);
	}
	const filePath = generationVectorPath(manifest.generation_id, fragmentId);
	const bytes = JSON.stringify(vector);
	atomicWrite(filePath, bytes);
	const output: EmbeddingGenerationRecord = {
		...record,
		fragment_id: fragmentId,
		generation_id: manifest.generation_id,
		vector_hash: hashBytes(bytes),
		dimension: vector.length,
		state: "materialized",
	};
	const index = readGenerationIndex(manifest.generation_id);
	index[fragmentId] = output;
	atomicWrite(generationIndexPath(manifest.generation_id), `${JSON.stringify(index, null, 2)}\n`);
	return output;
}

export function writeGenerationViews(
	manifest: EmbeddingGenerationManifest,
	fragmentId: string,
	sourceHash: string,
	views: MaterializedGenerationView[],
): EmbeddingGenerationRecord {
	validateGenerationMultiviewManifest(manifest);
	if (manifest.state !== "building") throw new Error(`generation is not writable: ${manifest.generation_id}`);
	if (!views.length) throw new Error(`multiview materialization requires views for ${fragmentId}`);
	const summaryViews = views.filter((view) => view.kind === "summary");
	if (summaryViews.length !== 1) throw new Error(`multiview materialization requires exactly one summary view for ${fragmentId}`);
	const ids = new Set<string>();
	const materialized: EmbeddingMaterializedView[] = [];
	// O3：向量写入前 float32 round-trip（vectors.bin 按 Float32 存储，round-trip 保证读回值与写时一致，full 校验 hash 匹配）
	const normalizedViews = views.map((view) => ({ ...view, vector: Array.from(new Float32Array(view.vector)) }));
	for (const view of normalizedViews) {
		if (!view.view_id || !/^[A-Za-z0-9._-]+$/.test(view.view_id)) throw new Error(`invalid multiview id: ${fragmentId}/${view.view_id}`);
		if (ids.has(view.view_id)) throw new Error(`duplicate multiview id: ${fragmentId}/${view.view_id}`);
		ids.add(view.view_id);
		if (view.vector.length !== manifest.dimension || view.vector.some((value) => !Number.isFinite(value))) {
			throw new Error(`invalid multiview vector: ${fragmentId}/${view.view_id}`);
		}
		const bytes = JSON.stringify(view.vector);
		materialized.push({
			view_id: view.view_id,
			kind: view.kind,
			input_hash: view.input_hash,
			vector_hash: hashBytes(bytes),
			vector_dimension: view.vector.length,
			tokens: view.tokens,
			source_spans: view.source_spans,
			disclosure: view.disclosure,
		});
	}
	const summary = summaryViews[0];
	const normalizedSummary = normalizedViews.find((view) => view.view_id === summary.view_id)!;
	const summaryBytes = JSON.stringify(normalizedSummary.vector);
	// O3 v2 sidecar：views 值存元数据（JSON），向量移入 vectors.bin（Float32Array 按 view_id 排序拼接）
	const sidecar = {
		view_schema_version: 2,
		fragment_id: fragmentId,
		source_content_hash: sourceHash,
		views: Object.fromEntries(materialized.map((view) => [view.view_id, {
			kind: view.kind,
			input_hash: view.input_hash,
			vector_hash: view.vector_hash,
			vector_dimension: view.vector_dimension,
			tokens: view.tokens,
			source_spans: view.source_spans,
			disclosure: view.disclosure,
		}])),
	};
	const orderedViews = [...normalizedViews].sort((left, right) => left.view_id.localeCompare(right.view_id));
	const bin = new Float32Array(orderedViews.length * manifest.dimension);
	orderedViews.forEach((view, index) => bin.set(view.vector, index * manifest.dimension));
	const binBuffer = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
	const record: EmbeddingGenerationRecord = {
		fragment_id: fragmentId,
		generation_id: manifest.generation_id,
		view_id: summary.view_id,
		view_kind: summary.kind,
		source_spans: summary.source_spans,
		disclosure: summary.disclosure,
		views: materialized,
		view_set_hash: viewSetHash(materialized),
		source_content_hash: sourceHash,
		input_hash: summary.input_hash,
		vector_hash: hashBytes(summaryBytes),
		dimension: summary.vector.length,
		tokens: summary.tokens,
		state: "materialized",
	};
	const nextIndex = { ...readGenerationIndex(manifest.generation_id), [fragmentId]: record };
	commitGenerationFragmentFiles(manifest.generation_id, fragmentId, [
		{ livePath: generationMultiviewSidecarPath(manifest.generation_id, fragmentId), content: `${JSON.stringify(sidecar, null, 2)}\n` },
		{ livePath: generationMultiviewVectorsBinPath(manifest.generation_id, fragmentId), content: binBuffer },
		{ livePath: generationVectorPath(manifest.generation_id, fragmentId), content: summaryBytes },
		{ livePath: generationIndexPath(manifest.generation_id), content: `${JSON.stringify(nextIndex, null, 2)}\n` },
	]);
	return record;
}

export function readGenerationMultiviewViews(
	generationId: string,
	fragmentId: string,
	record: EmbeddingGenerationRecord | undefined,
	dimension: number,
	audit: "full" | "light" = "full",
): EffectiveMultiviewView[] | null {
	if (!record || record.state !== "materialized" || !record.views?.length) return null;
	if (record.views.filter((view) => view.kind === "summary").length !== 1) return null;
	if (record.view_kind !== "summary" || !record.view_id) return null;
	if (record.dimension !== dimension) return null;
	if (record.view_set_hash !== viewSetHash(record.views)) return null;
	const summaryVector = readJsonVector(generationVectorPath(generationId, fragmentId));
	if (!summaryVector || summaryVector.length !== dimension) return null;
	if (!fs.existsSync(generationMultiviewSidecarPath(generationId, fragmentId))) return null;
	try {
		const sidecar = JSON.parse(fs.readFileSync(generationMultiviewSidecarPath(generationId, fragmentId), "utf8")) as {
			view_schema_version?: number;
			fragment_id?: string;
			source_content_hash?: string;
			views?: Record<string, unknown>;
		};
		if ((sidecar.view_schema_version !== 1 && sidecar.view_schema_version !== 2) || sidecar.fragment_id !== fragmentId || sidecar.source_content_hash !== record.source_content_hash || !sidecar.views) return null;
		const viewIds = record.views.map((view) => view.view_id).sort();
		const sidecarIds = Object.keys(sidecar.views).sort();
		if (JSON.stringify(viewIds) !== JSON.stringify(sidecarIds)) return null;
		// O3：v2 格式向量从 vectors.bin（Float32Array 按 view_id 排序拼接）读取；v1 格式向量内联在 views 值里
		let binFloats: Float32Array | null = null;
		if (sidecar.view_schema_version === 2) {
			const binPath = generationMultiviewVectorsBinPath(generationId, fragmentId);
			if (!fs.existsSync(binPath)) return null;
			const binBuffer = fs.readFileSync(binPath);
			if (binBuffer.byteLength % (dimension * 4) !== 0) return null;
			binFloats = new Float32Array(binBuffer.buffer, binBuffer.byteOffset, binBuffer.byteLength / 4);
			if (sidecarIds.length * dimension !== binFloats.length) return null;
		}
		const result: EffectiveMultiviewView[] = [];
		for (const view of record.views) {
			let vector: number[];
			if (sidecar.view_schema_version === 2) {
				const meta = sidecar.views[view.view_id];
				if (!meta || typeof meta !== "object") return null;
				const index = sidecarIds.indexOf(view.view_id);
				vector = Array.from(binFloats!.subarray(index * dimension, (index + 1) * dimension));
			} else {
				const inline = sidecar.views[view.view_id];
				if (!Array.isArray(inline) || inline.length !== dimension) return null;
				vector = inline as number[];
			}
			if (vector.length !== dimension || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
			// O1 轻量签名：检索热路径（audit="light"）跳过逐视图向量 sha256 重算与 summary 全字段核对（最贵项）；
			// 完整审计（audit="full"，migrate validate / CI）保留全量校验。维度/结构校验两者都保留。
			if (audit === "full") {
				const vectorHash = hashBytes(JSON.stringify(vector));
				if (vectorHash !== view.vector_hash || view.vector_dimension !== dimension) return null;
				if (view.kind === "summary") {
					if (
						view.view_id !== record.view_id ||
						record.input_hash !== view.input_hash ||
						record.vector_hash !== view.vector_hash ||
						JSON.stringify(vector) !== JSON.stringify(summaryVector) ||
						canonicalJson(view.source_spans) !== canonicalJson(record.source_spans) ||
						canonicalJson(view.disclosure) !== canonicalJson(record.disclosure) ||
						canonicalJson(view.tokens) !== canonicalJson(record.tokens)
					) return null;
				}
			}
			result.push({
				fragment_id: fragmentId,
				view_id: view.view_id,
				kind: view.kind,
				vector,
				input_hash: view.input_hash,
				vector_hash: view.vector_hash,
				vector_dimension: view.vector_dimension,
				source_spans: view.source_spans,
				disclosure: view.disclosure,
			});
		}
		return result;
	} catch {
		return null;
	}
}

export function validateGenerationRecords(
	manifest: EmbeddingGenerationManifest,
	index: Record<string, EmbeddingGenerationRecord>,
	rows: GenerationValidationRow[],
	liveInventoryHash?: string,
): GenerationValidationResult {
	const failures: string[] = [];
	const kind = representationKind(manifest);
	const expectedCount = rows.length;
	const materializedCount = Object.values(index).filter((record) => record.state === "materialized").length;
	const failedCount = Object.values(index).filter((record) => record.state === "failed").length;
	const searchableCoverage = expectedCount === 0 ? 0 : materializedCount / expectedCount;
	const viewCounts: GenerationDiagnosticViewCounts = { total: 0, summary: 0, evidence: 0 };
	const rowsByFragment = new Map<string, GenerationValidationRow>();

	if (manifest.state !== "ready" && manifest.state !== "active") {
		failures.push(`generation state must be ready or active: ${manifest.state}`);
	}
	if (liveInventoryHash !== undefined && manifest.source_inventory_hash !== liveInventoryHash) {
		failures.push(
			`source inventory hash mismatch: manifest=${manifest.source_inventory_hash} live=${liveInventoryHash}`,
		);
	}
	if (manifest.expected_count !== expectedCount) {
		failures.push(`expected_count mismatch: manifest=${manifest.expected_count} actual=${expectedCount}`);
	}
	if (manifest.materialized_count !== materializedCount) {
		failures.push(
			`materialized_count mismatch: manifest=${manifest.materialized_count} actual=${materializedCount}`,
		);
	}
	if (manifest.failed_count !== failedCount) {
		failures.push(`failed_count mismatch: manifest=${manifest.failed_count} actual=${failedCount}`);
	}
	if (!coverageEquals(manifest.searchable_coverage, searchableCoverage)) {
		failures.push(
			`searchable_coverage mismatch: manifest=${manifest.searchable_coverage} actual=${searchableCoverage}`,
		);
	}
	if (kind === "multiview") {
		try {
			validateGenerationMultiviewManifest(manifest);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}

	for (const row of rows) {
		if (rowsByFragment.has(row.fragment_id)) {
			failures.push(`duplicate validation row for fragment: ${row.fragment_id}`);
			continue;
		}
		rowsByFragment.set(row.fragment_id, row);
	}

	for (const fragmentId of Object.keys(index)) {
		if (!rowsByFragment.has(fragmentId)) {
			failures.push(`generation record has no matching source row: ${fragmentId}`);
		}
	}

	for (const row of rows) {
		const record = index[row.fragment_id];
		if (!record) {
			failures.push(`missing generation record for fragment: ${row.fragment_id}`);
			continue;
		}
		if (record.fragment_id !== row.fragment_id) {
			failures.push(`record fragment id mismatch for ${row.fragment_id}: record=${record.fragment_id}`);
		}
		if (record.generation_id !== manifest.generation_id) {
			failures.push(
				`record generation id mismatch for ${row.fragment_id}: record=${record.generation_id} manifest=${manifest.generation_id}`,
			);
		}
		if (record.source_content_hash !== row.source_content_hash) {
			failures.push(
				`source content hash mismatch for ${row.fragment_id}: record=${record.source_content_hash} source=${row.source_content_hash}`,
			);
		}
		if (record.state !== "materialized") {
			failures.push(`generation record is not materialized for ${row.fragment_id}: ${record.state}`);
			continue;
		}
		if (record.dimension !== manifest.dimension) {
			failures.push(
				`record dimension mismatch for ${row.fragment_id}: record=${record.dimension} manifest=${manifest.dimension}`,
			);
		}
		if (kind === "multiview") {
			const views = readGenerationMultiviewViews(manifest.generation_id, row.fragment_id, record, manifest.dimension);
			if (!views) {
				failures.push(`multiview payload is missing or corrupt for ${row.fragment_id}`);
				continue;
			}
			for (const view of views) {
				viewCounts.total += 1;
				if (view.kind === "summary") viewCounts.summary += 1;
				if (view.kind === "evidence") viewCounts.evidence += 1;
			}
			continue;
		}
		const vectorPath = generationVectorPath(manifest.generation_id, row.fragment_id);
		if (!fs.existsSync(vectorPath)) {
			failures.push(`vector file is missing for ${row.fragment_id}`);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(vectorPath, "utf8"));
		} catch {
			failures.push(`vector file is not valid JSON for ${row.fragment_id}`);
			continue;
		}
		if (!Array.isArray(parsed)) {
			failures.push(`vector file is not an array for ${row.fragment_id}`);
			continue;
		}
		if (parsed.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
			failures.push(`vector contains non-finite values for ${row.fragment_id}`);
			continue;
		}
		if (parsed.length !== manifest.dimension || parsed.length !== record.dimension) {
			failures.push(
				`vector dimension mismatch for ${row.fragment_id}: file=${parsed.length} record=${record.dimension} manifest=${manifest.dimension}`,
			);
			continue;
		}
		const vectorHash = hashBytes(JSON.stringify(parsed));
		if (vectorHash !== record.vector_hash) {
			failures.push(`vector hash mismatch for ${row.fragment_id}: record=${record.vector_hash} file=${vectorHash}`);
		}
	}

	return {
		generation_id: manifest.generation_id,
		representation_kind: kind,
		valid: failures.length === 0,
		failures,
		expected_count: expectedCount,
		materialized_count: materializedCount,
		failed_count: failedCount,
		searchable_coverage: searchableCoverage,
		source_inventory_hash: manifest.source_inventory_hash,
		...(liveInventoryHash !== undefined ? { live_inventory_hash: liveInventoryHash } : {}),
		...(kind === "multiview" ? { view_counts: viewCounts } : {}),
	};
}

export function assertGenerationReadyForActivation(
	manifest: EmbeddingGenerationManifest,
	validation: GenerationValidationResult,
): void {
	if (isMultiviewGeneration(manifest)) assertMultiviewGenerationPolicy(manifest);
	if (manifest.state !== "ready" && manifest.state !== "active") {
		throw new Error(`generation is not ready for activation: ${manifest.generation_id} state=${manifest.state}`);
	}
	if (validation.failed_count !== 0) {
		throw new Error(`generation has failed records: ${manifest.generation_id} failed_count=${validation.failed_count}`);
	}
	if (validation.materialized_count !== validation.expected_count) {
		throw new Error(
			`generation is not fully materialized: ${manifest.generation_id} materialized=${validation.materialized_count} expected=${validation.expected_count}`,
		);
	}
	if (!coverageEquals(validation.searchable_coverage, 1)) {
		throw new Error(
			`generation does not have full searchable coverage: ${manifest.generation_id} coverage=${validation.searchable_coverage}`,
		);
	}
	if (!validation.valid) {
		throw new Error(
			`generation validation failed for activation: ${manifest.generation_id} ${validation.failures.join("; ")}`,
		);
	}
}

export function setGenerationExpectedCount(generationId: string, expectedCount: number): EmbeddingGenerationManifest {
	if (!Number.isInteger(expectedCount) || expectedCount < 0) throw new Error(`invalid expected count: ${expectedCount}`);
	const manifest = readGenerationManifest(generationId);
	if (!manifest) throw new Error(`generation not found: ${generationId}`);
	const next = { ...manifest, expected_count: expectedCount };
	writeGenerationManifest(next);
	return readGenerationManifest(generationId)!;
}

export function finalizeGeneration(generationId: string): EmbeddingGenerationManifest {
	const manifest = readGenerationManifest(generationId);
	if (!manifest) throw new Error(`generation not found: ${generationId}`);
	if (isMultiviewGeneration(manifest)) assertMultiviewGenerationPolicy(manifest);
	const index = readGenerationIndex(generationId);
	const records = Object.values(index);
	const failed = records.filter((record) => record.state === "failed").length;
	const materialized = records.filter((record) => record.state === "materialized").length;
	const expected = manifest.expected_count || records.length;
	const next: EmbeddingGenerationManifest = {
		...manifest,
		state: failed === 0 && materialized === expected ? "ready" : "failed",
		expected_count: expected,
		materialized_count: materialized,
		failed_count: failed,
		searchable_coverage: expected === 0 ? 0 : materialized / expected,
	};
	writeGenerationManifest(next);
	return readGenerationManifest(generationId)!;
}

export function activateGeneration(generationId: string): ActiveEmbeddingPointer {
	const manifest = readGenerationManifest(generationId);
	if (!manifest || (manifest.state !== "ready" && manifest.state !== "active")) {
		throw new Error(`generation is not activatable: ${generationId}`);
	}
	if (isMultiviewGeneration(manifest)) assertMultiviewGenerationPolicy(manifest);
	if (manifest.failed_count !== 0) {
		throw new Error(`generation has failed records and cannot be activated: ${generationId}`);
	}
	if (manifest.expected_count > 0 && manifest.materialized_count !== manifest.expected_count) {
		throw new Error(
			`generation is not fully materialized and cannot be activated: ${generationId} materialized=${manifest.materialized_count} expected=${manifest.expected_count}`,
		);
	}
	if (manifest.expected_count > 0 && !coverageEquals(manifest.searchable_coverage, 1)) {
		throw new Error(
			`generation does not have full searchable coverage and cannot be activated: ${generationId} coverage=${manifest.searchable_coverage}`,
		);
	}
	const current = readActivePointer();
	const activeManifest = { ...manifest, state: "active" as const };
	writeGenerationManifest(activeManifest);
	const persisted = readGenerationManifest(generationId)!;
	const pointer: ActiveEmbeddingPointer = {
		pointer_schema_version: 1,
		active_generation_id: generationId,
		active_manifest_hash: persisted.manifest_content_hash,
		previous_generation_id: current?.active_generation_id ?? null,
	};
	atomicWrite(ACTIVE_POINTER_PATH, `${JSON.stringify(pointer, null, 2)}\n`);
	return pointer;
}

export function rollbackToPreviousGeneration(): ActiveEmbeddingPointer {
	const current = readActivePointer();
	if (!current?.previous_generation_id) throw new Error("no previous generation available for rollback");
	return activateGeneration(current.previous_generation_id);
}

export function activeVectorExists(fragmentId: string): boolean {
	const manifest = getActiveGeneration();
	return Boolean(manifest && fs.existsSync(generationVectorPath(manifest.generation_id, fragmentId)));
}
