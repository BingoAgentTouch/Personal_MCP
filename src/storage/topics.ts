import * as fs from "node:fs";
import * as path from "node:path";
import type { TopicIndexMeta, TopicEntry } from "../types.js";

const BASE = path.resolve("memory/topics");

function ensureDir(): void {
	fs.mkdirSync(BASE, { recursive: true });
}

function topicPath(name: string): string {
	ensureDir();
	// 文件名安全：替换空格为 -，只保留字母数字中文和 -
	const safe = name.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_]/g, "");
	return path.join(BASE, `${safe}.md`);
}

/** 生成主题索引 MD */
function buildTopicMD(meta: TopicIndexMeta): string {
	const lines: string[] = [];
	lines.push(`# 主题：${meta.name}（${meta.date_range.start} ~ ${meta.date_range.end}）`);
	lines.push("");
	lines.push(`**涵盖日期**：${meta.entries.map((e) => e.date).join(", ")}`);
	lines.push(`**状态**：${meta.status === "active" ? "进行中" : "已完成"}`);
	lines.push("");
	lines.push("## 各阶段");
	lines.push("");
	for (const entry of meta.entries) {
		lines.push(`- ${entry.date}：${entry.summary}（→ daily/${entry.date}.md → ${entry.fragment_id}）`);
	}
	lines.push("");
	if (meta.constraints.length > 0) {
		lines.push("## 关键约束");
		lines.push("");
		for (const c of meta.constraints) {
			lines.push(`- ${c}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** 从 MD 解析 TopicIndexMeta */
function parseTopicMD(md: string, name: string): TopicIndexMeta | null {
	const titleMatch = md.match(/^# 主题：(.+?)（(.+?) ~ (.+?)）/m);
	if (!titleMatch) return null;

	const statusMatch = md.match(/\*\*状态\*\*[：:]\s*(.+)/);
	const status: "active" | "completed" =
		statusMatch && statusMatch[1].includes("完成") ? "completed" : "active";

	const entries: TopicEntry[] = [];
	const entryRe = /^- (\d{4}-\d{2}-\d{2})[：:]\s*(.+?)（→/gm;
	let match: RegExpExecArray | null;
	while ((match = entryRe.exec(md)) !== null) {
		const fragMatch = match[0].match(/→\s*([^)]+)\)/);
		entries.push({
			date: match[1],
			fragment_id: fragMatch ? fragMatch[1].trim() : "",
			summary: match[2].trim(),
		});
	}

	const constraintsSection = md.indexOf("## 关键约束");
	const constraints: string[] = [];
	if (constraintsSection !== -1) {
		const constraintLines = md.slice(constraintsSection).split("\n").slice(2);
		for (const line of constraintLines) {
			const trimmed = line.trim();
			if (trimmed.startsWith("- ")) {
				constraints.push(trimmed.slice(2));
			} else if (trimmed === "") {
				break;
			}
		}
	}

	return {
		name: titleMatch[1].trim(),
		date_range: { start: titleMatch[2].trim(), end: titleMatch[3].trim() },
		status,
		entries,
		constraints,
	};
}

/** 创建或更新主题索引 */
export function upsertTopic(
	topicName: string,
	date: string,
	fragmentId: string,
	summaryMd: string,
): TopicIndexMeta {
	const fp = topicPath(topicName);

	let meta: TopicIndexMeta;
	if (fs.existsSync(fp)) {
		const existing = parseTopicMD(fs.readFileSync(fp, "utf-8"), topicName);
		if (!existing) {
			// 解析失败，重建
			meta = {
				name: topicName,
				date_range: { start: date, end: date },
				status: "active",
				entries: [{ date, fragment_id: fragmentId, summary: summaryMd }],
				constraints: [],
			};
		} else {
			const existingDates = existing.entries.map((e) => e.date);
			if (!existingDates.includes(date)) {
				existing.entries.push({ date, fragment_id: fragmentId, summary: summaryMd });
			}
			existing.entries.sort((a, b) => a.date.localeCompare(b.date));
			const allDates = existing.entries.map((e) => e.date);
			existing.date_range = { start: allDates[0], end: allDates[allDates.length - 1] };
			meta = existing;
		}
	} else {
		meta = {
			name: topicName,
			date_range: { start: date, end: date },
			status: "active",
			entries: [{ date, fragment_id: fragmentId, summary: summaryMd }],
			constraints: [],
		};
	}

	fs.writeFileSync(fp, buildTopicMD(meta), "utf-8");
	return meta;
}

/** 读取主题索引 */
export function getTopic(name: string): TopicIndexMeta | null {
	const fp = topicPath(name);
	if (!fs.existsSync(fp)) return null;
	return parseTopicMD(fs.readFileSync(fp, "utf-8"), name);
}

/** 读取主题原始 MD */
export function getTopicRaw(name: string): string | null {
	const fp = topicPath(name);
	if (!fs.existsSync(fp)) return null;
	return fs.readFileSync(fp, "utf-8");
}

/** 列出所有主题名称 */
export function listTopics(): string[] {
	if (!fs.existsSync(BASE)) return [];
	return fs
		.readdirSync(BASE)
		.filter((f) => f.endsWith(".md"))
		.map((f) => f.replace(".md", ""));
}

/** 将主题名称 convert 为安全文件名并找到实际文件路径 */
export function resolveTopicPath(name: string): string {
	return topicPath(name);
}
