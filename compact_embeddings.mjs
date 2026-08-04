#!/usr/bin/env node
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
process.chdir(path.dirname(memoryRoot));

function hash(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a, b], [c, d]) => String(a).localeCompare(String(c))).map(([k, v]) => [k, canonical(v)]));
	return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function report(payload) { console.log(JSON.stringify(payload, null, 2)); }

function loadModules() {
	return Promise.all([
		import(pathToFileURL(path.join(ROOT, "dist/storage/fragments.js")).href),
		import(pathToFileURL(path.join(ROOT, "dist/embedding/builder.js")).href),
		import(pathToFileURL(path.join(ROOT, "dist/embedding/provider.js")).href),
		import(pathToFileURL(path.join(ROOT, "dist/embedding/generation.js")).href),
		import(pathToFileURL(path.join(ROOT, "dist/embedding/delta.js")).href),
	]);
}

const [fragments, builder, provider, generation, delta] = await loadModules();

if (!command || !["preflight", "build", "validate", "switch", "unlock"].includes(command)) {
	console.error("Usage: node compact_embeddings.mjs preflight|build|validate|switch|unlock [--generation ID] [--memory-root PATH]");
	process.exit(2);
}

function inventory() {
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

async function validateGeneration(generationId, expectedInventoryHash) {
	const manifest = generation.readGenerationManifest(generationId);
	if (!manifest) throw new Error(`generation not found: ${generationId}`);
	const result = inventory();
	const index = generation.readGenerationIndex(generationId);
	const failures = [];
	if (manifest.state !== "ready" && manifest.state !== "active") failures.push(`generation state is ${manifest.state}`);
	if (expectedInventoryHash && manifest.source_inventory_hash !== expectedInventoryHash) failures.push("source inventory hash mismatch vs build snapshot");
	if (manifest.source_inventory_hash !== result.hash) failures.push("source inventory hash mismatch vs live source");
	if (manifest.expected_count !== result.rows.length) failures.push("expected count mismatch");
	if (manifest.materialized_count !== result.rows.length || manifest.failed_count !== 0) failures.push("materialization count mismatch");
	if (manifest.searchable_coverage !== 1) failures.push("searchable coverage is not 1");
	for (const row of result.rows) {
		const record = index[row.fragment_id];
		if (!record) { failures.push(`${row.fragment_id}: missing record`); continue; }
		if (record.source_content_hash !== row.source_content_hash) failures.push(`${row.fragment_id}: source hash mismatch`);
		const vectorPath = generation.generationVectorPath(generationId, row.fragment_id);
		if (!fs.existsSync(vectorPath)) { failures.push(`${row.fragment_id}: missing vector`); continue; }
		const bytes = fs.readFileSync(vectorPath);
		if (hash(bytes) !== record.vector_hash) failures.push(`${row.fragment_id}: vector hash mismatch`);
	}
	return { manifest, result, failures };
}

if (command === "unlock") {
	delta.removeCompactionLock();
	report({ command, unlocked: true });
	process.exit(0);
}

if (command === "preflight") {
	delta.createCompactionLock();
	const active = generation.getActiveGeneration();
	if (!active) throw new Error("active generation not found");
	const ensured = delta.ensureActiveDelta();
	const compatibility = delta.currentDeltaCompatibility();
	if (!compatibility.compatible) throw new Error(compatibility.reason ?? "delta incompatible");
	delta.setDeltaManifestState("sealed");
	const inv = inventory();
	report({
		command,
		active_generation_id: active.generation_id,
		delta_id: ensured.delta_id,
		source_inventory_hash: inv.hash,
		fragment_count: inv.rows.length,
		lock: delta.getCompactionLock(),
	});
	process.exit(0);
}

if (command === "build") {
	const generationId = options.get("generation") || `gen_compact_${Date.now()}`;
	const inv = inventory();
	const manifest = await generation.createGeneration(generationId, inv.hash, 384);
	const buildManifest = generation.setGenerationExpectedCount(generationId, inv.rows.length);
	let ok = 0;
	const failures = [];
	for (const row of inv.rows) {
		const fragment = fragments.getFragment(row.fragment_id);
		try {
			const built = await builder.buildDocumentInput({
				task_desc: fragment.task_desc,
				result_desc: fragment.result_desc,
				tags: fragment.tags,
				topic_name: fragment.topic_name,
				turns_text: fragment.turns_text,
			}, manifest);
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
	const snapshotPath = path.join(memoryRoot, ".compaction-build.json");
	fs.writeFileSync(snapshotPath, JSON.stringify({ generation_id: generationId, source_inventory_hash: inv.hash }, null, 2), "utf8");
	report({ command, generation_id: generationId, source_inventory_hash: inv.hash, expected: inv.rows.length, materialized: ok, failed: failures.length, state: ready.state, failures });
	process.exit(failures.length ? 1 : 0);
}

if (command === "validate") {
	const generationId = options.get("generation");
	if (!generationId) throw new Error("--generation is required");
	const snapshotPath = path.join(memoryRoot, ".compaction-build.json");
	const snapshot = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, "utf8")) : null;
	const checked = await validateGeneration(generationId, snapshot?.source_inventory_hash);
	report({ command, generation_id: generationId, source_inventory_hash: checked.result.hash, failures: checked.failures, valid: checked.failures.length === 0 });
	process.exit(checked.failures.length ? 1 : 0);
}

if (command === "switch") {
	const generationId = options.get("generation");
	if (!generationId) throw new Error("--generation is required");
	const snapshotPath = path.join(memoryRoot, ".compaction-build.json");
	if (!fs.existsSync(snapshotPath)) throw new Error("compaction build snapshot missing");
	const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
	const before = inventory();
	if (before.hash !== snapshot.source_inventory_hash) throw new Error("source changed before switch; stop compaction");
	const checked = await validateGeneration(generationId, snapshot.source_inventory_hash);
	if (checked.failures.length) throw new Error(`validation failed: ${checked.failures.join("; ")}`);
	const pointer = generation.activateGeneration(generationId);
	const archivePath = delta.archiveCurrentDelta(generationId);
	const newDelta = delta.resetDeltaForActiveGeneration();
	delta.removeCompactionLock();
	report({
		command,
		pointer,
		archived_delta_path: archivePath,
		new_delta_id: newDelta.delta_id,
		source_inventory_hash: before.hash,
	});
	process.exit(0);
}
