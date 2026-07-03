import * as fs from "node:fs";
import * as path from "node:path";
import type { TurnRecord } from "../types.js";

const BASE = path.resolve("memory/raw");

function ensureDir(date: string): string {
	const dir = path.join(BASE, date);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function turnsPath(date: string): string {
	return path.join(ensureDir(date), "turns.jsonl");
}

/** 获取指定日期的下一个 turn_id */
function nextTurnId(date: string): string {
	const existing = readTurns(date);
	const lastNum = existing.length;
	return `turn_${String(lastNum + 1).padStart(4, "0")}`;
}

/** 追加一轮对话到 turns.jsonl */
export function appendTurn(date: string, role: "user" | "assistant", content: string, agentId?: string): TurnRecord {
	const record: TurnRecord = {
		turn_id: nextTurnId(date),
		role,
		content,
		timestamp: new Date().toISOString(),
		agent_id: agentId,
	};
	fs.appendFileSync(turnsPath(date), JSON.stringify(record) + "\n", "utf-8");
	return record;
}

/** 读取某日所有轮次 */
export function readTurns(date: string): TurnRecord[] {
	const fp = turnsPath(date);
	if (!fs.existsSync(fp)) return [];
	const text = fs.readFileSync(fp, "utf-8").trim();
	if (!text) return [];
	return text.split("\n").map((line) => JSON.parse(line) as TurnRecord);
}

/** 获取指定轮次范围内的原文文本 */
export function getTurnRangeText(date: string, startId: string, endId: string): string {
	const turns = readTurns(date);
	const startIdx = turns.findIndex((t) => t.turn_id === startId);
	const endIdx = turns.findIndex((t) => t.turn_id === endId);
	if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
		return "";
	}
	return turns
		.slice(startIdx, endIdx + 1)
		.map((t) => `[${t.role === "user" ? "用户" : "AI"}]：${t.content}`)
		.join("\n\n");
}

/** 列出所有有记录的日期 */
export function listDates(): string[] {
	if (!fs.existsSync(BASE)) return [];
	return fs
		.readdirSync(BASE, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}
