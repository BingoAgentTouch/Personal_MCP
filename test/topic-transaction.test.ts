import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-topic-transaction-"));
process.chdir(tempRoot);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topics = await import(pathToFileURL(path.join(projectRoot, "src/storage/topics.ts")).href);

const topicsDir = path.join(tempRoot, "memory/topics");
const fragmentsDir = path.join(tempRoot, "memory/fragments");

beforeEach(() => {
	fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	fs.mkdirSync(topicsDir, { recursive: true });
	fs.mkdirSync(fragmentsDir, { recursive: true });
});

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function topic(name: string, fragmentId: string): void {
	const [date] = fragmentId.split("/");
	topics.upsertTopic(name, date, fragmentId, `${name} 摘要`);
}
function fragment(id: string, topicName: string): string {
	const [date, name] = id.split("/");
	const dir = path.join(fragmentsDir, date);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.md`);
	fs.writeFileSync(file, `# 任务\n\n**主题**：${topicName}\n\n正文\n`, "utf-8");
	return file;
}
function plan(target: string, source: string) {
	return topics.planTopicConsolidationBatch([{ target, sources: [source] }], fragmentsDir);
}
function realOps(): any {
	return {
		mkdirSync: (p: string, o?: any) => fs.mkdirSync(p, o),
		writeFileSync: (p: string, d: any, e?: any) => fs.writeFileSync(p, d, e),
		readFileSync: (p: string, e: any) => fs.readFileSync(p, e),
		copyFileSync: (a: string, b: string) => fs.copyFileSync(a, b),
		renameSync: (a: string, b: string) => fs.renameSync(a, b),
		unlinkSync: (p: string) => fs.unlinkSync(p),
		existsSync: (p: string) => fs.existsSync(p),
		rmSync: (p: string, o?: any) => fs.rmSync(p, o),
	};
}
function targetedFailureOps(method: "copy" | "write" | "rename" | "unlink", predicate: (...args: any[]) => boolean): any {
	const base = realOps();
	let injected = false;
	const wrap = (name: string, fn: (...args: any[]) => any) => (...args: any[]) => {
		if (!injected && method === name && predicate(...args)) {
			injected = true;
			throw new Error(`injected ${name}`);
		}
		return fn(...args);
	};
	return {
		...base,
		copyFileSync: wrap("copy", base.copyFileSync),
		writeFileSync: wrap("write", base.writeFileSync),
		renameSync: wrap("rename", base.renameSync),
		unlinkSync: wrap("unlink", base.unlinkSync),
	};
}
function snapshot(root: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!fs.existsSync(root)) return result;
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else result.set(path.relative(root, full), fs.readFileSync(full, "utf-8"));
		}
	};
	visit(root);
	return result;
}
function makePlan() {
	topic("目标", "2026-08-01/frag_001");
	topic("来源", "2026-08-02/frag_002");
	fragment("2026-08-02/frag_002", "来源");
	const value = plan("目标", "来源");
	assert.equal(value.validated, true);
	return value;
}
function makeMultiPlan() {
	topic("目标一", "2026-08-01/frag_001");
	topic("来源一", "2026-08-02/frag_002");
	fragment("2026-08-02/frag_002", "来源一");
	topic("目标二", "2026-08-03/frag_003");
	topic("来源二", "2026-08-04/frag_004");
	fragment("2026-08-04/frag_004", "来源二");
	const value = topics.planTopicConsolidationBatch([
		{ target: "目标一", sources: ["来源一"] },
		{ target: "目标二", sources: ["来源二"] },
	], fragmentsDir);
	assert.equal(value.validated, true);
	return value;
}
function assertRolledBack(before: Map<string, string>, result: { error?: string; recovery_failed?: boolean }): void {
	assert.ok(result.error);
	assert.equal(result.recovery_failed, undefined);
	assert.deepEqual([...snapshot(path.join(tempRoot, "memory"))].sort(), [...before].sort());
	assert.equal(fs.existsSync(path.join(topicsDir, ".transactions")), false);
}

const inBackup = (_source: string, destination: string) => destination.includes(`${path.sep}backup${path.sep}`);
const stagedKind = (kind: string) => (filePath: string) => filePath.includes(`${path.sep}staged${path.sep}`) && filePath.endsWith(`-${kind}.tmp`);
const inTrash = (_source: string, destination: string) => destination.includes(`${path.sep}.trash${path.sep}`);

