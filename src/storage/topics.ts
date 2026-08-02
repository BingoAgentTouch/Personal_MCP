import * as fs from "node:fs";
import * as path from "node:path";
import type { MergeErrorItem, MergePlan, TopicConsolidateChanges, TopicEntry, TopicIndexMeta } from "../types.js";

const BASE = path.resolve("memory/topics");

function topicPath(name: string): string {
	const safe = name.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9一-鿿\-_]/g, "");
	return path.join(BASE, `${safe}.md`);
}
function buildTopicMD(meta: TopicIndexMeta): string {
	const lines: string[] = [];
	lines.push(`# 主题：${meta.name}（${meta.date_range.start} ~ ${meta.date_range.end}）`, "");
	lines.push(`**涵盖日期**：${meta.entries.map((e) => e.date).join(", ")}`);
	lines.push(`**状态**：${meta.status === "active" ? "进行中" : "已完成"}`, "", "## 各阶段", "");
	for (const entry of meta.entries) lines.push(`- ${entry.date}：${entry.summary}（→ daily/${entry.date}.md → ${entry.fragment_id}）`);
	lines.push("");
	if (meta.constraints.length > 0) {
		lines.push("## 关键约束", "");
		for (const constraint of meta.constraints) lines.push(`- ${constraint}`);
		lines.push("");
	}
	return lines.join("\n");
}
function parseTopicMD(md: string, name: string): TopicIndexMeta | null {
	const titleMatch = md.match(/^# 主题：(.+?)（(.+?) ~ (.+?)）/m);
	if (!titleMatch) return null;
	const statusMatch = md.match(/\*\*状态\*\*[：:]\s*(.+)/);
	const entries: TopicEntry[] = [];
	const entryRe = /^- (\d{4}-\d{2}-\d{2})[：:]\s*(.+?)（[^）\n]*→\s*([^）]*)）/gm;
	let match: RegExpExecArray | null;
	while ((match = entryRe.exec(md)) !== null) entries.push({ date: match[1], fragment_id: match[3].trim(), summary: match[2].trim() });
	const constraints: string[] = [];
	const constraintsSection = md.indexOf("## 关键约束");
	if (constraintsSection !== -1) {
		for (const line of md.slice(constraintsSection).split("\n").slice(2)) {
			const trimmed = line.trim();
			if (trimmed.startsWith("- ")) constraints.push(trimmed.slice(2));
			else if (trimmed === "") break;
		}
	}
	return {
		name: titleMatch[1].trim(),
		date_range: { start: titleMatch[2].trim(), end: titleMatch[3].trim() },
		status: statusMatch && statusMatch[1].includes("完成") ? "completed" : "active",
		entries,
		constraints,
	};
}
export function upsertTopic(topicName: string, date: string, fragmentId: string, summaryMd: string): TopicIndexMeta {
	fs.mkdirSync(BASE, { recursive: true });
	const fp = topicPath(topicName);
	let meta: TopicIndexMeta;
	if (fs.existsSync(fp)) {
		const existing = parseTopicMD(fs.readFileSync(fp, "utf-8"), topicName);
		if (existing) {
			if (!existing.entries.some((entry) => entry.date === date)) existing.entries.push({ date, fragment_id: fragmentId, summary: summaryMd });
			existing.entries.sort((a, b) => a.date.localeCompare(b.date));
			const dates = existing.entries.map((entry) => entry.date);
			existing.date_range = { start: dates[0], end: dates[dates.length - 1] };
			meta = existing;
		} else meta = { name: topicName, date_range: { start: date, end: date }, status: "active", entries: [{ date, fragment_id: fragmentId, summary: summaryMd }], constraints: [] };
	} else meta = { name: topicName, date_range: { start: date, end: date }, status: "active", entries: [{ date, fragment_id: fragmentId, summary: summaryMd }], constraints: [] };
	fs.writeFileSync(fp, buildTopicMD(meta), "utf-8");
	return meta;
}
export function getTopic(name: string): TopicIndexMeta | null {
	const fp = topicPath(name);
	if (!fs.existsSync(fp)) return null;
	return parseTopicMD(fs.readFileSync(fp, "utf-8"), name);
}
export function getTopicRaw(name: string): string | null {
	const fp = topicPath(name);
	if (!fs.existsSync(fp)) return null;
	return fs.readFileSync(fp, "utf-8");
}
export function listTopics(): string[] {
	if (!fs.existsSync(BASE)) return [];
	return fs.readdirSync(BASE).filter((file) => file.endsWith(".md")).map((file) => file.replace(".md", ""));
}
export function resolveTopicPath(name: string): string { return topicPath(name); }

// ============================================================
// memory_consolidate_topics 辅助函数
// ============================================================
export function tokenizeTopicText(text: string): Set<string> {
	const tokens = new Set<string>();
	const segments = text.match(/[一-鿿]+|[A-Za-z0-9]+/g) ?? [];
	for (const segment of segments) {
		if (/^[一-鿿]+$/.test(segment)) {
			if (segment.length === 1) tokens.add(`zh:${segment}`);
			else for (let i = 0; i < segment.length - 1; i++) tokens.add(`zh:${segment.slice(i, i + 2)}`);
		} else tokens.add(`word:${segment.toLowerCase()}`);
	}
	return tokens;
}
export function jaccardSimilarity(textA: string, textB: string): number {
	const setA = tokenizeTopicText(textA); const setB = tokenizeTopicText(textB);
	if (setA.size === 0 && setB.size === 0) return 0;
	const intersectionSize = [...setA].filter((token) => setB.has(token)).length;
	const unionSize = new Set([...setA, ...setB]).size;
	return unionSize === 0 ? 0 : intersectionSize / unionSize;
}
export function topicToText(name: string, entries: TopicEntry[]): string { return [name, ...entries.map((entry) => entry.summary)].join(" "); }
export interface TopicSimilarityScore { name_score: number; summary_score: number; similarity: number; }
export function topicSimilarity(topicA: Pick<TopicIndexMeta, "name" | "entries">, topicB: Pick<TopicIndexMeta, "name" | "entries">): TopicSimilarityScore {
	const nameScore = jaccardSimilarity(topicA.name, topicB.name);
	const summaryScore = jaccardSimilarity(topicA.entries.map((entry) => entry.summary).join(" "), topicB.entries.map((entry) => entry.summary).join(" "));
	return { name_score: nameScore, summary_score: summaryScore, similarity: 0.7 * nameScore + 0.3 * summaryScore };
}
export const DEFAULT_TOPIC_THRESHOLD = 0.3;

export interface PlannedFragmentUpdate { fragment_id: string; fragment_path: string; content_before: string; content_after: string; }
export interface PlannedMergeGroup { group_index: number; target: string; sources: string[]; new_entries_count: number; fragments_updated: number; merged_meta: TopicIndexMeta; fragment_updates: PlannedFragmentUpdate[]; }
export interface TopicConsolidationBatchPlan { groups: PlannedMergeGroup[]; errors: MergeErrorItem[]; validated: boolean; changes: TopicConsolidateChanges; }
const EMPTY_CHANGES = (): TopicConsolidateChanges => ({ topics_to_update: [], topics_to_remove: [], fragments_to_update: [], backups_to_create: 0 });
function addError(errors: MergeErrorItem[], groupIndex: number, message: string): void { if (!errors.some((item) => item.group_index === groupIndex && item.error === message)) errors.push({ group_index: groupIndex, error: message }); }
function isCanonicalFragmentId(fragmentId: string): boolean { return /^\d{4}-\d{2}-\d{2}\/frag_\d{3}$/.test(fragmentId); }
function resolveFragmentPathSafe(fragBase: string, fragmentId: string): string | null {
	if (!isCanonicalFragmentId(fragmentId)) return null;
	const base = path.resolve(fragBase); const [date, fragmentName] = fragmentId.split("/"); const resolved = path.resolve(base, date, `${fragmentName}.md`); const relative = path.relative(base, resolved);
	return relative.startsWith("..") || path.isAbsolute(relative) ? null : resolved;
}
function readTopicForPlan(name: string): TopicIndexMeta | null {
	const fp = topicPath(name); if (!fs.existsSync(fp)) return null;
	try { return parseTopicMD(fs.readFileSync(fp, "utf-8"), name); } catch { return null; }
}
function planSingleMerge(groupIndex: number, merge: MergePlan, fragBase: string, errors: MergeErrorItem[]): PlannedMergeGroup | null {
	const { target, sources } = merge;
	if (sources.length === 0) { addError(errors, groupIndex, "sources 不能为空"); return null; }
	if (new Set(sources).size !== sources.length) { addError(errors, groupIndex, "sources 不能包含重复主题"); return null; }
	if (sources.includes(target)) { addError(errors, groupIndex, `source 与 target 同名：${target}`); return null; }
	const targetMeta = readTopicForPlan(target);
	if (!targetMeta) { addError(errors, groupIndex, `target 主题不存在或无法解析：${target}`); return null; }
	const sourceMetas: Array<{ name: string; meta: TopicIndexMeta }> = [];
	for (const source of sources) { const sourceMeta = readTopicForPlan(source); if (!sourceMeta) addError(errors, groupIndex, `source 主题不存在或无法解析：${source}`); else sourceMetas.push({ name: source, meta: sourceMeta }); }
	if (sourceMetas.length !== sources.length) return null;
	const allEntries: TopicEntry[] = [...targetMeta.entries]; const seenEntries = new Set(targetMeta.entries.map((entry) => `${entry.date}|${entry.fragment_id}`)); let newEntriesCount = 0; const fragmentUpdates = new Map<string, PlannedFragmentUpdate>();
	for (const { name: source, meta } of sourceMetas) for (const entry of meta.entries) {
		const entryKey = `${entry.date}|${entry.fragment_id}`;
		if (!seenEntries.has(entryKey)) { seenEntries.add(entryKey); allEntries.push(entry); newEntriesCount++; }
		const fragmentPath = resolveFragmentPathSafe(fragBase, entry.fragment_id);
		if (!fragmentPath) { addError(errors, groupIndex, `fragment ID 非法或路径不安全：${entry.fragment_id}`); continue; }
		if (!fs.existsSync(fragmentPath)) { addError(errors, groupIndex, `fragment 不存在：${entry.fragment_id}`); continue; }
		let contentBefore: string;
		try { contentBefore = fs.readFileSync(fragmentPath, "utf-8"); } catch { addError(errors, groupIndex, `fragment 无法读取：${entry.fragment_id}`); continue; }
		const backlinkRe = new RegExp(`^\\*\\*主题\\*\\*[：:]\\s*${escapeRegex(source)}\\s*$`, "gm"); const matches = contentBefore.match(backlinkRe) ?? [];
		if (matches.length !== 1) { addError(errors, groupIndex, `fragment 回指不唯一或缺失：${entry.fragment_id}`); continue; }
		const contentAfter = contentBefore.replace(backlinkRe, `**主题**：${target}`); const existing = fragmentUpdates.get(fragmentPath);
		if (existing) { if (existing.content_after !== contentAfter) addError(errors, groupIndex, `fragment 被多个 source 以不同主题引用：${entry.fragment_id}`); continue; }
		fragmentUpdates.set(fragmentPath, { fragment_id: entry.fragment_id, fragment_path: fragmentPath, content_before: contentBefore, content_after: contentAfter });
	}
	allEntries.sort((a, b) => a.date.localeCompare(b.date)); const allDates = allEntries.map((entry) => entry.date);
	return { group_index: groupIndex, target, sources: [...sources], new_entries_count: newEntriesCount, fragments_updated: fragmentUpdates.size, merged_meta: { ...targetMeta, entries: allEntries, date_range: allDates.length > 0 ? { start: allDates[0], end: allDates[allDates.length - 1] } : targetMeta.date_range }, fragment_updates: [...fragmentUpdates.values()].sort((a, b) => a.fragment_id.localeCompare(b.fragment_id)) };
}
export function planTopicConsolidationBatch(merges: MergePlan[], fragBase: string): TopicConsolidationBatchPlan {
	const errors: MergeErrorItem[] = []; const active = merges.map((merge, groupIndex) => ({ merge, groupIndex })).filter(({ merge }) => !merge.skip); const targetGroups = new Map<string, number[]>(); const sourceGroups = new Map<string, number[]>();
	for (const { merge, groupIndex } of active) { targetGroups.set(merge.target, [...(targetGroups.get(merge.target) ?? []), groupIndex]); for (const source of merge.sources) sourceGroups.set(source, [...(sourceGroups.get(source) ?? []), groupIndex]); }
	for (const [target, groups] of targetGroups) { if (groups.length > 1) for (const groupIndex of groups) addError(errors, groupIndex, `target 在多个合并组中重复：${target}`); const sourceConflictGroups = sourceGroups.get(target) ?? []; for (const groupIndex of [...groups, ...sourceConflictGroups]) if (sourceConflictGroups.some((sourceGroup) => sourceGroup !== groupIndex)) addError(errors, groupIndex, `一个合并组的 target 同时是另一个合并组的 source：${target}`); }
	for (const [source, groups] of sourceGroups) if (groups.length > 1) for (const groupIndex of groups) addError(errors, groupIndex, `source 在多个合并组中重复：${source}`);
	const activePaths = new Map<string, number[]>(); for (const { merge, groupIndex } of active) for (const name of [merge.target, ...merge.sources]) { const resolved = path.resolve(topicPath(name)); activePaths.set(resolved, [...(activePaths.get(resolved) ?? []), groupIndex]); }
	for (const [filePath, groups] of activePaths) if (groups.length > 1) { const targetUsers = active.filter(({ merge }) => path.resolve(topicPath(merge.target)) === filePath); const sourceUsers = active.filter(({ merge }) => merge.sources.some((source) => path.resolve(topicPath(source)) === filePath)); if (targetUsers.length > 0 && sourceUsers.length > 0) for (const groupIndex of [...targetUsers, ...sourceUsers].map((item) => item.groupIndex)) addError(errors, groupIndex, `合并输出路径冲突：${filePath}`); }
	const plannedGroups: PlannedMergeGroup[] = []; for (const { merge, groupIndex } of active) { const planned = planSingleMerge(groupIndex, merge, fragBase, errors); if (planned) plannedGroups.push(planned); }
	if (errors.length > 0 || plannedGroups.length !== active.length) return { groups: [], errors, validated: false, changes: EMPTY_CHANGES() };
	const changes: TopicConsolidateChanges = { topics_to_update: [...new Set(plannedGroups.map((group) => group.target))].sort(), topics_to_remove: [...new Set(plannedGroups.flatMap((group) => group.sources))].sort(), fragments_to_update: [...new Set(plannedGroups.flatMap((group) => group.fragment_updates.map((update) => update.fragment_id)))].sort(), backups_to_create: [...new Set(plannedGroups.flatMap((group) => group.sources))].length };
	return { groups: plannedGroups, errors, validated: true, changes };
}

export interface TopicFileOps {
	mkdirSync(path: string, options?: { recursive?: boolean }): void;
	writeFileSync(path: string, data: string | Buffer, encoding?: BufferEncoding): void;
	readFileSync(path: string, encoding: BufferEncoding): string | Buffer;
	copyFileSync(source: string, destination: string): void;
	renameSync(source: string, destination: string): void;
	unlinkSync(path: string): void;
	existsSync(path: string): boolean;
	rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

const REAL_TOPIC_FILE_OPS: TopicFileOps = {
	mkdirSync: (filePath, options) => fs.mkdirSync(filePath, options),
	writeFileSync: (filePath, data, encoding) => fs.writeFileSync(filePath, data, encoding),
	readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
	copyFileSync: (source, destination) => fs.copyFileSync(source, destination),
	renameSync: (source, destination) => fs.renameSync(source, destination),
	unlinkSync: (filePath) => fs.unlinkSync(filePath),
	existsSync: (filePath) => fs.existsSync(filePath),
	rmSync: (filePath, options) => fs.rmSync(filePath, options),
};

export interface TopicConsolidationTransaction {
	operation_id: string;
	transaction_path: string;
	backup_path: string;
	staged_path: string;
	manifest_path: string;
	plan: TopicConsolidationBatchPlan;
	live_files: string[];
	backup_files: Map<string, string>;
	created_files: Set<string>;
	trash_files: Set<string>;
	ops: TopicFileOps;
}

interface TransactionFileRecord { live_path: string; backup_path: string; existed: boolean; }
interface TransactionManifest { operation_id: string; status: "prepared" | "committing" | "completed" | "rolled_back" | "rollback_failed"; files: TransactionFileRecord[]; trash_files: string[]; }

function transactionId(): string { return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`; }
function transactionRoot(id: string): string { return path.join(BASE, ".transactions", id); }
function writeManifest(tx: TopicConsolidationTransaction, status: TransactionManifest["status"]): void {
	const manifest: TransactionManifest = { operation_id: tx.operation_id, status, files: [...tx.backup_files].map(([live_path, backup_path]) => ({ live_path, backup_path, existed: true })), trash_files: [...tx.trash_files] };
	tx.ops.writeFileSync(tx.manifest_path, JSON.stringify(manifest, null, 2), "utf-8");
}
function allLiveFiles(plan: TopicConsolidationBatchPlan): string[] {
	return [...new Set([
		...plan.groups.map((group) => topicPath(group.target)),
		...plan.groups.flatMap((group) => group.fragment_updates.map((update) => update.fragment_path)),
		...plan.groups.flatMap((group) => group.sources.map((source) => topicPath(source))),
	])];
}
function stagePath(stagedRoot: string, index: number, kind: string): string { return path.join(stagedRoot, `${String(index).padStart(4, "0")}-${kind}.tmp`); }
function tempReplace(filePath: string, content: string, tx: TopicConsolidationTransaction, stagedFile: string): void {
	tx.ops.writeFileSync(stagedFile, content, "utf-8");
	const verified = tx.ops.readFileSync(stagedFile, "utf-8");
	if (verified !== content) throw new Error(`staged 文件校验失败：${stagedFile}`);
	const localTemp = `${filePath}.transaction-${tx.operation_id}.tmp`;
	tx.ops.writeFileSync(localTemp, content, "utf-8");
	tx.created_files.add(localTemp);
	// Windows 下目标可能存在；先备份，删除后 rename，失败由事务回滚恢复。
	if (tx.ops.existsSync(filePath)) tx.ops.unlinkSync(filePath);
	tx.ops.renameSync(localTemp, filePath);
	tx.created_files.delete(localTemp);
}
function createTransaction(plan: TopicConsolidationBatchPlan, ops: TopicFileOps): TopicConsolidationTransaction {
	const id = transactionId();
	const root = transactionRoot(id);
	const backup = path.join(root, "backup");
	const staged = path.join(root, "staged");
	const tx: TopicConsolidationTransaction = {
		operation_id: id,
		transaction_path: root,
		backup_path: backup,
		staged_path: staged,
		manifest_path: path.join(root, "manifest.json"),
		plan,
		live_files: allLiveFiles(plan),
		backup_files: new Map(),
		created_files: new Set(),
		trash_files: new Set(),
		ops,
	};
	ops.mkdirSync(backup, { recursive: true });
	ops.mkdirSync(staged, { recursive: true });
	return tx;
}

function snapshotTransaction(tx: TopicConsolidationTransaction): void {
	for (const [index, livePath] of tx.live_files.entries()) {
		if (!tx.ops.existsSync(livePath)) continue;
		const backupPath = path.join(tx.backup_path, `${String(index).padStart(4, "0")}.bak`);
		tx.ops.copyFileSync(livePath, backupPath);
		tx.backup_files.set(livePath, backupPath);
	}
	writeManifest(tx, "prepared");
}
function sourceTrashPath(source: string, operationId: string): string {
	const safe = source.replace(/[^a-zA-Z0-9一-鿿\-_ ]/g, "").replace(/\s+/g, "-");
	const trashDir = path.join(BASE, ".trash");
	const timestamp = Date.now();
	let candidate = path.join(trashDir, `${safe}-${timestamp}.md.bak`);
	let suffix = 1;
	while (fs.existsSync(candidate)) candidate = path.join(trashDir, `${safe}-${timestamp}-${suffix++}.md.bak`);
	return candidate;
}
function cleanupTransactionParent(tx: TopicConsolidationTransaction): void {
	const parent = path.dirname(tx.transaction_path);
	if (!tx.ops.existsSync(parent)) return;
	try {
		if (fs.readdirSync(parent).length === 0) tx.ops.rmSync(parent, { recursive: true, force: true });
	} catch {
		/* best effort cleanup */
	}
}
function rollbackTransaction(tx: TopicConsolidationTransaction): void {
	for (const filePath of [...tx.created_files]) if (tx.ops.existsSync(filePath)) tx.ops.unlinkSync(filePath);
	for (const [livePath, backupPath] of tx.backup_files) {
		const localTemp = `${livePath}.rollback-${tx.operation_id}.tmp`;
		const content = tx.ops.readFileSync(backupPath, "utf-8");
		tx.ops.writeFileSync(localTemp, content, "utf-8");
		if (tx.ops.existsSync(livePath)) tx.ops.unlinkSync(livePath);
		tx.ops.renameSync(localTemp, livePath);
	}
	for (const trashPath of tx.trash_files) if (tx.ops.existsSync(trashPath)) tx.ops.unlinkSync(trashPath);
	if (tx.ops.existsSync(tx.manifest_path)) tx.ops.unlinkSync(tx.manifest_path);
	if (tx.ops.existsSync(tx.staged_path)) tx.ops.rmSync(tx.staged_path, { recursive: true, force: true });
	if (tx.ops.existsSync(tx.backup_path)) tx.ops.rmSync(tx.backup_path, { recursive: true, force: true });
	if (tx.ops.existsSync(tx.transaction_path)) tx.ops.rmSync(tx.transaction_path, { recursive: true, force: true });
	cleanupTransactionParent(tx);
}
function commitTransaction(tx: TopicConsolidationTransaction): void {
	writeManifest(tx, "committing");
	let index = 0;
	for (const group of tx.plan.groups) {
		tempReplace(topicPath(group.target), buildTopicMD(group.merged_meta), tx, stagePath(tx.staged_path, index++, "topic"));
	}
	for (const group of tx.plan.groups) for (const update of group.fragment_updates) tempReplace(update.fragment_path, update.content_after, tx, stagePath(tx.staged_path, index++, "fragment"));
	for (const group of tx.plan.groups) for (const source of group.sources) {
		const sourcePath = topicPath(source); const trashDir = path.join(BASE, ".trash"); const trashPath = sourceTrashPath(source, tx.operation_id);
		tx.ops.mkdirSync(trashDir, { recursive: true }); tx.ops.copyFileSync(sourcePath, trashPath); tx.trash_files.add(trashPath); writeManifest(tx, "committing");
		tx.ops.unlinkSync(sourcePath);
	}
	writeManifest(tx, "completed");
	tx.ops.rmSync(tx.transaction_path, { recursive: true, force: true });
	cleanupTransactionParent(tx);
}

/** 事务执行。ops 仅用于可控故障注入测试；默认使用真实 fs。 */
export function applyTopicConsolidationBatchTransactional(plan: TopicConsolidationBatchPlan, ops: TopicFileOps = REAL_TOPIC_FILE_OPS): { transaction_path?: string; recovery_failed?: boolean; error?: string } {
	if (!plan.validated) return { error: "不能应用未通过预检的 Topic 合并计划" };
	let tx: TopicConsolidationTransaction | undefined;
	try {
		tx = createTransaction(plan, ops);
		snapshotTransaction(tx);
		commitTransaction(tx);
		return {};
	} catch (error) {
		if (!tx) return { error: error instanceof Error ? error.message : String(error) };
		try {
			rollbackTransaction(tx);
			return { error: error instanceof Error ? error.message : String(error) };
		} catch (rollbackError) {
			try { writeManifest(tx, "rollback_failed"); } catch { /* preserve transaction directory best-effort */ }
			return { transaction_path: tx.transaction_path, recovery_failed: true, error: `${error instanceof Error ? error.message : String(error)}；回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` };
		}
	}
}

/** Stage 5 事务入口；保留旧函数名。 */
export function applyTopicConsolidationBatch(plan: TopicConsolidationBatchPlan): void {
	const result = applyTopicConsolidationBatchTransactional(plan);
	if (result.error) throw new Error(result.error);
}
export function deleteTopic(name: string): boolean {
	const fp = topicPath(name); if (!fs.existsSync(fp)) return false;
	const trashDir = path.join(BASE, ".trash"); fs.mkdirSync(trashDir, { recursive: true }); const safe = name.replace(/[^a-zA-Z0-9一-鿿\-_ ]/g, "").replace(/\s+/g, "-"); const backupPath = path.join(trashDir, `${safe}-${Date.now()}.md.bak`); fs.copyFileSync(fp, backupPath); fs.unlinkSync(fp); return true;
}
export function mergeTopics(target: string, sources: string[], fragBase: string): { new_entries_count: number; fragments_updated: number; errors: string[] } {
	const plan = planTopicConsolidationBatch([{ target, sources }], fragBase);
	if (!plan.validated) return { new_entries_count: 0, fragments_updated: 0, errors: plan.errors.map((item) => item.error) };
	const result = applyTopicConsolidationBatchTransactional(plan);
	const group = plan.groups[0];
	return { new_entries_count: group?.new_entries_count ?? 0, fragments_updated: group?.fragments_updated ?? 0, errors: result.error ? [result.error] : [] };
}
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
