import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-c3-3b-"));
process.chdir(tempRoot);

const generation = await import("../src/embedding/generation.ts");
const delta = await import("../src/embedding/delta.ts");
const fragments = await import("../src/storage/fragments.ts");
const builder = await import("../src/embedding/builder.ts");

const fragmentId = "2026-08-08/frag_001";
let sourceHash = "";

function writeFragment(): void {
	const filePath = path.join(tempRoot, "memory", "fragments", "2026-08-08", "frag_001.md");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "# 任务：C3-3B\n\n**日期**：2026-08-08\n**轮次**：turn_0001 ~ turn_0001\n**标签**：`test`\n**主题**：restore\n\n## 摘要\n\nrestore\n\n## 结论\n\nrestore fixture\n\n## 原文\n\n[用户]：restore fixture\n", "utf8");
	const fragment = fragments.getFragment(fragmentId);
	if (!fragment) throw new Error("fixture fragment missing");
	sourceHash = builder.sourceContentHash({ task_desc: fragment.task_desc, result_desc: fragment.result_desc, tags: fragment.tags, topic_name: fragment.topic_name, turns_text: fragment.turns_text });
}

async function createReadyGeneration(generationId: string) {
	const manifest = await generation.createGeneration(generationId, "sha256:inventory", 2, "single");
	generation.setGenerationExpectedCount(generationId, 1);
	generation.writeGenerationVector(manifest, fragmentId, [0.25, 0.75], {
		source_content_hash: sourceHash,
		input_hash: `sha256:${generationId}-input`,
		tokens: {},
	});
	return generation.finalizeGeneration(generationId);
}

function snapshot(root: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!fs.existsSync(root)) return result;
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else result.set(path.relative(root, fullPath), fs.readFileSync(fullPath, "utf8"));
		}
	};
	visit(root);
	return result;
}

function realOps(): any {
	return {
		mkdirSync: (filePath: string, options?: any) => fs.mkdirSync(filePath, options),
		writeFileSync: (filePath: string, content: string, encoding?: any) => fs.writeFileSync(filePath, content, encoding),
		readFileSync: (filePath: string, encoding?: any) => fs.readFileSync(filePath, encoding),
		copyFileSync: (source: string, destination: string) => fs.copyFileSync(source, destination),
		cpSync: (source: string, destination: string, options: any) => fs.cpSync(source, destination, options),
		renameSync: (source: string, destination: string) => fs.renameSync(source, destination),
		unlinkSync: (filePath: string) => fs.unlinkSync(filePath),
		existsSync: (filePath: string) => fs.existsSync(filePath),
		rmSync: (filePath: string, options?: any) => fs.rmSync(filePath, options),
	};
}

