import * as fs from "node:fs";
import * as path from "node:path";
import type { DailySummaryMeta } from "../types.js";

const BASE = path.resolve("memory/daily");

function ensureDir(): void {
	fs.mkdirSync(BASE, { recursive: true });
}

function summaryPath(date: string): string {
	ensureDir();
	return path.join(BASE, `${date}.md`);
}

/** 写入每日总结 */
export function createDailySummary(date: string, summaryMd: string): void {
	fs.writeFileSync(summaryPath(date), summaryMd, "utf-8");
}

/** 读取每日总结 */
export function getDailySummary(date: string): string | null {
	const fp = summaryPath(date);
	if (!fs.existsSync(fp)) return null;
	return fs.readFileSync(fp, "utf-8");
}

/** 解析每日总结 MD 的前几行来提取日期和主题列表 */
export function getDailySummaryMeta(date: string): DailySummaryMeta | null {
	const raw = getDailySummary(date);
	if (!raw) return null;

	const topicsMatch = raw.match(/\*\*涉及主题\*\*[：:]\s*(.+)/);
	const topicsStr = topicsMatch ? topicsMatch[1] : "";
	const topics = topicsStr.match(/`([^`]+)`/g)?.map((t) => t.replace(/`/g, "")) ?? [];

	return {
		date,
		topics,
		summary_md: raw,
	};
}

/** 列出所有有每日总结的日期 */
export function listDates(): string[] {
	if (!fs.existsSync(BASE)) return [];
	return fs
		.readdirSync(BASE)
		.filter((f) => f.endsWith(".md"))
		.map((f) => f.replace(".md", ""))
		.sort();
}
