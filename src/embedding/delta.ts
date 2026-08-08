import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
	EmbeddingDeltaManifest,
	EmbeddingDeltaRecord,
	EmbeddingDeltaRecordState,
	EmbeddingGenerationManifest,
	EmbeddingGenerationRecord,
	EmbeddingHealthSnapshot,
	EmbeddingMaterializedView,
	EmbeddingViewDisclosure,
	EmbeddingSourceSpan,
} from "../types.js";
import {
	QUERY_RECIPE_ID,
	QUERY_RECIPE_VERSION,
	sourceContentHash,
} from "./builder.js";
import {
	generationVectorPath,
	getActiveGeneration,
	isMultiviewGeneration,
	readActivePointer,
	readGenerationIndex,
	readGenerationManifest,
	readGenerationMultiviewViews,
} from "./generation.js";
import { getFragment, listAllFragmentIds } from "../storage/fragments.js";

const MEMORY_BASE = path.resolve("memory");
const DELTA_BASE = path.join(MEMORY_BASE, "embedding_delta");
const DELTA_MANIFEST_PATH = path.join(DELTA_BASE, "manifest.json");
const DELTA_INDEX_PATH = path.join(DELTA_BASE, "delta_index.json");
const DELTA_VECTORS_BASE = path.join(DELTA_BASE, "vectors");
const DELTA_TRANSACTIONS_BASE = path.join(DELTA_BASE, "transactions");
const DELTA_ARCHIVE_BASE = path.join(DELTA_BASE, "archive");
const COMPACTION_LOCK_PATH = path.join(MEMORY_BASE, ".embedding-compaction.lock");
const COMPACTION_STALE_MS_DEFAULT = 30 * 60 * 1000;

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

function manifestHash(manifest: Omit<EmbeddingDeltaManifest, "manifest_content_hash">): string {
	return hashBytes(canonicalJson(manifest));
}

function atomicWrite(filePath: string, content: string): void {
	ensureDir(path.dirname(filePath));
	const tempPath = `${filePath}.tmp`;
	fs.writeFileSync(tempPath, content, "utf8");
	fs.renameSync(tempPath, filePath);
}

export interface DeltaFileOps {
	mkdirSync: (filePath: string, options?: { recursive?: boolean }) => void;
	writeFileSync: (filePath: string, content: string, encoding?: BufferEncoding) => void;
	readFileSync: (filePath: string, encoding: BufferEncoding) => string;
	renameSync: (source: string, destination: string) => void;
	unlinkSync: (filePath: string) => void;
	existsSync: (filePath: string) => boolean;
	rmSync: (filePath: string, options?: { recursive?: boolean; force?: boolean }) => void;
}

const defaultDeltaFileOps: DeltaFileOps = {
	mkdirSync: (filePath, options) => fs.mkdirSync(filePath, options),
	writeFileSync: (filePath, content, encoding) => fs.writeFileSync(filePath, content, encoding),
	readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
	renameSync: (source, destination) => fs.renameSync(source, destination),
	unlinkSync: (filePath) => fs.unlinkSync(filePath),
	existsSync: (filePath) => fs.existsSync(filePath),
	rmSync: (filePath, options) => fs.rmSync(filePath, options),
};

let deltaTransactionSequence = 0;

function nextDeltaTransactionId(): string {
	deltaTransactionSequence += 1;
	return `multiview-${Date.now()}-${process.pid}-${deltaTransactionSequence}`;
}

function ensureDirWithOps(dir: string, ops: DeltaFileOps): void {
	ops.mkdirSync(dir, { recursive: true });
}

function removeIfExists(filePath: string, ops: DeltaFileOps): void {
	if (ops.existsSync(filePath)) ops.unlinkSync(filePath);
}

function writeDeltaManifestContent(manifest: EmbeddingDeltaManifest): string {
	const { manifest_content_hash: _ignored, ...payload } = manifest;
	const complete = { ...manifest, manifest_content_hash: manifestHash(payload) };
	return `${JSON.stringify(complete, null, 2)}
`;
}

interface DeltaTransactionTarget {
	livePath: string;
	stagedPath: string;
	originalContent: string | null;
}

function writeTransactionState(
	transactionRoot: string,
	state: string,
	targets: DeltaTransactionTarget[],
	ops: DeltaFileOps,
): void {
	ensureDirWithOps(transactionRoot, ops);
	ops.writeFileSync(
		path.join(transactionRoot, "transaction.json"),
		`${JSON.stringify({ state, targets: targets.map(({ livePath, stagedPath, originalContent }) => ({ livePath, stagedPath, existed: originalContent !== null })) }, null, 2)}
`,
		"utf8",
	);
}

function rollbackDeltaTransaction(targets: DeltaTransactionTarget[], ops: DeltaFileOps): void {
	for (const target of [...targets].reverse()) {
		removeIfExists(target.livePath, ops);
		if (target.originalContent !== null) {
			ensureDirWithOps(path.dirname(target.livePath), ops);
			ops.writeFileSync(target.livePath, target.originalContent, "utf8");
		}
	}
}