async function compactFixture() {
	writeFragment();
	const base = await createReadyGeneration("gen_c33b_base");
	const basePointer = generation.activateGeneration(base.generation_id);
	const oldDelta = delta.resetDeltaForActiveGeneration();
	delta.upsertDeltaRecord(oldDelta, fragmentId, [0.75, 0.25], "sha256:delta-input", sourceHash, {}, "create");
	delta.createCompactionLock();
	delta.setDeltaManifestState("sealed");
	const contract = delta.planCompactionMergeContract();
	const target = await createReadyGeneration("gen_c33b_target");
	const targetPointer = generation.activateGeneration(target.generation_id);
	const archivePath = delta.archiveCurrentDelta(target.generation_id, contract)!;
	const freshDelta = delta.resetDeltaForActiveGeneration();
	delta.removeCompactionLock();
	return { archivePath, basePointer, targetPointer, oldDelta, freshDelta };
}

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("C3-3B archived delta recovery", () => {
	beforeEach(() => {
		fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	});

	test("verifies a v2 archive and restores exact base pointer plus sealed delta", async () => {
		const { archivePath, basePointer, targetPointer, oldDelta } = await compactFixture();
		const verified = delta.verifyArchivedDelta(archivePath);
		assert.equal(verified.valid, true);
		assert.equal(verified.receipt!.receipt_schema_version, 2);
		assert.deepEqual(verified.receipt!.pointer_snapshots.base, basePointer);
		assert.deepEqual(verified.receipt!.pointer_snapshots.target, targetPointer);

		const result = delta.restoreArchivedDelta(archivePath);
		assert.deepEqual(result, { restored: true, idempotent: false });
		assert.deepEqual(generation.readActivePointer(), basePointer);
		assert.equal(delta.readDeltaManifest()!.delta_id, oldDelta.delta_id);
		assert.equal(delta.readDeltaManifest()!.state, "sealed");
		assert.equal(delta.currentDeltaCompatibility().compatible, true);
		assert.ok(generation.readGenerationManifest("gen_c33b_target"));
		assert.equal(fs.existsSync(archivePath), true);
		const restoreTransactions = fs.existsSync(path.join(tempRoot, "memory", "embedding_delta", "transactions"))
			? fs.readdirSync(path.join(tempRoot, "memory", "embedding_delta", "transactions")).filter((name) => name.startsWith("restore-"))
			: [];
		assert.deepEqual(restoreTransactions, []);
		assert.deepEqual(delta.restoreArchivedDelta(archivePath), { restored: false, idempotent: true });
	});

	test("fails closed for a tampered archive without changing target state", async () => {
		const { archivePath } = await compactFixture();
		const before = snapshot(path.join(tempRoot, "memory"));
		const beforeFiles = new Set(before.keys());
		fs.appendFileSync(path.join(archivePath, "delta_index.json"), "\n", "utf8");
		const verified = delta.verifyArchivedDelta(archivePath);
		assert.equal(verified.valid, false);
		assert.throws(() => delta.restoreArchivedDelta(archivePath), /archive verification failed/);
		const afterFiles = snapshot(path.join(tempRoot, "memory"));
		assert.deepEqual([...afterFiles.keys()].filter((key) => beforeFiles.has(key)).sort(), [...beforeFiles].sort());
	});

	test("rejects restoration when a non-empty target delta would be overwritten", async () => {
		const { archivePath, freshDelta } = await compactFixture();
		delta.upsertDeltaRecord(freshDelta, fragmentId, [0.9, 0.1], "sha256:new-input", sourceHash, {}, "create");
		assert.throws(() => delta.restoreArchivedDelta(archivePath), /not an empty fresh delta/);
	});

	test("rolls back target pointer and delta after a replacement failure", async () => {
		const { archivePath } = await compactFixture();
		const before = snapshot(path.join(tempRoot, "memory"));
		const base = realOps();
		let injected = false;
		const ops = {
			...base,
			copyFileSync: (source: string, destination: string) => {
				if (!injected && path.normalize(destination) === path.normalize(delta.deltaIndexPath())) {
					injected = true;
					throw new Error("injected delta replacement failure");
				}
				return base.copyFileSync(source, destination);
			},
		};
		assert.throws(() => delta.restoreArchivedDelta(archivePath, ops), /injected delta replacement failure/);
		assert.deepEqual([...snapshot(path.join(tempRoot, "memory"))].sort(), [...before].sort());
		const restoreTransactions = fs.existsSync(path.join(tempRoot, "memory", "embedding_delta", "transactions"))
			? fs.readdirSync(path.join(tempRoot, "memory", "embedding_delta", "transactions")).filter((name) => name.startsWith("restore-"))
			: [];
		assert.deepEqual(restoreTransactions, []);
	});

	test("preserves a rollback-failed transaction and permits explicit recovery", async () => {
		const { archivePath } = await compactFixture();
		const before = snapshot(path.join(tempRoot, "memory"));
		const base = realOps();
		let failCommit = true;
		let failRollback = true;
		const ops = {
			...base,
			copyFileSync: (source: string, destination: string) => {
				if (path.normalize(destination) === path.normalize(delta.deltaIndexPath())) {
					if (failCommit) {
						failCommit = false;
						throw new Error("injected commit failure");
					}
					if (failRollback) {
						failRollback = false;
						throw new Error("injected rollback failure");
					}
				}
				return base.copyFileSync(source, destination);
			},
		};
		const failed = delta.restoreArchivedDelta(archivePath, ops);
		assert.equal(failed.recovery_failed, true);
		assert.ok(failed.transaction_path);
		assert.equal(fs.existsSync(failed.transaction_path!), true);
		const recovered = delta.recoverDeltaRestoreTransaction();
		assert.deepEqual(recovered, { recovered: true, cleaned_committed: false });
		assert.deepEqual([...snapshot(path.join(tempRoot, "memory"))].sort(), [...before].sort());
	});
});
