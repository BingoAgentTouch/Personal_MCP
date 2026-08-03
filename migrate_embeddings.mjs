#!/usr/bin/env node
// Offline generation migration runner.
// Run from the memory project root: node <server>/migrate_embeddings.mjs <command> [options]
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];
const options = new Map();
for (let i = 3; i < process.argv.length; i++) {
	if (process.argv[i].startsWith("--")) options.set(process.argv[i].slice(2), process.argv[++i] ?? "");
}

const memoryRoot = path.resolve(options.get("memory-root") ?? "memory");
const sourceRoot = path.join(memoryRoot, "fragments");
const generationRoot = path.join(memoryRoot, "embedding_generations");
const pointerPath = path.join(memoryRoot, "embedding_active.json");
// Storage modules resolve memory/ relative to CWD; align it with --memory-root before import.
process.chdir(path.dirname(memoryRoot));

function hash(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
	return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function atomicWrite(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, file);
}
function loadModules() {
	return Promise.all([
		import(pathToFileURL(path.join(ROOT, "dist/storage/fragments.js")).href),
		import(pathToFileURL(path.join(ROOT, "dist/embedding/builder.js")).href),
		import(pathToFileURL(path.join(ROOT, "dist/embedding/provider.js")).href),
		import(pathToFileURL(path.join(ROOT, "dist/embedding/generation.js")).href),
	]);
}
function inventory(fragments) {
	const rows = fragments.listAllFragmentIds().sort().map((fragmentId) => {
		const fragment = fragments.getFragment(fragmentId);
		if (!fragment) throw new Error(`source fragment unreadable: ${fragmentId}`);
		return {
			fragment_id: fragmentId,
			source_content_hash: builder.sourceContentHash({
				task_desc: fragment.task_desc,
				result_desc: fragment.result_desc,
				tags: fragment.tags,
				topic_name: fragment.topic_name,
				turns_text: fragment.turns_text,
			}),
		};
	});
	return { rows, hash: hash(canonicalJson(rows)) };
}
function generationPaths(id) {
	const dir = path.join(generationRoot, id);
	return { dir, manifest: path.join(dir, "manifest.json"), index: path.join(dir, "generation_index.json") };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function readManifest(id) { return readJson(generationPaths(id).manifest); }
function verifyManifest(manifest) {
	const { manifest_content_hash: stored, ...payload } = manifest;
	if (stored !== hash(canonicalJson(payload))) throw new Error(`manifest hash mismatch: ${manifest.generation_id}`);
}
function manifestIdentityMatches(manifest, tokenizer) {
	return manifest.embedding_model_id === provider.MODEL_ID &&
		manifest.tokenizer_id === tokenizer.tokenizer_id &&
		manifest.model_max_length === tokenizer.model_max_length &&
		manifest.special_token_reserve === tokenizer.special_token_reserve &&
		manifest.dimension > 0;
}
async function validateGeneration(generationId) {
	const manifest = readManifest(generationId);
	verifyManifest(manifest);
	const result = inventory(fragments);
	const index = readJson(generationPaths(generationId).index);
	const tokenizer = await builder.getTokenizerManifest();
	const failures = [];
	if (manifest.state !== "ready" && manifest.state !== "active") failures.push(`generation state is ${manifest.state}`);
	if (manifest.source_inventory_hash !== result.hash) failures.push("source inventory hash mismatch");
	if (!manifestIdentityMatches(manifest, tokenizer)) failures.push("runtime identity mismatch");
	if (manifest.expected_count !== result.rows.length) failures.push("expected count mismatch");
	if (manifest.materialized_count !== result.rows.length || manifest.failed_count !== 0) failures.push("materialization count mismatch");
	if (manifest.searchable_coverage !== 1) failures.push("searchable coverage is not 1");
	for (const row of result.rows) {
		const record = index[row.fragment_id];
		if (!record) { failures.push(`${row.fragment_id}: missing record`); continue; }
		if (record.source_content_hash !== row.source_content_hash) failures.push(`${row.fragment_id}: source hash mismatch`);
		const vectorPath = path.join(generationPaths(generationId).dir, "vectors", row.fragment_id.split("/")[0], `${row.fragment_id.split("/")[1]}.embedding`);
		if (!fs.existsSync(vectorPath)) { failures.push(`${row.fragment_id}: missing vector`); continue; }
		const bytes = fs.readFileSync(vectorPath);
		if (hash(bytes) !== record.vector_hash) failures.push(`${row.fragment_id}: vector hash mismatch`);
		const vector = JSON.parse(bytes.toString("utf8"));
		if (!Array.isArray(vector) || vector.length !== manifest.dimension || vector.some((value) => !Number.isFinite(value))) failures.push(`${row.fragment_id}: vector invalid`);
	}
	return { manifest, result, failures };
}
function report(payload) { console.log(JSON.stringify(payload, null, 2)); }

const [fragments, builderModule, providerModule, generationModule] = await loadModules();
const builder = builderModule;
const provider = providerModule;
const generation = generationModule;

if (!command || !["inventory", "build", "validate", "switch", "rollback"].includes(command)) {
	console.error("Usage: node migrate_embeddings.mjs inventory|build|validate|switch|rollback [--generation ID] [--memory-root PATH]");
	process.exit(2);
}

if (command === "inventory") {
	const result = inventory(fragments);
	report({ command, memory_root: memoryRoot, fragment_count: result.rows.length, source_inventory_hash: result.hash, rows: result.rows });
	process.exit(0);
}

if (command === "build") {
	const generationId = options.get("generation") || `gen_${Date.now()}`;
	const result = inventory(fragments);
	const manifest = await generation.createGeneration(generationId, result.hash, 384);
	const buildManifest = generation.setGenerationExpectedCount(generationId, result.rows.length);
	let ok = 0;
	const failures = [];
	for (const row of result.rows) {
		const fragment = fragments.getFragment(row.fragment_id);
		try {
			const built = await builder.buildDocumentInput({
				task_desc: fragment.task_desc,
				result_desc: fragment.result_desc,
				tags: fragment.tags,
				topic_name: fragment.topic_name,
				turns_text: fragment.turns_text,
			});
			const vector = await provider.encodeStrict(built.text);
			generation.writeGenerationVector(buildManifest, row.fragment_id, vector, {
				source_content_hash: row.source_content_hash,
				input_hash: built.input_hash,
				tokens: built.tokens,
			});
			ok++;
		} catch (error) {
			failures.push({ fragment_id: row.fragment_id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const ready = generation.finalizeGeneration(generationId);
	report({ command, generation_id: generationId, source_inventory_hash: result.hash, expected: result.rows.length, materialized: ok, failed: failures.length, state: ready.state, failures });
	process.exit(failures.length ? 1 : 0);
}

if (command === "validate") {
	const generationId = options.get("generation");
	if (!generationId) throw new Error("--generation is required");
	const checked = await validateGeneration(generationId);
	const { manifest, result, failures } = checked;
	report({ command, generation_id: generationId, source_inventory_hash: result.hash, expected: result.rows.length, materialized: manifest.materialized_count, coverage: manifest.searchable_coverage, failures, valid: failures.length === 0 });
	process.exit(failures.length ? 1 : 0);
}

if (command === "switch") {
	const generationId = options.get("generation");
	if (!generationId) throw new Error("--generation is required");
	const checked = await validateGeneration(generationId);
	const { manifest, result: before } = checked;
	if (checked.failures.length) throw new Error(`identity/integrity validation failed: ${checked.failures.join("; ")}`);
	if (before.hash !== manifest.source_inventory_hash) throw new Error("source changed before switch; stop migration");
	const pointer = generation.activateGeneration(generationId);
	report({ command, pointer, source_inventory_hash: before.hash, smoke: { active_generation_id: pointer.active_generation_id } });
	process.exit(0);
}

if (command === "rollback") {
	if (!fs.existsSync(pointerPath)) throw new Error("active pointer not found");
	const current = readJson(pointerPath);
	if (!current.previous_generation_id) throw new Error("no previous generation available");
	const previous = readManifest(current.previous_generation_id);
	if (previous.state !== "active" && previous.state !== "ready") throw new Error("previous generation is not ready");
	const pointer = generation.activateGeneration(current.previous_generation_id);
	report({ command, pointer });
}
