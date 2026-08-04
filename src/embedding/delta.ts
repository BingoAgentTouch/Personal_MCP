import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
	EmbeddingDeltaManifest,
	EmbeddingDeltaRecord,
	EmbeddingDeltaRecordState,
	EmbeddingGenerationManifest,
	EmbeddingHealthSnapshot,
} from "../types.js";
import {
	DOCUMENT_RECIPE_ID,
	DOCUMENT_RECIPE_VERSION,
	QUERY_RECIPE_ID,
	QUERY_RECIPE_VERSION,
	sourceContentHash,
} from "./builder.js";
import {
	generationVectorPath,
	getActiveGeneration,
	readActivePointer,
	readGenerationIndex,
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

function nowIso(): string {
	return new Date().toISOString();
}

function nextDeltaId(): string {
	const stamp = nowIso().slice(0, 10).replace(/-/g, "");
	return `delta_${stamp}_001`;
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
		delta_schema_version: 1,
		delta_id: nextDeltaId(),
		state: "active",
		base_generation_id: active.generation_id,
		base_manifest_hash: activeManifestHash,
		representation_identity_hash: active.representation_identity_hash,
		document_recipe_id: DOCUMENT_RECIPE_ID,
		document_recipe_version: DOCUMENT_RECIPE_VERSION,
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
	return { active, delta, compatible: true };
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

export function upsertDeltaRecord(
	manifest: EmbeddingDeltaManifest,
	fragmentId: string,
	vector: number[],
	inputHash: string,
	sourceHash: string,
	tokens: unknown,
	operation: EmbeddingDeltaRecord["operation"] = "create",
): EmbeddingDeltaRecord {
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
				if (!fs.existsSync(generationVectorPath(active.generation_id, fragmentId))) corrupt++;
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

export function setDeltaManifestState(state: EmbeddingDeltaManifest["state"]): EmbeddingDeltaManifest {
	const manifest = readDeltaManifest();
	if (!manifest) throw new Error("delta manifest missing");
	writeDeltaManifest({ ...manifest, state });
	return readDeltaManifest()!;
}

export function archiveCurrentDelta(targetGenerationId: string): string | null {
	const manifest = readDeltaManifest();
	if (!manifest) return null;
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

export async function reconcileOrphans(
	rebuild: (fragmentId: string) => Promise<{ vector: number[]; inputHash: string; sourceHash: string; tokens: unknown }>,
): Promise<{ repaired_orphans: number; tombstoned_orphans: number; pending_count: number }> {
	const active = getActiveGeneration();
	if (!active) return { repaired_orphans: 0, tombstoned_orphans: 0, pending_count: 0 };
	const manifest = ensureActiveDelta();
	const index = readDeltaIndex();
	const sourceIds = new Set(listAllFragmentIds());
	let repaired = 0;
	let tombstoned = 0;
	let pending = 0;
	for (const fragmentId of sourceIds) {
		if (index[fragmentId]?.state === "materialized") continue;
		const baseRecord = readGenerationIndex(active.generation_id)[fragmentId];
		if (baseRecord && fs.existsSync(generationVectorPath(active.generation_id, fragmentId))) continue;
		try {
			const rebuilt = await rebuild(fragmentId);
			upsertDeltaRecord(manifest, fragmentId, rebuilt.vector, rebuilt.inputHash, rebuilt.sourceHash, rebuilt.tokens, "reconcile");
			repaired++;
		} catch {
			pending++;
			createPendingDeltaRecord(manifest, fragmentId, "reconcile_failed");
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
