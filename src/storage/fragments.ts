import * as fs from "node:fs";
import * as path from "node:path";
import type { FragmentInput, FragmentMeta } from "../types.js";
import { getTurnRangeText } from "./raw.js";

const BASE = path.resolve("memory/fragments");

function ensureDateDir(date: string): string {
	const dir = path.join(BASE, date);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** 获取指定日期已有的片段数量，用于编号 */
function nextFragNum(date: string): number {
	const dir = ensureDateDir(date);
	const existing = fs.readdirSync(dir).filter((f) => f.startsWith("frag_") && f.endsWith(".md"));
	return existing.length + 1;
}

/** 片段 MD 文件路径 */
function fragPath(date: string, id: string): string {
	return path.join(ensureDateDir(date), `${id}.md`);
}

/** embedding 文件路径 */
export function embeddingPath(date: string, id: string): string {
	return path.join(ensureDateDir(date), `${id}.embedding`);
}

/** 生成片段 MD 内容 */
function buildFragmentMD(input: FragmentInput, turnsText: string): string {
	const lines: string[] = [];
	lines.push(`# 任务：${input.task_desc}`);
	lines.push("");
	lines.push(`**日期**：${input.date}`);
	lines.push(`**轮次**：${input.start_turn_id} ~ ${input.end_turn_id}`);
	lines.push(`**标签**：${input.tags.map((t) => "`" + t + "`").join(" ")}`);
	lines.push(`**主题**：${input.topic_name}`);
	if (input.agent_id) {
		lines.push(`**Agent**：${input.agent_id}`);
	}
	lines.push("");
	lines.push("## 摘要");
	lines.push("");
	lines.push(input.task_desc);
	lines.push("");
	lines.push("## 结论");
	lines.push("");
	lines.push(input.result_desc);
	lines.push("");
	lines.push("## 原文");
	lines.push("");
	lines.push(turnsText);
	lines.push("");
	return lines.join("\n");
}

/** 从 MD 文件解析 FragmentMeta */
function parseFragmentMD(md: string, date: string, id: string): FragmentMeta | null {
	const lines = md.split("\n");

	// 解析 ## 区块
	let currentSection = "";
	const sections: Record<string, string[]> = { header: [] };

	for (const line of lines) {
		if (line.startsWith("## ")) {
			currentSection = line.slice(3).trim();
			sections[currentSection] = [];
		} else if (currentSection === "") {
			sections.header.push(line);
		} else {
			sections[currentSection].push(line);
		}
	}

	const header = sections.header.join("\n");

	// 解析 **key**：value 行
	const taskMatch = header.match(/^# 任务：(.+)$/m);
	const dateMatch = header.match(/\*\*日期\*\*[：:]\s*(.+)/);
	const turnsMatch = header.match(/\*\*轮次\*\*[：:]\s*(.+)/);
	const tagsMatch = header.match(/\*\*标签\*\*[：:]\s*(.+)/);
	const topicMatch = header.match(/\*\*主题\*\*[：:]\s*(.+)/);
	const agentMatch = header.match(/\*\*Agent\*\*[：:]\s*(.+)/);

	if (!taskMatch || !dateMatch || !turnsMatch) return null;

	const [start_turn_id, end_turn_id] = turnsMatch[1].split("~").map((s) => s.trim());
	const tagsStr = tagsMatch ? tagsMatch[1] : "";
	const tags = tagsStr.match(/`([^`]+)`/g)?.map((t) => t.replace(/`/g, "")) ?? [];

	return {
		fragment_id: `${date}/${id}`,
		date: dateMatch[1].trim(),
		start_turn_id,
		end_turn_id,
		task_desc: taskMatch[1].trim(),
		result_desc: (sections["结论"] ?? []).join("\n").trim(),
		tags,
		topic_name: topicMatch ? topicMatch[1].trim() : "",
		agent_id: agentMatch ? agentMatch[1].trim() : undefined,
		turns_text: (sections["原文"] ?? []).join("\n").trim(),
	};
}

/** 创建任务-结果片段 */
export function createFragment(input: FragmentInput): { fragment_id: string; meta: FragmentMeta } {
	const turnsText = getTurnRangeText(input.date, input.start_turn_id, input.end_turn_id);
	const num = nextFragNum(input.date);
	const id = `frag_${String(num).padStart(3, "0")}`;
	const md = buildFragmentMD(input, turnsText);
	fs.writeFileSync(fragPath(input.date, id), md, "utf-8");

	const meta: FragmentMeta = {
		fragment_id: `${input.date}/${id}`,
		date: input.date,
		start_turn_id: input.start_turn_id,
		end_turn_id: input.end_turn_id,
		task_desc: input.task_desc,
		result_desc: input.result_desc,
		tags: input.tags,
		topic_name: input.topic_name,
		agent_id: input.agent_id,
		turns_text: turnsText,
	};

	return { fragment_id: `${input.date}/${id}`, meta };
}

/** 根据 ID 读取片段 */
export function getFragment(fragmentId: string): FragmentMeta | null {
	// fragmentId: "2025-06-15/frag_003"
	const [date, id] = fragmentId.split("/");
	const fp = fragPath(date, id);
	if (!fs.existsSync(fp)) return null;
	const md = fs.readFileSync(fp, "utf-8");
	return parseFragmentMD(md, date, id);
}

/** 返回以文本形式读取的片段 MD，用于 resource */
export function getFragmentRaw(fragmentId: string): string | null {
	const [date, id] = fragmentId.split("/");
	const fp = fragPath(date, id);
	if (!fs.existsSync(fp)) return null;
	return fs.readFileSync(fp, "utf-8");
}

/** 列出所有片段 ID */
export function listAllFragmentIds(): string[] {
	if (!fs.existsSync(BASE)) return [];
	const ids: string[] = [];
	for (const dateDir of fs.readdirSync(BASE, { withFileTypes: true })) {
		if (!dateDir.isDirectory()) continue;
		const date = dateDir.name;
		const fragDir = path.join(BASE, date);
		for (const file of fs.readdirSync(fragDir)) {
			if (file.endsWith(".md")) {
				ids.push(`${date}/${file.replace(".md", "")}`);
			}
		}
	}
	return ids.sort();
}

/** 列出某日的所有片段 ID */
export function listFragmentIdsByDate(date: string): string[] {
	return listAllFragmentIds().filter((id) => id.startsWith(date + "/"));
}
