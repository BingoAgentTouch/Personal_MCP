import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
	ActiveEmbeddingPointer,
	EmbeddingGenerationManifest,
	EmbeddingGenerationRecord,
} from "../types.js";
import { MODEL_ID } from "./provider.js";
import {
	DOCUMENT_RECIPE_ID,
	DOCUMENT_RECIPE_VERSION,
	QUERY_RECIPE_ID,
	QUERY_RECIPE_VERSION,
	getTokenizerManifest,
} from "./builder.js";

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

function atomicWrite(filePath: string, content: string): void {
	ensureDir(path.dirname(filePath));
	const tempPath = `${filePath}.tmp`;
	fs.writeFileSync(tempPath, content, "utf8");
	fs.renameSync(tempPath, filePath);
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

export function getActiveGeneration(): EmbeddingGenerationManifest | null {
	const pointer = readActivePointer();
	if (!pointer) return null;
	const manifest = readGenerationManifest(pointer.active_generation_id);
	if (!manifest) throw new Error(`active generation manifest missing: ${pointer.active_generation_id}`);
	if (manifest.state !== "ready" && manifest.state !== "active") throw new Error(`active generation is not ready: ${manifest.generation_id}`);
	if (manifest.manifest_content_hash !== pointer.active_manifest_hash) throw new Error("active pointer manifest hash mismatch");
	return manifest;
}

export async function createGeneration(generationId: string, sourceInventoryHash: string, dimension = 384): Promise<EmbeddingGenerationManifest> {
	if (readGenerationManifest(generationId)) throw new Error(`generation already exists: ${generationId}`);
	const tokenizer = await getTokenizerManifest();
	const manifest: EmbeddingGenerationManifest = {
		manifest_schema_version: 1,
		generation_id: generationId,
		state: "building",
		document_recipe_id: DOCUMENT_RECIPE_ID,
		document_recipe_version: DOCUMENT_RECIPE_VERSION,
		query_recipe_id: QUERY_RECIPE_ID,
		query_recipe_version: QUERY_RECIPE_VERSION,
		embedding_model_id: MODEL_ID,
		embedding_model_revision: null,
		tokenizer_id: tokenizer.tokenizer_id,
		tokenizer_revision: tokenizer.tokenizer_revision,
		runtime_identity: "@xenova/transformers@2.17.2;node",
		pooling: "mean",
		normalize: true,
		quantized: true,
		dimension,
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
