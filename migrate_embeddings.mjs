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
		import(pathToFileURL(path.join(ROOT, "dist/embedding/delta.js")).href),
	]);
}
function parseRepresentationKind(value) {
	const normalized = value ?? "single";
	if (normalized === "single" || normalized === "multiview") return normalized;
	throw new Error(`invalid --representation: ${normalized} (expected single or multiview)`);
}
function fragmentInput(fragment) {
	return {
		task_desc: fragment.task_desc,
		result_desc: fragment.result_desc,
		tags: fragment.tags,
		topic_name: fragment.topic_name,
		turns_text: fragment.turns_text,
	};
}
function createViewCounts() {
	return { total: 0, summary: 0, evidence: 0 };
}
function accumulateViewCounts(counts, views) {
	for (const view of views) {
		counts.total++;
		if (view.kind === "summary") counts.summary++;
		if (view.kind === "evidence") counts.evidence++;
	}
}
function inventory(fragments) {
	const rows = fragments.listAllFragmentIds().sort().map((fragmentId) => {
		const fragment = fragments.getFragment(fragmentId);
		if (!fragment) throw new Error(`source fragment unreadable: ${fragmentId}`);
		return {
			fragment_id: fragmentId,
			source_content_hash: builder.sourceContentHash(fragmentInput(fragment)),
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
	const representationKind = generation.isMultiviewGeneration(manifest) ? "multiview" : "single";
	const sharedValidation = generation.validateGenerationRecords(manifest, index, result.rows, result.hash);
	const failures = [...sharedValidation.failures];
	if (!manifestIdentityMatches(manifest, tokenizer)) failures.push("runtime identity mismatch");
	const validation = { ...sharedValidation, failures, valid: failures.length === 0 };
	return {
		manifest,
		result,
		representationKind,
		validation,
		viewCounts: validation.view_counts ?? null,
		valid: validation.valid,
		failures,
	};
}
function report(payload) { console.log(JSON.stringify(payload, null, 2)); }

const [fragments, builderModule, providerModule, generationModule, deltaModule] = await loadModules();
const builder = builderModule;
const provider = providerModule;
const generation = generationModule;
const delta = deltaModule;

if (!command || !["inventory", "build", "validate", "switch", "rollback"].includes(command)) {
	console.error("Usage: node migrate_embeddings.mjs inventory|build|validate|switch|rollback [--generation ID] [--representation single|multiview] [--memory-root PATH]");
	process.exit(2);
}

if (command === "inventory") {
	const result = inventory(fragments);
	report({ command, memory_root: memoryRoot, fragment_count: result.rows.length, source_inventory_hash: result.hash, rows: result.rows });
	process.exit(0);
}

if (command === "build") {
	const generationId = options.get("generation") || `gen_${Date.now()}`;
	const representationKind = parseRepresentationKind(options.get("representation"));
	const result = inventory(fragments);
	await generation.createGeneration(generationId, result.hash, 384, representationKind);
	const buildManifest = generation.setGenerationExpectedCount(generationId, result.rows.length);
	let ok = 0;
	const failures = [];
	const viewCounts = representationKind === "multiview" ? createViewCounts() : null;
	for (const row of result.rows) {
		const fragment = fragments.getFragment(row.fragment_id);
		try {
			const input = fragmentInput(fragment);
			if (representationKind === "multiview") {
				const builtViews = await builder.buildDocumentViews(input, buildManifest);
				if (builtViews.source_content_hash !== row.source_content_hash) throw new Error("source hash mismatch after multiview build");
				const encodedViews = [];
				for (const view of builtViews.views) {
					encodedViews.push({ ...view, vector: await provider.encodeStrict(view.text) });
				}
				generation.writeGenerationViews(buildManifest, row.fragment_id, builtViews.source_content_hash, encodedViews);
				accumulateViewCounts(viewCounts, encodedViews);
			} else {
				const built = await builder.buildDocumentInput(input, buildManifest);
				const vector = await provider.encodeStrict(built.text);
				generation.writeGenerationVector(buildManifest, row.fragment_id, vector, {
					source_content_hash: row.source_content_hash,
					input_hash: built.input_hash,
					tokens: built.tokens,
				});
			}
			ok++;
		} catch (error) {
			failures.push({ fragment_id: row.fragment_id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const ready = generation.finalizeGeneration(generationId);
	report({
		command,
		generation_id: generationId,
		representation_kind: ready.representation_kind ?? representationKind,
		source_inventory_hash: result.hash,
		expected: result.rows.length,
		materialized: ok,
		failed: failures.length,
		state: ready.state,
		...(viewCounts ? { view_counts: viewCounts } : {}),
		failures,
	});
	process.exit(failures.length ? 1 : 0);
}

if (command === "validate") {
	const generationId = options.get("generation");
	if (!generationId) throw new Error("--generation is required");
	const checked = await validateGeneration(generationId);
	report({
		command,
		generation_id: generationId,
		representation_kind: checked.representationKind,
		source_inventory_hash: checked.result.hash,
		expected: checked.result.rows.length,
		materialized: checked.validation.materialized_count,
		coverage: checked.validation.searchable_coverage,
		...(checked.viewCounts ? { view_counts: checked.viewCounts } : {}),
		failures: checked.failures,
		valid: checked.valid,
	});
	process.exit(checked.valid ? 0 : 1);
}

if (command === "switch") {
	const generationId = options.get("generation");
	if (!generationId) throw new Error("--generation is required");
	const checked = await validateGeneration(generationId);
	generation.assertGenerationReadyForActivation(checked.manifest, checked.validation);
	const live = inventory(fragments);
	if (live.hash !== checked.manifest.source_inventory_hash) throw new Error("source changed before switch; stop migration");
	delta.assertMigrationSwitchDeltaSafe();
	const pointer = generation.activateGeneration(generationId);
	report({ command, pointer, source_inventory_hash: live.hash, smoke: { active_generation_id: pointer.active_generation_id } });
	process.exit(0);
}

if (command === "rollback") {
	if (!fs.existsSync(pointerPath)) throw new Error("active pointer not found");
	const current = readJson(pointerPath);
	if (!current.previous_generation_id) throw new Error("no previous generation available");
	const previous = readManifest(current.previous_generation_id);
	const live = inventory(fragments);
	const previousIndex = readJson(generationPaths(current.previous_generation_id).index);
	const validation = generation.validateGenerationRecords(previous, previousIndex, live.rows, live.hash);
	generation.assertGenerationReadyForActivation(previous, validation);
	delta.assertMigrationSwitchDeltaSafe();
	const pointer = generation.activateGeneration(current.previous_generation_id);
	report({ command, pointer, source_inventory_hash: live.hash });
}
