import * as fs from "node:fs";
import * as path from "node:path";
import type { SearchResultItem } from "../types.js";

const BASE = path.resolve("memory/signals");

function ensureDir(): string {
	fs.mkdirSync(BASE, { recursive: true });
	return BASE;
}

/**
 * 检索埋点（纯观察，不影响排名）。为 P3 命中信号研究收集数据：
 * 每次 memory_search 追加一行，记录本次 query 与它 surface 出的每个片段的
 * 名次 / 原始相似度 / 权重 / final。best-effort —— 任何异常都不影响检索本身。
 *
 * 注意：这里记的是「谁被 surface 出来」（impression），不是「谁真的被用」。
 * 「被用」信号仍是 P3 的开放问题；本日志只回答「重复出现/难易度方差」是否存在。
 * 观察期结束后可整目录删除（memory/ 已被 .gitignore）。
 */
export function logSearch(query: string, results: SearchResultItem[], agentId?: string): void {
	try {
		ensureDir();
		const line = {
			ts: new Date().toISOString(),
			query,
			agent_id: agentId ?? null,
			results: results.map((r, i) => ({
				fragment_id: r.fragment_id,
				rank: i + 1,
				raw_similarity: r.raw_similarity,
				weight: r.weight,
				score: r.score,
			})),
		};
		fs.appendFileSync(path.join(BASE, "search.jsonl"), JSON.stringify(line) + "\n", "utf-8");
	} catch {
		// 埋点尽力而为，绝不因日志写入失败影响检索
	}
}

/**
 * 读原文埋点（纯观察，不影响读取，不进排名）。为 P3 成功信号研究收集数据：
 * 每次 memory_get_fragment 追加一行，记录本次读取的片段、谁促成的读取
 * （confirmed_by=user 才是「人工点头」的金标准成功）、以及促成读取的检索词。
 * best-effort —— 任何异常都不影响读取本身。
 *
 * 靠 {ts, agent_id, fragment_id, query} 与 search.jsonl 离线配对，
 * 重建「一次回忆花了几轮 search、最后有没有人点头」的 episode。
 * 观察期结束后可整目录删除（memory/ 已被 .gitignore）。
 */
export function logGetFragment(
	fragmentId: string,
	confirmedBy?: "user" | "agent",
	query?: string,
	agentId?: string,
): void {
	try {
		ensureDir();
		const line = {
			ts: new Date().toISOString(),
			fragment_id: fragmentId,
			agent_id: agentId ?? null,
			confirmed_by: confirmedBy ?? null,
			query: query ?? null,
		};
		fs.appendFileSync(path.join(BASE, "get_fragment.jsonl"), JSON.stringify(line) + "\n", "utf-8");
	} catch {
		// 埋点尽力而为，绝不因日志写入失败影响读取
	}
}