function commitMultiviewFiles(
	fragmentId: string,
	contents: Array<{ livePath: string; content: string }>,
	ops: DeltaFileOps,
): void {
	const transactionRoot = deltaTransactionRoot(nextDeltaTransactionId());
	const targets: DeltaTransactionTarget[] = contents.map(({ livePath }, index) => ({
		livePath,
		stagedPath: path.join(transactionRoot, "staged", `${index}.tmp`),
		originalContent: ops.existsSync(livePath) ? ops.readFileSync(livePath, "utf8") : null,
	}));
	try {
		ensureDirWithOps(path.join(transactionRoot, "staged"), ops);
		writeTransactionState(transactionRoot, "prepared", targets, ops);
		for (let index = 0; index < contents.length; index += 1) {
			ops.writeFileSync(targets[index].stagedPath, contents[index].content, "utf8");
		}
		writeTransactionState(transactionRoot, "committing", targets, ops);
		for (const target of targets) {
			removeIfExists(target.livePath, ops);
			ensureDirWithOps(path.dirname(target.livePath), ops);
			ops.renameSync(target.stagedPath, target.livePath);
		}
		writeTransactionState(transactionRoot, "completed", targets, ops);
		ops.rmSync(transactionRoot, { recursive: true, force: true });
	} catch (error) {
		try {
			rollbackDeltaTransaction(targets, ops);
			ops.rmSync(transactionRoot, { recursive: true, force: true });
		} catch (rollbackError) {
			try {
				writeTransactionState(transactionRoot, "rollback_failed", targets, ops);
			} catch {
				// Preserve the transaction directory even if its state marker cannot be updated.
			}
			throw new Error(
				`multiview delta transaction failed for ${fragmentId}: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		throw error;
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function reservedDeltaIds(): Set<string> {
	const ids = new Set<string>();
	if (fs.existsSync(DELTA_MANIFEST_PATH)) {
		try {
			const manifest = JSON.parse(fs.readFileSync(DELTA_MANIFEST_PATH, "utf8")) as { delta_id?: unknown };
			if (typeof manifest.delta_id === "string") ids.add(manifest.delta_id);
		} catch {
			// Keep the active manifest unavailable for reuse when its contents are unreadable.
		}
	}
	if (!fs.existsSync(DELTA_ARCHIVE_BASE)) return ids;
	for (const entry of fs.readdirSync(DELTA_ARCHIVE_BASE, { withFileTypes: true })) {
		const match = /^(delta_\d{8}_\d+)-into-/.exec(entry.name);
		if (match) ids.add(match[1]);
		if (!entry.isDirectory()) continue;
		const manifestPath = path.join(DELTA_ARCHIVE_BASE, entry.name, "manifest.json");
		if (!fs.existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { delta_id?: unknown };
			if (typeof manifest.delta_id === "string") ids.add(manifest.delta_id);
		} catch {
			// The archive directory name above still reserves a recognizable delta id.
		}
	}
	return ids;
}

function nextDeltaId(): string {
	const stamp = nowIso().slice(0, 10).replace(/-/g, "");
	const reserved = reservedDeltaIds();
	for (let sequence = 1; ; sequence += 1) {
		const candidate = `delta_${stamp}_${String(sequence).padStart(3, "0")}`;
		if (!reserved.has(candidate)) return candidate;
	}
}

function parseFragmentId(fragmentId: string): [string, string] {
	const [date, id, extra] = fragmentId.split("/");
	if (!date || !id || extra || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^frag_\d+$/.test(id)) {
		throw new Error(`invalid fragment id: ${fragmentId}`);
	}
	return [date, id];
}

function activeBaseOrThrow(): { active: EmbeddingGenerationManifest; activeManifestHash: string } {
	const active = getActiveGeneration();
	const pointer = readActivePointer();
	if (!active || !pointer) throw new Error("active generation not found");
	return { active, activeManifestHash: pointer.active_manifest_hash };
}

export function deltaManifestPath(): string {
	return DELTA_MANIFEST_PATH;
}

export function deltaIndexPath(): string {
	return DELTA_INDEX_PATH;
}

export function deltaVectorPath(fragmentId: string): string {
	const [date, id] = parseFragmentId(fragmentId);
	return path.join(DELTA_VECTORS_BASE, date, `${id}.embedding`);
}

export function deltaTransactionRoot(operationId: string): string {
	return path.join(DELTA_TRANSACTIONS_BASE, operationId);
}

export function deltaArchiveRoot(): string {
	return DELTA_ARCHIVE_BASE;
}

export function compactionLockPath(): string {
	return COMPACTION_LOCK_PATH;
}

export function isDeltaInitialized(): boolean {
	return fs.existsSync(DELTA_MANIFEST_PATH) && fs.existsSync(DELTA_INDEX_PATH);
}

export function readDeltaManifest(): EmbeddingDeltaManifest | null {
	if (!fs.existsSync(DELTA_MANIFEST_PATH)) return null;
	const manifest = JSON.parse(fs.readFileSync(DELTA_MANIFEST_PATH, "utf8")) as EmbeddingDeltaManifest;
	const { manifest_content_hash: storedHash, ...payload } = manifest;
	if (storedHash !== manifestHash(payload)) throw new Error(`delta manifest hash mismatch: ${manifest.delta_id}`);
	return manifest;
}

export function writeDeltaManifest(manifest: EmbeddingDeltaManifest): void {
	const { manifest_content_hash: _ignored, ...payload } = manifest;
	const complete = { ...manifest, manifest_content_hash: manifestHash(payload) };
	atomicWrite(DELTA_MANIFEST_PATH, `${JSON.stringify(complete, null, 2)}\n`);
}

export function readDeltaIndex(): Record<string, EmbeddingDeltaRecord> {
	if (!fs.existsSync(DELTA_INDEX_PATH)) return {};
	return JSON.parse(fs.readFileSync(DELTA_INDEX_PATH, "utf8")) as Record<string, EmbeddingDeltaRecord>;
}

export function writeDeltaIndex(index: Record<string, EmbeddingDeltaRecord>): void {
	atomicWrite(DELTA_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
}

export function createDeltaManifest(active: EmbeddingGenerationManifest, activeManifestHash: string): EmbeddingDeltaManifest {
	const manifest: EmbeddingDeltaManifest = {
		delta_schema_version: 2,
		delta_id: nextDeltaId(),
		state: "active",
		representation_kind: active.representation_kind,
		document_policy_version: active.document_policy_version,
		multiview_policy: active.multiview_policy,
		view_schema_version: active.view_schema_version,
		aggregation_mode: active.aggregation_mode,
		evidence_policy_id: active.evidence_policy_id,
		retrieval_epoch: active.retrieval_epoch,
		base_generation_id: active.generation_id,
		base_manifest_hash: activeManifestHash,
		representation_identity_hash: active.representation_identity_hash,
		document_recipe_id: active.document_recipe_id,
		document_recipe_version: active.document_recipe_version,
		query_recipe_id: QUERY_RECIPE_ID,
		query_recipe_version: QUERY_RECIPE_VERSION,
		source_schema_version: active.source_schema_version,
		sequence: 1,
		record_count: 0,
		materialized_count: 0,
		failed_count: 0,
		created_at: nowIso(),
		manifest_content_hash: "",
	};
	return manifest;
}

export function ensureActiveDelta(): EmbeddingDeltaManifest {
	const existing = readDeltaManifest();
	if (existing) return existing;
	const { active, activeManifestHash } = activeBaseOrThrow();
	ensureDir(DELTA_BASE);
	ensureDir(DELTA_VECTORS_BASE);
	ensureDir(DELTA_TRANSACTIONS_BASE);
	ensureDir(DELTA_ARCHIVE_BASE);
	const manifest = createDeltaManifest(active, activeManifestHash);
	writeDeltaManifest(manifest);
	writeDeltaIndex({});
	return readDeltaManifest()!;
}

export function currentDeltaCompatibility(): { active: EmbeddingGenerationManifest | null; delta: EmbeddingDeltaManifest | null; compatible: boolean; reason?: string } {
	const active = getActiveGeneration();
	if (!active) return { active: null, delta: null, compatible: false, reason: "active generation missing" };
	const pointer = readActivePointer();
	const delta = readDeltaManifest();
	if (!pointer || !delta) return { active, delta, compatible: false, reason: !delta ? "delta missing" : "active pointer missing" };
	if (delta.base_generation_id !== pointer.active_generation_id) {
		return { active, delta, compatible: false, reason: "delta base generation mismatch" };
	}
	if (delta.base_manifest_hash !== pointer.active_manifest_hash) {
		return { active, delta, compatible: false, reason: "delta base manifest hash mismatch" };
	}
	if (delta.representation_identity_hash !== active.representation_identity_hash) {
		return { active, delta, compatible: false, reason: "delta representation identity mismatch" };
	}
	if (delta.representation_kind !== active.representation_kind || delta.document_recipe_id !== active.document_recipe_id || delta.document_recipe_version !== active.document_recipe_version || delta.document_policy_version !== active.document_policy_version || delta.aggregation_mode !== active.aggregation_mode || delta.evidence_policy_id !== active.evidence_policy_id || delta.retrieval_epoch !== active.retrieval_epoch) {
		return { active, delta, compatible: false, reason: "delta representation schema mismatch" };
	}
	return { active, delta, compatible: true };
}

function summarizeDeltaIndex(index: Record<string, EmbeddingDeltaRecord>): {
	record_count: number;
	materialized_count: number;
	failed_count: number;
} {
	const records = Object.values(index);
	return {
		record_count: records.length,
		materialized_count: records.filter((record) => record.state === "materialized").length,
		failed_count: records.filter((record) => record.state !== "materialized" && record.state !== "tombstone").length,
	};
}

export function getMigrationSwitchDeltaRisk(): {
	has_delta: boolean;
	state: EmbeddingDeltaManifest["state"] | null;
	record_count: number;
	materialized_count: number;
	failed_count: number;
	compatible_with_active: boolean;
	safe: boolean;
	reason: string;
} {
	const lock = getCompactionLock();
	let index: Record<string, EmbeddingDeltaRecord>;
	try {
		index = readDeltaIndex();
	} catch (error) {
		return {
			has_delta: fs.existsSync(DELTA_MANIFEST_PATH) || fs.existsSync(DELTA_INDEX_PATH),
			state: null,
			record_count: 0,
			materialized_count: 0,
			failed_count: 0,
			compatible_with_active: false,
			safe: false,
			reason: `delta index unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const derivedCounts = summarizeDeltaIndex(index);
	let manifest: EmbeddingDeltaManifest | null;
	try {
		manifest = readDeltaManifest();
	} catch (error) {
		return {
			has_delta: true,
			state: null,
			record_count: derivedCounts.record_count,
			materialized_count: derivedCounts.materialized_count,
			failed_count: derivedCounts.failed_count,
			compatible_with_active: false,
			safe: false,
			reason: `delta manifest unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const counts = {
		record_count: manifest ? Math.max(manifest.record_count, derivedCounts.record_count) : derivedCounts.record_count,
		materialized_count: manifest ? Math.max(manifest.materialized_count, derivedCounts.materialized_count) : derivedCounts.materialized_count,
		failed_count: manifest ? Math.max(manifest.failed_count, derivedCounts.failed_count) : derivedCounts.failed_count,
	};
	const hasDelta = manifest !== null || fs.existsSync(DELTA_INDEX_PATH) || counts.record_count > 0;
		if (!hasDelta) {
			return {
				has_delta: false,
				state: null,
				record_count: 0,
				materialized_count: 0,
				failed_count: 0,
				compatible_with_active: true,
				safe: true,
				reason: "no delta",
			};
		}
	let compatibleWithActive = false;
	let compatibilityReason = "active generation missing";
	try {
		const compatibility = currentDeltaCompatibility();
		compatibleWithActive = manifest ? compatibility.compatible : compatibility.active !== null;
		compatibilityReason = compatibility.reason ?? "delta incompatible with active generation";
	} catch (error) {
		return {
			has_delta: hasDelta,
			state: manifest?.state ?? null,
			record_count: counts.record_count,
			materialized_count: counts.materialized_count,
			failed_count: counts.failed_count,
			compatible_with_active: false,
			safe: false,
			reason: `delta compatibility unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (lock.locked && !lock.stale) {
		return {
			has_delta: hasDelta,
			state: manifest?.state ?? null,
			...counts,
			compatible_with_active: compatibleWithActive,
			safe: false,
			reason: "compacting",
		};
	}
	if (!manifest) {
		if (fs.existsSync(DELTA_INDEX_PATH)) {
			return {
				has_delta: hasDelta,
				state: null,
				...counts,
				compatible_with_active: compatibleWithActive,
				safe: false,
				reason: counts.record_count > 0 ? "delta manifest missing with non-empty delta index" : "delta manifest missing while delta index exists",
			};
		}
		if (!compatibleWithActive) {
			return {
				has_delta: hasDelta,
				state: null,
				...counts,
				compatible_with_active: compatibleWithActive,
				safe: false,
				reason: compatibilityReason,
			};
		}
		return {
			has_delta: false,
			state: null,
			...counts,
			compatible_with_active: true,
			safe: true,
			reason: "no delta manifest",
		};
	}
	if (manifest.state === "sealed") {
		return {
			has_delta: true,
			state: manifest.state,
			...counts,
			compatible_with_active: compatibleWithActive,
			safe: false,
			reason: "delta is sealed",
		};
	}
	if (manifest.state !== "active") {
		return {
			has_delta: true,
			state: manifest.state,
			...counts,
			compatible_with_active: compatibleWithActive,
			safe: false,
			reason: `delta state is not active: ${manifest.state}`,
		};
	}
	if (!compatibleWithActive) {
		return {
			has_delta: true,
			state: manifest.state,
			...counts,
			compatible_with_active: false,
			safe: false,
			reason: compatibilityReason,
		};
		}
	if (counts.record_count > 0) {
		return {
			has_delta: true,
			state: manifest.state,
			...counts,
			compatible_with_active: true,
			safe: false,
			reason: `delta has non-empty records: ${counts.record_count}`,
		};
	}
	return {
		has_delta: true,
		state: manifest.state,
		...counts,
		compatible_with_active: true,
		safe: true,
		reason: "delta is empty and compatible with active generation",
	};
}

export function assertMigrationSwitchDeltaSafe(): void {
	const risk = getMigrationSwitchDeltaRisk();
	if (!risk.safe) throw new Error(risk.reason);
}

export function assertDeltaWritable(): EmbeddingDeltaManifest {
	const manifest = ensureActiveDelta();
	if (manifest.state !== "active") throw new Error(`delta is not writable: ${manifest.state}`);
	const { compatible, reason } = currentDeltaCompatibility();
	if (!compatible) throw new Error(reason ?? "delta incompatible with active generation");
	return manifest;
}

export function getCompactionLock(staleMs = COMPACTION_STALE_MS_DEFAULT): { locked: boolean; stale: boolean; payload: Record<string, unknown> | null } {
	if (!fs.existsSync(COMPACTION_LOCK_PATH)) return { locked: false, stale: false, payload: null };
	try {
		const payload = JSON.parse(fs.readFileSync(COMPACTION_LOCK_PATH, "utf8")) as Record<string, unknown>;
		const createdAt = typeof payload.created_at === "string" ? Date.parse(payload.created_at) : NaN;
		const pid = typeof payload.pid === "number" ? payload.pid : Number(payload.pid);
		const ageExceeded = Number.isFinite(createdAt) ? Date.now() - createdAt > staleMs : true;
		let pidMissing = false;
		if (Number.isFinite(pid) && pid > 0) {
			try {
				process.kill(pid, 0);
			} catch {
				pidMissing = true;
			}
		} else {
			pidMissing = true;
		}
		return { locked: true, stale: ageExceeded || pidMissing, payload };
	} catch {
		return { locked: true, stale: true, payload: null };
	}
}

export function clearStaleCompactionLock(staleMs = COMPACTION_STALE_MS_DEFAULT): boolean {
	const lock = getCompactionLock(staleMs);
	if (!lock.locked || !lock.stale) return false;
	fs.unlinkSync(COMPACTION_LOCK_PATH);
	return true;
}

export function createCompactionLock(reason = "compaction"): Record<string, unknown> {
	clearStaleCompactionLock();
	if (fs.existsSync(COMPACTION_LOCK_PATH)) throw new Error("compaction lock already exists");
	const payload = {
		pid: process.pid,
		created_at: nowIso(),
		reason,
	};
	atomicWrite(COMPACTION_LOCK_PATH, `${JSON.stringify(payload, null, 2)}\n`);
	return payload;
}

export function removeCompactionLock(): void {
	if (fs.existsSync(COMPACTION_LOCK_PATH)) fs.unlinkSync(COMPACTION_LOCK_PATH);
}

export function assertWritesAllowed(): void {
	const lock = getCompactionLock();
	if (lock.locked && !lock.stale) throw new Error("compacting");
	const manifest = readDeltaManifest();
	if (manifest?.state === "sealed") throw new Error("compacting");
}

function buildRecordState(vector: number[]): EmbeddingDeltaRecordState {
	if (vector.some((value) => !Number.isFinite(value))) return "vector_corrupt";
	return "materialized";
}

export interface MaterializedDeltaView {
	view_id: string;
	kind: "summary" | "evidence";
	vector: number[];
	input_hash: string;
	tokens: unknown;
	source_spans: EmbeddingSourceSpan[];
	disclosure: EmbeddingViewDisclosure;
}

function viewKey(fragmentId: string, viewId: string): string {
	return `${fragmentId}#${viewId}`;
}

function viewSetHash(views: EmbeddingMaterializedView[]): string {
	return hashBytes(canonicalJson(views));
}

export function multiviewViewSidecarPath(fragmentId: string): string {
	return multiviewSidecarPath(fragmentId);
}

export function multiviewSidecarPath(fragmentId: string): string {
	const [date, id] = parseFragmentId(fragmentId);
	return path.join(DELTA_VECTORS_BASE, date, id, "views.json");
}

export function upsertDeltaViews(
	manifest: EmbeddingDeltaManifest,
	fragmentId: string,
	sourceHash: string,
	views: MaterializedDeltaView[],
	operation: EmbeddingDeltaRecord["operation"] = "create",
	fileOps: DeltaFileOps = defaultDeltaFileOps,
): EmbeddingDeltaRecord {
	if (manifest.representation_kind !== "multiview") throw new Error(`multiview delta write requires multiview delta: ${manifest.delta_id}`);
	if (!views.length || views.filter((view) => view.kind === "summary").length !== 1) throw new Error(`multiview materialization requires exactly one summary view for ${fragmentId}`);
	const ids = new Set<string>();
	const materialized: EmbeddingMaterializedView[] = [];
	for (const view of views) {
		if (!view.view_id || !/^[A-Za-z0-9._-]+$/.test(view.view_id)) throw new Error(`invalid multiview id: ${fragmentId}/${view.view_id}`);
		if (ids.has(view.view_id)) throw new Error(`duplicate multiview id: ${fragmentId}/${view.view_id}`);
		ids.add(view.view_id);
		if (view.vector.length !== manifestDimension(manifest) || view.vector.some((value) => !Number.isFinite(value))) throw new Error(`invalid multiview vector: ${fragmentId}/${view.view_id}`);
		const bytes = JSON.stringify(view.vector);
		materialized.push({ view_id: view.view_id, kind: view.kind, input_hash: view.input_hash, vector_hash: hashBytes(bytes), vector_dimension: view.vector.length, tokens: view.tokens, source_spans: view.source_spans, disclosure: view.disclosure });
	}
	const index = readDeltaIndex();
	const summary = views.find((view) => view.kind === "summary")!;
	const sidecar = { view_schema_version: 1, fragment_id: fragmentId, source_content_hash: sourceHash, views: Object.fromEntries(views.map((view) => [view.view_id, view.vector])) };
	const summaryBytes = JSON.stringify(summary.vector);
	const record: EmbeddingDeltaRecord = { record_schema_version: 2, delta_id: manifest.delta_id, fragment_id: fragmentId, state: "materialized", operation, view_id: "summary", view_kind: "summary", source_spans: summary.source_spans, disclosure: summary.disclosure, views: materialized, view_set_hash: viewSetHash(materialized), source_content_hash: sourceHash, constructed_input_hash: summary.input_hash, vector_hash: hashBytes(summaryBytes), vector_dimension: summary.vector.length, representation_identity_hash: manifest.representation_identity_hash, tokens: summary.tokens, created_at: nowIso(), failure: null };
	const nextIndex = { ...index, [fragmentId]: record };
	const all = Object.values(nextIndex);
	const nextManifest = { ...manifest, record_count: all.length, materialized_count: all.filter((item) => item.state === "materialized").length, failed_count: all.filter((item) => item.state !== "materialized" && item.state !== "tombstone").length };
	commitMultiviewFiles(fragmentId, [
		{ livePath: multiviewSidecarPath(fragmentId), content: `${JSON.stringify(sidecar, null, 2)}\n` },
		{ livePath: deltaVectorPath(fragmentId), content: summaryBytes },
		{ livePath: DELTA_INDEX_PATH, content: `${JSON.stringify(nextIndex, null, 2)}\n` },
		{ livePath: DELTA_MANIFEST_PATH, content: writeDeltaManifestContent(nextManifest) },
	], fileOps);
	return record;
}

function manifestDimension(manifest: EmbeddingDeltaManifest): number {
	const active = getActiveGeneration();
	if (!active || active.generation_id !== manifest.base_generation_id) throw new Error("active generation mismatch during multiview write");
	return active.dimension;
}

export function upsertDeltaRecord(
	manifest: EmbeddingDeltaManifest,
	fragmentId: string,
	vector: number[],
	inputHash: string,
	sourceHash: string,
	tokens: unknown,
	operation: EmbeddingDeltaRecord["operation"] = "create",
): EmbeddingDeltaRecord {
	if (manifest.representation_kind === "multiview") throw new Error(`single-view delta write is not allowed for multiview delta: ${manifest.delta_id}`);
	const state = buildRecordState(vector);
	if (state !== "materialized") throw new Error(`invalid delta vector for ${fragmentId}`);
	const bytes = JSON.stringify(vector);
	atomicWrite(deltaVectorPath(fragmentId), bytes);
	const index = readDeltaIndex();
	const record: EmbeddingDeltaRecord = {
		record_schema_version: 1,
		delta_id: manifest.delta_id,
		fragment_id: fragmentId,
		state,
		operation,
		source_content_hash: sourceHash,
		constructed_input_hash: inputHash,
		vector_hash: hashBytes(bytes),
		vector_dimension: vector.length,
		representation_identity_hash: manifest.representation_identity_hash,
		tokens,
		created_at: nowIso(),
		failure: null,
	};
	index[fragmentId] = record;
	writeDeltaIndex(index);
	const all = Object.values(index);
	writeDeltaManifest({
		...manifest,
		record_count: all.length,
		materialized_count: all.filter((item) => item.state === "materialized").length,
		failed_count: all.filter((item) => item.state !== "materialized" && item.state !== "tombstone").length,
	});
	return record;
}

export function writeDeltaTombstone(fragmentId: string, operation: EmbeddingDeltaRecord["operation"] = "delete"): EmbeddingDeltaRecord {
	const manifest = assertDeltaWritable();
	const index = readDeltaIndex();
	const record: EmbeddingDeltaRecord = {
		record_schema_version: 1,
		delta_id: manifest.delta_id,
		fragment_id: fragmentId,
		state: "tombstone",
		operation,
		source_content_hash: null,
		constructed_input_hash: null,
		vector_hash: null,
		vector_dimension: null,
		representation_identity_hash: manifest.representation_identity_hash,
		tokens: {},
		created_at: nowIso(),
		failure: null,
	};
	index[fragmentId] = record;
	writeDeltaIndex(index);
	const all = Object.values(index);
	writeDeltaManifest({
		...manifest,
		record_count: all.length,
		materialized_count: all.filter((item) => item.state === "materialized").length,
		failed_count: all.filter((item) => item.state !== "materialized" && item.state !== "tombstone").length,
	});
	return record;
}

export function buildEffectiveEmbeddingView(): {
	baseGeneration: EmbeddingGenerationManifest | null;
	deltaManifest: EmbeddingDeltaManifest | null;
	index: Map<string, { layer: "base" | "delta"; record: EmbeddingDeltaRecord | null }>;
	health: EmbeddingHealthSnapshot;
} {
	const active = getActiveGeneration();
	const pointer = readActivePointer();
	const delta = readDeltaManifest();
	const deltaIndex = delta ? readDeltaIndex() : {};
	const baseIndex = active ? readGenerationIndex(active.generation_id) : {};
	const sourceIds = listAllFragmentIds();
	const sourceSet = new Set(sourceIds);
	const index = new Map<string, { layer: "base" | "delta"; record: EmbeddingDeltaRecord | null }>();
	let materializedDelta = 0;
	let tombstones = 0;
	let stale = 0;
	let corrupt = 0;
	let missing = 0;
	let sourceHashMismatches = 0;
	let identityMismatches = 0;
	let dimensionMismatches = 0;
	for (const fragmentId of sourceIds) {
		const deltaRecord = deltaIndex[fragmentId];
		if (deltaRecord) {
			if (deltaRecord.state === "tombstone") {
				tombstones++;
				continue;
			}
			if (deltaRecord.state === "materialized") {
				if (active && isMultiviewGeneration(active) && readDeltaMultiviewViews(fragmentId, deltaRecord, active.dimension) === null) {
						corrupt++;
						continue;
					}
					materializedDelta++;
				index.set(fragmentId, { layer: "delta", record: deltaRecord });
				continue;
			}
			stale++;
		}
		if (active && baseIndex[fragmentId]) {
			index.set(fragmentId, { layer: "base", record: null });
		} else {
			missing++;
		}
	}
	for (const [fragmentId, deltaRecord] of Object.entries(deltaIndex)) {
		if (!sourceSet.has(fragmentId) && deltaRecord.state !== "tombstone") {
			corrupt++;
		}
	}
	if (active) {
		for (const [fragmentId, entry] of index) {
			if (entry.layer === "base") {
				const baseRecord = baseIndex[fragmentId];
				if (!baseRecord) {
					missing++;
					continue;
				}
				if (baseRecord.dimension !== active.dimension) dimensionMismatches++;
				if (isMultiviewGeneration(active)) {
						if (readGenerationMultiviewViews(active.generation_id, fragmentId, baseRecord, active.dimension) === null) corrupt++;
					} else if (!fs.existsSync(generationVectorPath(active.generation_id, fragmentId))) corrupt++;
				const fragment = getFragment(fragmentId);
				if (
					fragment &&
					baseRecord.source_content_hash !==
						sourceContentHash({
							task_desc: fragment.task_desc,
							result_desc: fragment.result_desc,
							tags: fragment.tags,
							topic_name: fragment.topic_name,
							turns_text: fragment.turns_text,
						})
				) sourceHashMismatches++;
				continue;
			}
			if (entry.record) {
				if (entry.record.representation_identity_hash !== active.representation_identity_hash) identityMismatches++;
				if (entry.record.vector_dimension !== active.dimension) dimensionMismatches++;
				if (!fs.existsSync(deltaVectorPath(fragmentId))) corrupt++;
				const fragment = getFragment(fragmentId);
				if (
					fragment &&
					entry.record.source_content_hash !==
						sourceContentHash({
							task_desc: fragment.task_desc,
							result_desc: fragment.result_desc,
							tags: fragment.tags,
							topic_name: fragment.topic_name,
							turns_text: fragment.turns_text,
						})
				) sourceHashMismatches++;
			}
		}
	}
	const effectiveVectors = index.size;
	const status = !active
		? "degraded"
		: identityMismatches > 0 || corrupt > 0 || dimensionMismatches > 0
			? "invalid"
			: delta && materializedDelta > 0
				? "healthy_with_delta"
				: "healthy";
	const health: EmbeddingHealthSnapshot = {
		active_generation_id: active?.generation_id ?? null,
		active_manifest_hash: pointer?.active_manifest_hash ?? null,
		representation_identity_hash: active?.representation_identity_hash ?? null,
		active_delta_id: delta?.delta_id ?? null,
		delta_state: delta?.state ?? null,
		source_fragments: sourceIds.length,
		base_generation_fragments: [...index.values()].filter((entry) => entry.layer === "base").length,
		delta_materialized_fragments: materializedDelta,
		delta_tombstones: tombstones,
		effective_vectors: effectiveVectors,
		missing_vectors: missing,
		stale_vectors: stale,
		corrupt_vectors: corrupt,
		dimension_mismatches: dimensionMismatches,
		source_hash_mismatches: sourceHashMismatches,
		identity_mismatches: identityMismatches,
		base_coverage: active?.searchable_coverage ?? 0,
		effective_coverage: sourceIds.length === 0 ? 0 : effectiveVectors / sourceIds.length,
		status,
	};
	return { baseGeneration: active, deltaManifest: delta, index, health };
}

export interface CompactionMergeContractEntry {
	fragment_id: string;
	effective_layer: "base" | "delta";
	source_content_hash: string;
	input_hash: string;
	vector_hash: string;
	vector_dimension: number;
	view_set_hash: string | null;
	view_count: number;
}

export interface CompactionMergeContract {
	contract_schema_version: 1;
	base: {
		generation_id: string;
		manifest_content_hash: string;
		source_inventory_hash: string;
	};
	active_pointer: {
		pointer_schema_version: number;
		active_generation_id: string;
		active_manifest_hash: string;
	};
	delta: {
		delta_id: string;
		manifest_content_hash: string;
		state: "sealed";
		base_generation_id: string;
		base_manifest_hash: string;
		sequence: number;
		record_count: number;
		materialized_count: number;
		failed_count: number;
	};
	representation: {
		kind: "single" | "multiview";
		identity_hash: string;
		dimension: number;
		source_schema_version: number;
	};
	retrieval: {
		retrieval_epoch: string;
		document_recipe_id: string;
		document_recipe_version: number;
		query_recipe_id: string;
		query_recipe_version: number;
		document_policy_version: number | null;
		view_schema_version: number | null;
		aggregation_mode: string;
		evidence_policy_id: string | null;
	};
	source_inventory_hash: string;
	effective_entry_hash: string;
	fragment_counts: {
		live: number;
		effective: number;
		base: number;
		delta: number;
		tombstone: number;
	};
	entries: CompactionMergeContractEntry[];
	contract_content_hash: string;
}

export interface CompactionArchiveMergeReceipt {
	receipt_schema_version: 1;
	archive_delta_id: string;
	archive_manifest_hash: string;
	contract_hash: string;
	base: {
		generation_id: string;
		manifest_hash: string;
		source_inventory_hash: string;
	};
	delta: {
		delta_id: string;
		manifest_hash: string;
		state: "sealed";
		base_generation_id: string;
		base_manifest_hash: string;
		pointer_generation_id: string;
		pointer_manifest_hash: string;
		record_count: number;
		materialized_count: number;
		failed_count: number;
	};
	target: {
		generation_id: string;
		manifest_hash: string;
		pointer_manifest_hash: string;
		pointer_hash: string;
		source_inventory_hash: string;
		expected_count: number;
		materialized_count: number;
	};
	merge: {
		source_inventory_hash: string;
		effective_entry_hash: string;
		live_fragment_count: number;
		effective_fragment_count: number;
		base_fragment_count: number;
		delta_fragment_count: number;
		tombstone_count: number;
	};
	archived_at: string;
}

function canonicalCompare(value: unknown): string {
	return String(canonicalJson(value));
}

function compactionMergeContractHash(contract: Omit<CompactionMergeContract, "contract_content_hash">): string {
	return hashBytes(canonicalJson(contract));
}

function sortedCompactionEntries(entries: CompactionMergeContractEntry[]): CompactionMergeContractEntry[] {
	return [...entries].sort(
		(left, right) =>
			left.fragment_id.localeCompare(right.fragment_id) ||
			left.source_content_hash.localeCompare(right.source_content_hash) ||
			left.effective_layer.localeCompare(right.effective_layer),
	);
}

function effectiveSourceInventoryHash(entries: CompactionMergeContractEntry[]): string {
	return hashBytes(
		canonicalJson(
			sortedCompactionEntries(entries).map(({ fragment_id, source_content_hash }) => ({ fragment_id, source_content_hash })),
		),
	);
}

function effectiveEntryHash(entries: CompactionMergeContractEntry[]): string {
	return hashBytes(canonicalJson(sortedCompactionEntries(entries)));
}

function liveSourceHashOrThrow(fragmentId: string): string {
	const fragment = getFragment(fragmentId);
	if (!fragment) throw new Error(`live source fragment missing content: ${fragmentId}`);
	return sourceContentHash({
		task_desc: fragment.task_desc,
		result_desc: fragment.result_desc,
		tags: fragment.tags,
		topic_name: fragment.topic_name,
		turns_text: fragment.turns_text,
	});
}

function buildBaseCompactionEntry(
	active: EmbeddingGenerationManifest,
	fragmentId: string,
	record: EmbeddingGenerationRecord | undefined,
	liveSourceHash: string,
): CompactionMergeContractEntry {
	if (!record) throw new Error(`base generation record missing for live fragment: ${fragmentId}`);
	if (record.fragment_id !== fragmentId) throw new Error(`base fragment id mismatch for ${fragmentId}: ${record.fragment_id}`);
	if (record.generation_id !== active.generation_id) {
		throw new Error(`base generation id mismatch for ${fragmentId}: ${record.generation_id} != ${active.generation_id}`);
	}
	if (record.state !== "materialized") throw new Error(`base generation record is not materialized for ${fragmentId}: ${record.state}`);
	if (record.source_content_hash !== liveSourceHash) {
		throw new Error(`base source content hash mismatch for ${fragmentId}: ${record.source_content_hash} != ${liveSourceHash}`);
	}
	if (record.dimension !== active.dimension) {
		throw new Error(`base vector dimension mismatch for ${fragmentId}: ${record.dimension} != ${active.dimension}`);
	}
	if (isMultiviewGeneration(active)) {
		if (!record.view_set_hash) throw new Error(`base multiview view_set_hash missing for ${fragmentId}`);
		const views = readGenerationMultiviewViews(active.generation_id, fragmentId, record, active.dimension);
		if (!views) throw new Error(`base multiview payload invalid for ${fragmentId}`);
		const summary = views.find((view) => view.kind === "summary");
		if (!summary) throw new Error(`base multiview summary missing for ${fragmentId}`);
		return {
			fragment_id: fragmentId,
			effective_layer: "base",
			source_content_hash: record.source_content_hash,
			input_hash: summary.input_hash,
			vector_hash: summary.vector_hash,
			vector_dimension: summary.vector_dimension,
			view_set_hash: record.view_set_hash,
			view_count: views.length,
		};
	}
	if (!record.input_hash) throw new Error(`base input hash missing for ${fragmentId}`);
		if (!record.vector_hash) throw new Error(`base vector hash missing for ${fragmentId}`);
	const vector = readJsonVector(generationVectorPath(active.generation_id, fragmentId));
	if (!vector) throw new Error(`base vector file missing or corrupt for ${fragmentId}`);
	if (vector.length !== active.dimension) {
		throw new Error(`base vector file dimension mismatch for ${fragmentId}: ${vector.length} != ${active.dimension}`);
	}
	const vectorHash = hashBytes(JSON.stringify(vector));
	if (vectorHash !== record.vector_hash) {
		throw new Error(`base vector hash mismatch for ${fragmentId}: ${record.vector_hash} != ${vectorHash}`);
	}
	return {
		fragment_id: fragmentId,
		effective_layer: "base",
		source_content_hash: record.source_content_hash,
		input_hash: record.input_hash,
		vector_hash: record.vector_hash,
		vector_dimension: record.dimension,
		view_set_hash: null,
		view_count: 1,
	};
}

function buildDeltaCompactionEntry(
	active: EmbeddingGenerationManifest,
	delta: EmbeddingDeltaManifest,
	fragmentId: string,
	record: EmbeddingDeltaRecord | undefined,
	liveSourceHash: string,
): CompactionMergeContractEntry {
	if (!record) throw new Error(`delta record missing for live fragment: ${fragmentId}`);
	if (record.fragment_id !== fragmentId) throw new Error(`delta fragment id mismatch for ${fragmentId}: ${record.fragment_id}`);
	if (record.delta_id !== delta.delta_id) throw new Error(`delta id mismatch for ${fragmentId}: ${record.delta_id} != ${delta.delta_id}`);
	if (record.state !== "materialized") throw new Error(`delta record is not materialized for ${fragmentId}: ${record.state}`);
	if (record.representation_identity_hash !== active.representation_identity_hash) {
		throw new Error(
			`delta representation identity mismatch for ${fragmentId}: ${record.representation_identity_hash} != ${active.representation_identity_hash}`,
		);
	}
	if (record.representation_identity_hash !== delta.representation_identity_hash) {
		throw new Error(
			`delta representation identity diverges from manifest for ${fragmentId}: ${record.representation_identity_hash} != ${delta.representation_identity_hash}`,
		);
	}
	if (record.source_content_hash !== liveSourceHash) {
		throw new Error(`delta source content hash mismatch for ${fragmentId}: ${record.source_content_hash} != ${liveSourceHash}`);
	}
	if (!record.constructed_input_hash) throw new Error(`delta input hash missing for ${fragmentId}`);
	if (!record.vector_hash) throw new Error(`delta vector hash missing for ${fragmentId}`);
	if (record.vector_dimension !== active.dimension) {
		throw new Error(`delta vector dimension mismatch for ${fragmentId}: ${record.vector_dimension} != ${active.dimension}`);
	}
	if (delta.representation_kind === "multiview") {
		if (!record.views?.length) throw new Error(`delta multiview payload missing for ${fragmentId}`);
		if (!record.view_set_hash) throw new Error(`delta multiview view_set_hash missing for ${fragmentId}`);
		if (record.view_set_hash !== viewSetHash(record.views)) {
			throw new Error(`delta multiview view_set_hash mismatch for ${fragmentId}`);
		}
		if (record.view_kind !== "summary" || !record.view_id) {
			throw new Error(`delta multiview summary identity invalid for ${fragmentId}`);
		}
		const views = readDeltaMultiviewViews(fragmentId, record, active.dimension);
		if (!views) throw new Error(`delta multiview payload invalid for ${fragmentId}`);
		const summaryMetadata = record.views.find((view) => view.view_id === record.view_id);
		if (!summaryMetadata || summaryMetadata.kind !== "summary") {
			throw new Error(`delta multiview summary metadata missing for ${fragmentId}`);
		}
		const summary = views.find((view) => view.view_id === record.view_id && view.kind === "summary");
		if (!summary) throw new Error(`delta multiview summary missing for ${fragmentId}`);
		if (record.constructed_input_hash !== summary.input_hash) {
			throw new Error(
				`delta multiview input hash mismatch for ${fragmentId}: ${record.constructed_input_hash} != ${summary.input_hash}`,
			);
		}
		if (record.vector_hash !== summary.vector_hash) {
			throw new Error(`delta multiview vector hash mismatch for ${fragmentId}: ${record.vector_hash} != ${summary.vector_hash}`);
		}
		if (record.vector_dimension !== summary.vector_dimension) {
			throw new Error(
				`delta multiview vector dimension mismatch for ${fragmentId}: ${record.vector_dimension} != ${summary.vector_dimension}`,
			);
		}
		if (canonicalCompare(record.source_spans) !== canonicalCompare(summaryMetadata.source_spans)) {
			throw new Error(`delta multiview source spans mismatch for ${fragmentId}`);
		}
		if (canonicalCompare(record.disclosure) !== canonicalCompare(summaryMetadata.disclosure)) {
			throw new Error(`delta multiview disclosure mismatch for ${fragmentId}`);
		}
		if (canonicalCompare(record.tokens) !== canonicalCompare(summaryMetadata.tokens)) {
			throw new Error(`delta multiview tokens mismatch for ${fragmentId}`);
		}
		return {
			fragment_id: fragmentId,
			effective_layer: "delta",
			source_content_hash: record.source_content_hash,
			input_hash: record.constructed_input_hash,
			vector_hash: record.vector_hash,
			vector_dimension: record.vector_dimension,
			view_set_hash: record.view_set_hash,
			view_count: views.length,
		};
	}
	const vector = readJsonVector(deltaVectorPath(fragmentId));
	if (!vector) throw new Error(`delta vector file missing or corrupt for ${fragmentId}`);
	if (vector.length !== active.dimension) {
		throw new Error(`delta vector file dimension mismatch for ${fragmentId}: ${vector.length} != ${active.dimension}`);
	}
	const vectorHash = hashBytes(JSON.stringify(vector));
	if (vectorHash !== record.vector_hash) {
		throw new Error(`delta vector hash mismatch for ${fragmentId}: ${record.vector_hash} != ${vectorHash}`);
	}
	return {
		fragment_id: fragmentId,
		effective_layer: "delta",
		source_content_hash: record.source_content_hash,
		input_hash: record.constructed_input_hash,
		vector_hash: record.vector_hash,
		vector_dimension: record.vector_dimension,
		view_set_hash: null,
		view_count: 1,
	};
}

export function planCompactionMergeContract(): CompactionMergeContract {
	const active = getActiveGeneration();
	const pointer = readActivePointer();
	const delta = readDeltaManifest();
	const compatibility = currentDeltaCompatibility();
	const effective = buildEffectiveEmbeddingView();
	if (!active) throw new Error("active generation not found");
	if (!pointer) throw new Error("active pointer missing");
	if (!delta) throw new Error("delta manifest missing");
	if (!compatibility.compatible) throw new Error(compatibility.reason ?? "delta incompatible with active generation");
	if (delta.state !== "sealed") throw new Error(`delta must be sealed for compaction planning: ${delta.state}`);
	if (pointer.active_generation_id !== active.generation_id) {
		throw new Error(`active pointer generation mismatch: ${pointer.active_generation_id} != ${active.generation_id}`);
	}
	if (pointer.active_manifest_hash !== active.manifest_content_hash) {
		throw new Error(`active pointer manifest hash mismatch: ${pointer.active_manifest_hash} != ${active.manifest_content_hash}`);
	}
	if (!effective.baseGeneration || effective.baseGeneration.generation_id !== active.generation_id) {
		throw new Error("effective view active generation mismatch");
	}
	if (!effective.deltaManifest || effective.deltaManifest.delta_id !== delta.delta_id) {
		throw new Error("effective view delta manifest mismatch");
	}
	if (delta.base_generation_id !== active.generation_id) {
		throw new Error(`delta base generation mismatch: ${delta.base_generation_id} != ${active.generation_id}`);
	}
	if (delta.base_manifest_hash !== active.manifest_content_hash) {
		throw new Error(`delta base manifest hash mismatch: ${delta.base_manifest_hash} != ${active.manifest_content_hash}`);
	}
	if (delta.source_schema_version !== active.source_schema_version) {
		throw new Error(`delta source schema mismatch: ${delta.source_schema_version} != ${active.source_schema_version}`);
	}
	const deltaIndex = readDeltaIndex();
	const baseIndex = readGenerationIndex(active.generation_id);
	const deltaCounts = summarizeDeltaIndex(deltaIndex);
	if (delta.record_count !== deltaCounts.record_count) {
		throw new Error(`delta record_count mismatch: ${delta.record_count} != ${deltaCounts.record_count}`);
	}
	if (delta.materialized_count !== deltaCounts.materialized_count) {
		throw new Error(`delta materialized_count mismatch: ${delta.materialized_count} != ${deltaCounts.materialized_count}`);
	}
	if (delta.failed_count !== deltaCounts.failed_count) {
		throw new Error(`delta failed_count mismatch: ${delta.failed_count} != ${deltaCounts.failed_count}`);
	}
	const liveFragmentIds = [...listAllFragmentIds()].sort((left, right) => left.localeCompare(right));
	for (let index = 1; index < liveFragmentIds.length; index += 1) {
		if (liveFragmentIds[index] === liveFragmentIds[index - 1]) {
			throw new Error(`duplicate live fragment id: ${liveFragmentIds[index]}`);
		}
	}
	const liveSet = new Set(liveFragmentIds);
	let tombstoneCount = 0;
	for (const [fragmentId, record] of Object.entries(deltaIndex)) {
		if (record.fragment_id !== fragmentId) throw new Error(`delta index fragment key mismatch: ${fragmentId} != ${record.fragment_id}`);
		if (record.delta_id !== delta.delta_id) throw new Error(`delta index delta_id mismatch for ${fragmentId}: ${record.delta_id} != ${delta.delta_id}`);
		if (record.state === "tombstone") {
			tombstoneCount += 1;
			if (liveSet.has(fragmentId)) throw new Error(`live source fragment cannot be tombstoned during compaction planning: ${fragmentId}`);
			continue;
		}
		if (record.state !== "materialized") {
			throw new Error(`delta record is not materialized for compaction planning: ${fragmentId} state=${record.state}`);
		}
		if (!liveSet.has(fragmentId)) {
			throw new Error(`delta materialized fragment has no live source: ${fragmentId}`);
		}
	}
	const entries: CompactionMergeContractEntry[] = [];
	let baseCount = 0;
	let deltaCount = 0;
	for (const fragmentId of liveFragmentIds) {
		const liveSourceHash = liveSourceHashOrThrow(fragmentId);
		const deltaRecord = deltaIndex[fragmentId];
		if (deltaRecord?.state === "tombstone") {
			throw new Error(`live source fragment cannot be tombstoned during compaction planning: ${fragmentId}`);
		}
		if (deltaRecord && deltaRecord.state !== "materialized") {
			throw new Error(`live source fragment has nonmaterialized delta record: ${fragmentId} state=${deltaRecord.state}`);
		}
		const resolved = effective.index.get(fragmentId);
		if (!resolved) throw new Error(`live source fragment has no effective layer: ${fragmentId}`);
		if (resolved.layer === "delta") {
			if (!deltaRecord) throw new Error(`effective delta layer missing delta record for ${fragmentId}`);
			if (!resolved.record || resolved.record.state !== "materialized") {
				throw new Error(`effective delta layer is not materialized for ${fragmentId}`);
			}
			entries.push(buildDeltaCompactionEntry(active, delta, fragmentId, deltaRecord, liveSourceHash));
			deltaCount += 1;
			continue;
		}
		if (deltaRecord) {
			throw new Error(`materialized delta record was not selected as effective layer for ${fragmentId}`);
		}
		if (resolved.record !== null) {
			throw new Error(`effective base layer unexpectedly carries a delta record for ${fragmentId}`);
		}
		entries.push(buildBaseCompactionEntry(active, fragmentId, baseIndex[fragmentId], liveSourceHash));
		baseCount += 1;
	}
	const sortedEntries = sortedCompactionEntries(entries);
	const contract: Omit<CompactionMergeContract, "contract_content_hash"> = {
		contract_schema_version: 1,
		base: {
			generation_id: active.generation_id,
			manifest_content_hash: active.manifest_content_hash,
			source_inventory_hash: active.source_inventory_hash,
		},
		active_pointer: {
			pointer_schema_version: pointer.pointer_schema_version,
			active_generation_id: pointer.active_generation_id,
			active_manifest_hash: pointer.active_manifest_hash,
		},
		delta: {
			delta_id: delta.delta_id,
			manifest_content_hash: delta.manifest_content_hash,
			state: "sealed",
			base_generation_id: delta.base_generation_id,
			base_manifest_hash: delta.base_manifest_hash,
			sequence: delta.sequence,
			record_count: delta.record_count,
			materialized_count: delta.materialized_count,
			failed_count: delta.failed_count,
		},
		representation: {
			kind: isMultiviewGeneration(active) ? "multiview" : "single",
			identity_hash: active.representation_identity_hash,
			dimension: active.dimension,
			source_schema_version: active.source_schema_version,
		},
		retrieval: {
			retrieval_epoch: active.retrieval_epoch ?? "",
			document_recipe_id: active.document_recipe_id,
			document_recipe_version: active.document_recipe_version,
			query_recipe_id: active.query_recipe_id,
			query_recipe_version: active.query_recipe_version,
			document_policy_version: active.document_policy_version ?? null,
			view_schema_version: active.view_schema_version ?? null,
			aggregation_mode: active.aggregation_mode ?? "",
			evidence_policy_id: active.evidence_policy_id ?? null,
		},
		source_inventory_hash: effectiveSourceInventoryHash(sortedEntries),
		effective_entry_hash: effectiveEntryHash(sortedEntries),
		fragment_counts: {
			live: liveFragmentIds.length,
			effective: sortedEntries.length,
			base: baseCount,
			delta: deltaCount,
			tombstone: tombstoneCount,
		},
		entries: sortedEntries,
	};
	return {
		...contract,
		contract_content_hash: compactionMergeContractHash(contract),
	};
}

export function setDeltaManifestState(state: EmbeddingDeltaManifest["state"]): EmbeddingDeltaManifest {
	const manifest = readDeltaManifest();
	if (!manifest) throw new Error("delta manifest missing");
	writeDeltaManifest({ ...manifest, state });
	return readDeltaManifest()!;
}

function activePointerHash(pointer: ReturnType<typeof readActivePointer>): string {
	if (!pointer) throw new Error("active pointer missing for hash");
	return hashBytes(canonicalJson(pointer));
}

function assertArchiveContractMatchesCurrentDelta(
	manifest: EmbeddingDeltaManifest,
	contract: CompactionMergeContract,
	targetGenerationId: string,
): void {
	const pointer = readActivePointer();
	if (!pointer) throw new Error("active pointer missing during delta archive");
	const active = readGenerationManifest(pointer.active_generation_id);
	if (!active) throw new Error(`active generation manifest missing during delta archive: ${pointer.active_generation_id}`);
	if (manifest.state !== "sealed") throw new Error(`delta must be sealed before archive: ${manifest.state}`);
	if (contract.delta.state !== "sealed") throw new Error(`compaction contract delta must be sealed: ${contract.delta.state}`);
	if (contract.delta.delta_id !== manifest.delta_id) throw new Error(`compaction contract delta id mismatch: ${contract.delta.delta_id} != ${manifest.delta_id}`);
	if (contract.delta.manifest_content_hash !== manifest.manifest_content_hash) {
		throw new Error(`compaction contract delta manifest mismatch: ${contract.delta.manifest_content_hash} != ${manifest.manifest_content_hash}`);
	}
	if (contract.delta.base_generation_id !== manifest.base_generation_id) {
		throw new Error(`compaction contract delta base generation mismatch: ${contract.delta.base_generation_id} != ${manifest.base_generation_id}`);
	}
	if (contract.delta.base_manifest_hash !== manifest.base_manifest_hash) {
		throw new Error(`compaction contract delta base manifest mismatch: ${contract.delta.base_manifest_hash} != ${manifest.base_manifest_hash}`);
	}
	if (contract.delta.sequence !== manifest.sequence) throw new Error(`compaction contract delta sequence mismatch: ${contract.delta.sequence} != ${manifest.sequence}`);
	if (contract.delta.record_count !== manifest.record_count) throw new Error(`compaction contract delta record_count mismatch: ${contract.delta.record_count} != ${manifest.record_count}`);
	if (contract.delta.materialized_count !== manifest.materialized_count) {
		throw new Error(`compaction contract delta materialized_count mismatch: ${contract.delta.materialized_count} != ${manifest.materialized_count}`);
	}
	if (contract.delta.failed_count !== manifest.failed_count) throw new Error(`compaction contract delta failed_count mismatch: ${contract.delta.failed_count} != ${manifest.failed_count}`);
	if (contract.base.generation_id !== manifest.base_generation_id) {
		throw new Error(`compaction contract base generation mismatch: ${contract.base.generation_id} != ${manifest.base_generation_id}`);
	}
	if (contract.base.manifest_content_hash !== manifest.base_manifest_hash) {
		throw new Error(`compaction contract base manifest mismatch: ${contract.base.manifest_content_hash} != ${manifest.base_manifest_hash}`);
	}
	if (contract.active_pointer.active_generation_id !== manifest.base_generation_id) {
		throw new Error(`compaction contract active/base generation mismatch: ${contract.active_pointer.active_generation_id} != ${manifest.base_generation_id}`);
	}
	if (contract.active_pointer.active_manifest_hash !== manifest.base_manifest_hash) {
		throw new Error(`compaction contract active/base manifest mismatch: ${contract.active_pointer.active_manifest_hash} != ${manifest.base_manifest_hash}`);
	}
	if (pointer.active_generation_id !== targetGenerationId) {
		throw new Error(`target generation is not active during delta archive verification: ${pointer.active_generation_id} != ${targetGenerationId}`);
	}
	if (pointer.previous_generation_id !== manifest.base_generation_id) {
		throw new Error(`active pointer previous generation mismatch during delta archive: ${pointer.previous_generation_id} != ${manifest.base_generation_id}`);
	}
	if (active.generation_id !== targetGenerationId) {
		throw new Error(`active generation id mismatch during delta archive: ${active.generation_id} != ${targetGenerationId}`);
	}
	if (active.manifest_content_hash !== pointer.active_manifest_hash) {
		throw new Error(`active pointer manifest mismatch during delta archive: ${active.manifest_content_hash} != ${pointer.active_manifest_hash}`);
	}
}

export function archiveCurrentDelta(targetGenerationId: string, contract?: CompactionMergeContract): string | null {
	const manifest = readDeltaManifest();
	if (!manifest) return null;
	const activePointer = readActivePointer();
	if (!activePointer) throw new Error("active pointer missing during delta archive");
	const pointerHash = activePointerHash(activePointer);
	const targetManifest = readGenerationManifest(targetGenerationId);
	if (!targetManifest) throw new Error(`target generation manifest missing during delta archive: ${targetGenerationId}`);
	if (activePointer.active_generation_id !== targetGenerationId) {
		throw new Error(`target generation is not active during delta archive: ${activePointer.active_generation_id} != ${targetGenerationId}`);
	}
	if (targetManifest.manifest_content_hash !== activePointer.active_manifest_hash) {
		throw new Error(`target pointer manifest hash mismatch during delta archive: ${targetManifest.manifest_content_hash} != ${activePointer.active_manifest_hash}`);
	}
	if (contract) assertArchiveContractMatchesCurrentDelta(manifest, contract, targetGenerationId);
	ensureDir(DELTA_ARCHIVE_BASE);
	const archiveDir = path.join(DELTA_ARCHIVE_BASE, `${manifest.delta_id}-into-${targetGenerationId}`);
	ensureDir(archiveDir);
	for (const entry of ["manifest.json", "delta_index.json", "vectors"]) {
		const source = path.join(DELTA_BASE, entry);
		if (!fs.existsSync(source)) continue;
		const destination = path.join(archiveDir, entry);
		if (fs.statSync(source).isDirectory()) {
			fs.cpSync(source, destination, { recursive: true });
		} else {
			fs.copyFileSync(source, destination);
		}
	}
	if (contract) {
		const receipt: CompactionArchiveMergeReceipt = {
			receipt_schema_version: 1,
			archive_delta_id: manifest.delta_id,
			archive_manifest_hash: manifest.manifest_content_hash,
			contract_hash: contract.contract_content_hash,
			base: {
				generation_id: contract.base.generation_id,
				manifest_hash: contract.base.manifest_content_hash,
				source_inventory_hash: contract.base.source_inventory_hash,
			},
			delta: {
				delta_id: manifest.delta_id,
				manifest_hash: manifest.manifest_content_hash,
				state: "sealed",
				base_generation_id: manifest.base_generation_id,
				base_manifest_hash: manifest.base_manifest_hash,
				pointer_generation_id: activePointer.previous_generation_id ?? contract.base.generation_id,
				pointer_manifest_hash: contract.delta.base_manifest_hash,
				record_count: manifest.record_count,
				materialized_count: manifest.materialized_count,
				failed_count: manifest.failed_count,
			},
			target: {
				generation_id: targetManifest.generation_id,
				manifest_hash: targetManifest.manifest_content_hash,
				pointer_manifest_hash: activePointer.active_manifest_hash,
				pointer_hash: pointerHash,
				source_inventory_hash: targetManifest.source_inventory_hash,
				expected_count: targetManifest.expected_count,
				materialized_count: targetManifest.materialized_count,
			},
			merge: {
				source_inventory_hash: contract.source_inventory_hash,
				effective_entry_hash: contract.effective_entry_hash,
				live_fragment_count: contract.fragment_counts.live,
				effective_fragment_count: contract.fragment_counts.effective,
				base_fragment_count: contract.fragment_counts.base,
				delta_fragment_count: contract.fragment_counts.delta,
				tombstone_count: contract.fragment_counts.tombstone,
			},
			archived_at: nowIso(),
		};
		atomicWrite(path.join(archiveDir, "merge_receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
	}
	writeDeltaManifest({ ...manifest, state: "merged" });
	return archiveDir;
}

export function resetDeltaForActiveGeneration(): EmbeddingDeltaManifest {
	const { active, activeManifestHash } = activeBaseOrThrow();
	if (fs.existsSync(DELTA_INDEX_PATH)) fs.unlinkSync(DELTA_INDEX_PATH);
	if (fs.existsSync(DELTA_MANIFEST_PATH)) fs.unlinkSync(DELTA_MANIFEST_PATH);
	if (fs.existsSync(DELTA_VECTORS_BASE)) fs.rmSync(DELTA_VECTORS_BASE, { recursive: true, force: true });
	ensureDir(DELTA_VECTORS_BASE);
	const manifest = createDeltaManifest(active, activeManifestHash);
	writeDeltaManifest(manifest);
	writeDeltaIndex({});
	return readDeltaManifest()!;
}

export function createPendingDeltaRecord(manifest: EmbeddingDeltaManifest, fragmentId: string, failure: string): EmbeddingDeltaRecord {
	const index = readDeltaIndex();
	const record: EmbeddingDeltaRecord = {
		record_schema_version: 1,
		delta_id: manifest.delta_id,
		fragment_id: fragmentId,
		state: "pending",
		operation: "reconcile",
		source_content_hash: null,
		constructed_input_hash: null,
		vector_hash: null,
		vector_dimension: null,
		representation_identity_hash: manifest.representation_identity_hash,
		tokens: {},
		created_at: nowIso(),
		failure,
	};
	index[fragmentId] = record;
	writeDeltaIndex(index);
	const all = Object.values(index);
	writeDeltaManifest({
		...manifest,
		record_count: all.length,
		materialized_count: all.filter((item) => item.state === "materialized").length,
		failed_count: all.filter((item) => item.state !== "materialized" && item.state !== "tombstone").length,
	});
	return record;
}

export type ReconcileRebuildResult =
	| { representation_kind: "single"; vector: number[]; inputHash: string; sourceHash: string; tokens: unknown }
	| { representation_kind: "multiview"; sourceHash: string; views: MaterializedDeltaView[] }
	| { vector: number[]; inputHash: string; sourceHash: string; tokens: unknown };

export interface EffectiveMultiviewView {
	fragment_id: string;
	view_id: string;
	kind: "summary" | "evidence";
	vector: number[];
	input_hash: string;
	vector_hash: string;
	vector_dimension: number;
	 source_spans: EmbeddingSourceSpan[];
	disclosure: EmbeddingViewDisclosure;
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

export function readDeltaMultiviewViews(
	fragmentId: string,
	record: EmbeddingDeltaRecord | undefined,
	dimension: number,
): EffectiveMultiviewView[] | null {
	if (!record || record.state !== "materialized" || !record.views?.length || record.views.filter((view) => view.kind === "summary").length !== 1) return null;
	const summaryVector = readJsonVector(deltaVectorPath(fragmentId));
	if (!summaryVector || summaryVector.length !== dimension) return null;
	if (!fs.existsSync(multiviewSidecarPath(fragmentId))) return null;
	try {
		const sidecar = JSON.parse(fs.readFileSync(multiviewSidecarPath(fragmentId), "utf8")) as {
			view_schema_version?: number;
			fragment_id?: string;
			source_content_hash?: string;
			views?: Record<string, unknown>;
		};
		if (sidecar.view_schema_version !== 1 || sidecar.fragment_id !== fragmentId || sidecar.source_content_hash !== record.source_content_hash || !sidecar.views) return null;
		const viewIds = record.views.map((view) => view.view_id).sort();
		const sidecarIds = Object.keys(sidecar.views).sort();
		if (JSON.stringify(viewIds) !== JSON.stringify(sidecarIds)) return null;
		const result: EffectiveMultiviewView[] = [];
		for (const view of record.views) {
			const vector = sidecar.views[view.view_id];
			if (!Array.isArray(vector) || vector.length !== dimension || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
			const vectorHash = hashBytes(JSON.stringify(vector));
			if (vectorHash !== view.vector_hash || view.vector_dimension !== dimension) return null;
			if (view.kind === "summary" && (vectorHash !== record.vector_hash || JSON.stringify(vector) !== JSON.stringify(summaryVector))) return null;
			result.push({ fragment_id: fragmentId, view_id: view.view_id, kind: view.kind, vector, input_hash: view.input_hash, vector_hash: view.vector_hash, vector_dimension: view.vector_dimension, source_spans: view.source_spans, disclosure: view.disclosure });
		}
		return result;
	} catch {
		return null;
	}
}

function isCompleteMaterializedDelta(manifest: EmbeddingDeltaManifest, fragmentId: string, record: EmbeddingDeltaRecord | undefined): boolean {
	if (!record || record.state !== "materialized") return false;
	const active = getActiveGeneration();
	if (!active || record.representation_identity_hash !== active.representation_identity_hash) return false;
	const summary = readJsonVector(deltaVectorPath(fragmentId));
	if (!summary || summary.length !== active.dimension) return false;
	if (manifest.representation_kind !== "multiview") return true;
	return readDeltaMultiviewViews(fragmentId, record, active.dimension) !== null;
}

export async function reconcileOrphans(
	rebuild: (fragmentId: string) => Promise<ReconcileRebuildResult>,
): Promise<{ repaired_orphans: number; tombstoned_orphans: number; pending_count: number }> {
	const active = getActiveGeneration();
	if (!active) return { repaired_orphans: 0, tombstoned_orphans: 0, pending_count: 0 };
	const manifest = ensureActiveDelta();
	const index = readDeltaIndex();
	const baseIndex = readGenerationIndex(active.generation_id);
	const sourceIds = new Set(listAllFragmentIds());
	let repaired = 0;
	let tombstoned = 0;
	let pending = 0;
	for (const fragmentId of sourceIds) {
		if (isCompleteMaterializedDelta(manifest, fragmentId, index[fragmentId])) continue;
		const baseRecord = baseIndex[fragmentId];
		if (baseRecord && (active.representation_kind === "multiview" ? readGenerationMultiviewViews(active.generation_id, fragmentId, baseRecord, active.dimension) !== null : fs.existsSync(generationVectorPath(active.generation_id, fragmentId)))) continue;
		try {
			const rebuilt = await rebuild(fragmentId);
			if (active.representation_kind === "multiview") {
				if (!("representation_kind" in rebuilt) || rebuilt.representation_kind !== "multiview") throw new Error("multiview reconcile payload required");
				upsertDeltaViews(manifest, fragmentId, rebuilt.sourceHash, rebuilt.views, "reconcile");
			} else {
				if ("representation_kind" in rebuilt && rebuilt.representation_kind === "multiview") throw new Error("single-view reconcile payload required");
				upsertDeltaRecord(manifest, fragmentId, rebuilt.vector, rebuilt.inputHash, rebuilt.sourceHash, rebuilt.tokens, "reconcile");
			}
			repaired++;
		} catch (error) {
			pending++;
			createPendingDeltaRecord(manifest, fragmentId, error instanceof Error ? `reconcile_failed:${error.message}` : "reconcile_failed");
		}
	}
	for (const fragmentId of Object.keys(readDeltaIndex())) {
		const current = readDeltaIndex()[fragmentId];
		if (!sourceIds.has(fragmentId) && current.state !== "tombstone") {
			writeDeltaTombstone(fragmentId, "reconcile");
			tombstoned++;
		}
	}
	return { repaired_orphans: repaired, tombstoned_orphans: tombstoned, pending_count: pending };
}
