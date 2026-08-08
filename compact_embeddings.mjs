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
const compactionContractPath = path.join(memoryRoot, ".compaction-contract.json");
const compactionBuildPath = path.join(memoryRoot, ".compaction-build.json");
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
function parseRepresentationKind(value, fallback = "single") {
	const normalized = value ?? fallback;
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
function readJsonFile(filePath) {
	if (!fs.existsSync(filePath)) return null;
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function contractBodyHash(contract) {
	const { contract_content_hash: _ignored, ...body } = contract;
	return hash(canonicalJson(body));
}
function loadSealedContract() {
	const contract = readJsonFile(compactionContractPath);
	if (!contract) throw new Error("compaction merge contract missing");
	if (contract.contract_content_hash !== contractBodyHash(contract)) throw new Error("compaction merge contract hash mismatch");
	if (contract.delta?.state !== "sealed") throw new Error(`compaction merge contract is not sealed: ${contract.delta?.state ?? "missing"}`);
	return contract;
}
function loadBuildSnapshot() {
	const snapshot = readJsonFile(compactionBuildPath);
	if (!snapshot) throw new Error("compaction build snapshot missing");
	return snapshot;
}
function writeJsonFile(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function loadPlannedContract(expectedHash = null) {
	const contract = delta.planCompactionMergeContract();
	if (expectedHash && contract.contract_content_hash !== expectedHash) {
		throw new Error(`compaction merge contract drifted: ${contract.contract_content_hash} != ${expectedHash}`);
	}
	return contract;
}
function assertSnapshotContractBinding(snapshot, contract) {
	if (snapshot.merge_contract_hash && snapshot.merge_contract_hash !== contract.contract_content_hash) {
		throw new Error(`sealed compaction contract drifted: ${snapshot.merge_contract_hash} != ${contract.contract_content_hash}`);
	}
	if (snapshot.merge_contract) {
		if (snapshot.merge_contract.contract_content_hash !== contract.contract_content_hash) {
			throw new Error(`build snapshot contract drifted: ${snapshot.merge_contract.contract_content_hash} != ${contract.contract_content_hash}`);
		}
		if (contractBodyHash(snapshot.merge_contract) !== contract.contract_content_hash) {
			throw new Error("build snapshot contract hash mismatch");
		}
	}
	const binding = snapshot.merge_contract_binding ?? {};
	if (binding.base_generation_id && binding.base_generation_id !== contract.base.generation_id) {
		throw new Error(`compaction contract base generation drifted: ${binding.base_generation_id} != ${contract.base.generation_id}`);
	}
	if (binding.base_manifest_hash && binding.base_manifest_hash !== contract.base.manifest_content_hash) {
		throw new Error(`compaction contract base manifest drifted: ${binding.base_manifest_hash} != ${contract.base.manifest_content_hash}`);
	}
	if (binding.delta_id && binding.delta_id !== contract.delta.delta_id) {
		throw new Error(`compaction contract delta id drifted: ${binding.delta_id} != ${contract.delta.delta_id}`);
	}
	if (binding.delta_manifest_hash && binding.delta_manifest_hash !== contract.delta.manifest_content_hash) {
		throw new Error(`compaction contract delta manifest drifted: ${binding.delta_manifest_hash} != ${contract.delta.manifest_content_hash}`);
	}
	if (binding.active_generation_id && binding.active_generation_id !== contract.active_pointer.active_generation_id) {
		throw new Error(`compaction contract active generation drifted: ${binding.active_generation_id} != ${contract.active_pointer.active_generation_id}`);
	}
	if (binding.active_manifest_hash && binding.active_manifest_hash !== contract.active_pointer.active_manifest_hash) {
		throw new Error(`compaction contract active manifest drifted: ${binding.active_manifest_hash} != ${contract.active_pointer.active_manifest_hash}`);
	}
	if (binding.effective_entry_hash && binding.effective_entry_hash !== contract.effective_entry_hash) {
		throw new Error(`compaction contract effective entry drifted: ${binding.effective_entry_hash} != ${contract.effective_entry_hash}`);
	}
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

const [fragments, builder, provider, generation, delta] = await loadModules();

if (!command || !["preflight", "build", "validate", "switch", "unlock"].includes(command)) {
	console.error("Usage: node compact_embeddings.mjs preflight|build|validate|switch|unlock [--generation ID] [--representation single|multiview] [--memory-root PATH]");
	process.exit(2);
}

function inventory() {
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

async function validateGeneration(generationId, expectedInventoryHash, expectedTargetGenerationId = null) {
	const manifest = generation.readGenerationManifest(generationId);
	if (!manifest) throw new Error(`generation not found: ${generationId}`);
	const result = inventory();
	const index = generation.readGenerationIndex(generationId);
	const shared = generation.validateGenerationRecords(manifest, index, result.rows, result.hash);
	const failures = [...shared.failures];
	if (expectedInventoryHash && manifest.source_inventory_hash !== expectedInventoryHash) failures.push("source inventory hash mismatch vs build snapshot");
	if (expectedTargetGenerationId && generationId !== expectedTargetGenerationId) {
		failures.push(`generation id mismatch vs build snapshot: ${generationId} != ${expectedTargetGenerationId}`);
	}
	const validation = { ...shared, failures, valid: failures.length === 0 };
	return {
		manifest,
		result,
		validation,
		representationKind: validation.representation_kind,
		viewCounts: validation.view_counts ?? null,
		failures,
		valid: validation.valid,
	};
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
	const sealed = delta.setDeltaManifestState("sealed");
	const contract = loadPlannedContract();
	writeJsonFile(compactionContractPath, contract);
	report({
		command,
		active_generation_id: active.generation_id,
		delta_id: ensured.delta_id,
		sealed_state: sealed.state,
		source_inventory_hash: contract.source_inventory_hash,
		fragment_count: contract.fragment_counts.live,
		merge_contract: contract,
		lock: delta.getCompactionLock(),
	});
	process.exit(0);
}

if (command === "build") {
	const generationId = options.get("generation") || `gen_compact_${Date.now()}`;
	const contract = loadSealedContract();
	const planned = loadPlannedContract(contract.contract_content_hash);
	const active = generation.getActiveGeneration();
	const representationKind = parseRepresentationKind(options.get("representation"), active ? (generation.isMultiviewGeneration(active) ? "multiview" : "single") : "single");
	if (representationKind !== contract.representation.kind) {
		throw new Error(`requested representation does not match compaction contract: ${representationKind} != ${contract.representation.kind}`);
	}
	if (generationId === contract.base.generation_id) throw new Error("target generation id must differ from active base generation");
	const inv = inventory();
	if (inv.hash !== contract.source_inventory_hash) throw new Error("source changed before build; stop compaction");
	await generation.createGeneration(generationId, inv.hash, 384, representationKind);
	const buildManifest = generation.setGenerationExpectedCount(generationId, inv.rows.length);
	let ok = 0;
	const failures = [];
	const viewCounts = representationKind === "multiview" ? createViewCounts() : null;
	for (const row of inv.rows) {
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
	const snapshot = {
		generation_id: generationId,
		source_inventory_hash: inv.hash,
		merge_contract: contract,
		merge_contract_hash: contract.contract_content_hash,
		merge_contract_binding: {
			base_generation_id: contract.base.generation_id,
			base_manifest_hash: contract.base.manifest_content_hash,
			delta_id: contract.delta.delta_id,
			delta_manifest_hash: contract.delta.manifest_content_hash,
			active_generation_id: contract.active_pointer.active_generation_id,
			active_manifest_hash: contract.active_pointer.active_manifest_hash,
			effective_entry_hash: contract.effective_entry_hash,
		},
	};
	writeJsonFile(compactionBuildPath, snapshot);
	report({
		command,
		generation_id: generationId,
		representation_kind: ready.representation_kind ?? representationKind,
		source_inventory_hash: inv.hash,
		merge_contract_hash: contract.contract_content_hash,
		merge_contract: planned,
		expected: inv.rows.length,
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
	const snapshot = loadBuildSnapshot();
	const contract = loadSealedContract();
	const planned = loadPlannedContract(snapshot.merge_contract_hash ?? contract.contract_content_hash);
	assertSnapshotContractBinding(snapshot, planned);
	if (snapshot.source_inventory_hash !== planned.source_inventory_hash) {
		throw new Error(`source inventory drifted vs contract: ${snapshot.source_inventory_hash} != ${planned.source_inventory_hash}`);
	}
	const checked = await validateGeneration(generationId, snapshot.source_inventory_hash, snapshot.generation_id);
	report({
		command,
		generation_id: generationId,
		representation_kind: checked.representationKind,
		source_inventory_hash: checked.result.hash,
		build_snapshot_generation_id: snapshot.generation_id,
		merge_contract_hash: planned.contract_content_hash,
		expected: checked.result.rows.length,
		materialized: checked.manifest.materialized_count,
		coverage: checked.manifest.searchable_coverage,
		...(checked.viewCounts ? { view_counts: checked.viewCounts } : {}),
		failures: checked.failures,
		valid: checked.failures.length === 0,
	});
	process.exit(checked.failures.length ? 1 : 0);
}

if (command === "switch") {
	const generationId = options.get("generation");
	if (!generationId) throw new Error("--generation is required");
	const snapshot = loadBuildSnapshot();
	const contract = loadSealedContract();
	const planned = loadPlannedContract(snapshot.merge_contract_hash ?? contract.contract_content_hash);
	assertSnapshotContractBinding(snapshot, planned);
	const before = inventory();
	if (before.hash !== snapshot.source_inventory_hash) throw new Error("source changed before switch; stop compaction");
	if (before.hash !== planned.source_inventory_hash) throw new Error("source changed vs compaction contract; stop compaction");
	const checked = await validateGeneration(generationId, snapshot.source_inventory_hash, snapshot.generation_id);
	generation.assertGenerationReadyForActivation(checked.manifest, checked.validation);
	const pointer = generation.activateGeneration(generationId);
	const activatedManifest = generation.readGenerationManifest(generationId);
	if (!activatedManifest) throw new Error("activated generation manifest missing after switch");
	if (pointer.active_generation_id !== snapshot.generation_id || pointer.active_manifest_hash !== activatedManifest.manifest_content_hash) {
		throw new Error("activated pointer does not match validated generation snapshot");
	}
	const archivePath = delta.archiveCurrentDelta(generationId, planned);
	const newDelta = delta.resetDeltaForActiveGeneration();
	delta.removeCompactionLock();
	report({
		command,
		pointer,
		archived_delta_path: archivePath,
		new_delta_id: newDelta.delta_id,
		source_inventory_hash: before.hash,
		merge_contract_hash: planned.contract_content_hash,
	});
	process.exit(0);
}