describe("Topic transaction Stage 5", () => {
	test("T5-01/T5-13/T5-15: normal multi-group commit has exact stats, state, and trash bytes", () => {
		const txPlan = makeMultiPlan();
		const sourcePaths = [topics.resolveTopicPath("来源一"), topics.resolveTopicPath("来源二")];
		const sourceBytes = new Map(sourcePaths.map((sourcePath) => [path.basename(sourcePath, ".md"), fs.readFileSync(sourcePath, "utf-8")]));
		const result = topics.applyTopicConsolidationBatchTransactional(txPlan);
		assert.deepEqual(result, {});
		assert.deepEqual(txPlan.groups.map((group: any) => [group.new_entries_count, group.fragments_updated]), [[1, 1], [1, 1]]);
		assert.ok(sourcePaths.every((sourcePath) => !fs.existsSync(sourcePath)));
		assert.match(fs.readFileSync(path.join(fragmentsDir, "2026-08-02/frag_002.md"), "utf-8"), /\*\*主题\*\*：目标一/);
		assert.match(fs.readFileSync(path.join(fragmentsDir, "2026-08-04/frag_004.md"), "utf-8"), /\*\*主题\*\*：目标二/);
		const trash = fs.readdirSync(path.join(topicsDir, ".trash"));
		assert.equal(trash.length, 2);
		for (const [source, bytes] of sourceBytes) {
			const backup = trash.find((file) => file.startsWith(`${source}-`));
			assert.ok(backup);
			assert.equal(fs.readFileSync(path.join(topicsDir, ".trash", backup), "utf-8"), bytes);
		}
		assert.equal(fs.existsSync(path.join(topicsDir, ".transactions")), false);
	});

	test("T5-02: backup creation failure leaves live files unchanged", () => {
		const txPlan = makePlan();
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("copy", inBackup)));
	});

	test("T5-03: target staged write failure leaves live files unchanged", () => {
		const txPlan = makePlan();
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("write", stagedKind("topic"))));
	});

	test("T5-04: fragment staged write failure rolls back prior target replacement", () => {
		const txPlan = makePlan();
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("write", stagedKind("fragment"))));
	});

	test("T5-05: first target replacement failure restores the full snapshot", () => {
		const txPlan = makePlan();
		const targetPath = topics.resolveTopicPath("目标");
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("rename", (_source, destination) => destination === targetPath)));
	});

	test("T5-06: failure after one target replacement rolls back both target groups", () => {
		const txPlan = makeMultiPlan();
		const secondTarget = topics.resolveTopicPath("目标二");
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("rename", (_source, destination) => destination === secondTarget)));
	});

	test("T5-07: failure after a fragment replacement rolls back targets and fragments", () => {
		const txPlan = makeMultiPlan();
		const secondFragment = path.join(fragmentsDir, "2026-08-04/frag_004.md");
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("rename", (_source, destination) => destination === secondFragment)));
	});

	test("T5-08: source trash backup failure rolls back target and fragment changes", () => {
		const txPlan = makePlan();
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("copy", inTrash)));
	});

	test("T5-09: source deletion failure restores the complete batch", () => {
		const txPlan = makePlan();
		const sourcePath = topics.resolveTopicPath("来源");
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("unlink", (filePath) => filePath === sourcePath)));
	});

	test("T5-10: second-group commit failure also rolls back the first group", () => {
		const txPlan = makeMultiPlan();
		const secondSource = topics.resolveTopicPath("来源二");
		const before = snapshot(path.join(tempRoot, "memory"));
		assertRolledBack(before, topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("copy", (source, destination) => source === secondSource && inTrash(source, destination))));
	});

	test("T5-11: a successful retry after rollback has no transaction residue", () => {
		const txPlan = makePlan();
		const targetPath = topics.resolveTopicPath("目标");
		topics.applyTopicConsolidationBatchTransactional(txPlan, targetedFailureOps("rename", (_source, destination) => destination === targetPath));
		const retryPlan = plan("目标", "来源");
		assert.equal(retryPlan.validated, true);
		const retry = topics.applyTopicConsolidationBatchTransactional(retryPlan);
		assert.deepEqual(retry, {});
		assert.equal(fs.existsSync(path.join(topicsDir, ".transactions")), false);
	});

	test("T5-12: rollback failure preserves transaction path and raises recovery_failed", () => {
		const txPlan = makePlan();
		const base = realOps();
		let rollback = false;
		const ops = {
			...base,
			renameSync: (source: string, destination: string) => {
				if (source.includes(".transaction-")) throw new Error("injected commit rename");
				if (source.includes(".rollback-")) {
					rollback = true;
					throw new Error("injected rollback rename");
				}
				return base.renameSync(source, destination);
			},
		};
		const result = topics.applyTopicConsolidationBatchTransactional(txPlan, ops);
		assert.equal(rollback, true);
		assert.equal(result.recovery_failed, true);
		assert.ok(result.transaction_path);
		assert.equal(fs.existsSync(result.transaction_path!), true);
		fs.rmSync(result.transaction_path!, { recursive: true, force: true });
	});
});
