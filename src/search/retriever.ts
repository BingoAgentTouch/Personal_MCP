import * as fs from "node:fs";
import type { SearchResultItem, SearchResults } from "../types.js";
import { listAllFragmentIds, getFragment, embeddingPath, readMeta } from "../storage/fragments.js";
import { getDailySummaryMeta } from "../storage/daily.js";
import { getTopic } from "../storage/topics.js";
import { encode, cosine, jaccardSimilarity, isFallbackMode } from "../embedding/provider.js";
import { buildQueryInput } from "../embedding/builder.js";
import { getActiveGeneration, generationVectorPath } from "../embedding/generation.js";

/**
 * 由先天重要性映射出保底权重（第一期 combined_weight = decay_floor）。
 *   decay_floor = importance × 0.7 + (1 - importance) × 0.3 = 0.4 × importance + 0.3
 * 值域 [0.3, 0.7]，恒 ≤ 1.0：纯衰减、只重排、绝不放大到原始相似度之上。
 */
export function decayFloor(importance: number): number {
	const imp = Math.max(0, Math.min(1, importance));
	return 0.4 * imp + 0.3;
}

/** 加载 active generation 的 embedding；没有 generation 时兼容 legacy 裸向量。 */
async function loadAllEmbeddings(): Promise<Map<string, number[]>> {
	const map = new Map<string, number[]>();
	const active = getActiveGeneration();
	const ids = listAllFragmentIds();
	for (const fragId of ids) {
		const ep = active
			? generationVectorPath(active.generation_id, fragId)
			: embeddingPath(...(fragId.split("/") as [string, string]));
		if (!fs.existsSync(ep)) continue;
		try {
			const raw = fs.readFileSync(ep, "utf-8");
			const vec = JSON.parse(raw) as number[];
			if (!Array.isArray(vec) || vec.some((value) => !Number.isFinite(value))) throw new Error("invalid vector");
			if (active && vec.length !== active.dimension) throw new Error("dimension mismatch");
			map.set(fragId, vec);
		} catch (error) {
			console.error(`[embedding] 无法加载 ${fragId} 的 active vector：${String(error)}`);
		}
	}
	return map;
}

/**
 * 对候选池（已按 raw similarity 排好序）套第一期权重重排，取 top_k。
 *   final_score = similarity × decayFloor(importance)
 * 读 meta 只发生在候选池（top_k×3），是相对全量检索的边际成本。
 */
function weightAndRerank(
	scored: Array<{ id: string; score: number }>,
	topK: number,
): SearchResultItem[] {
	// 先按 raw similarity 取候选池 top_k×3
	scored.sort((a, b) => b.score - a.score);
	const pool = scored.slice(0, topK * 3);

	const weighted = pool.map((s) => {
		const meta = readMeta(s.id);
		const weight = decayFloor(meta.importance);
		return { id: s.id, rawSimilarity: s.score, weight, final: s.score * weight };
	});

	weighted.sort((a, b) => b.final - a.final);

	const results: SearchResultItem[] = [];
	for (const w of weighted.slice(0, topK)) {
		const item = buildResultItem(w.id, w.rawSimilarity, w.weight);
		if (item) results.push(item);
	}
	return results;
}

/** 回退模式搜索：Jaccard 相似度 + 第一期权重重排 */
function fallbackSearch(query: string, topK: number, agentId?: string): SearchResultItem[] {
	const ids = listAllFragmentIds();
	const scored: Array<{ id: string; score: number }> = [];

	for (const fragId of ids) {
		const frag = getFragment(fragId);
		if (!frag) continue;
		if (agentId && frag.agent_id !== agentId) continue;
		const text = frag.task_desc + " " + frag.result_desc + " " + frag.turns_text.slice(0, 2000);
		const score = jaccardSimilarity(query, text);
		if (score > 0) {
			scored.push({ id: fragId, score });
		}
	}

	return weightAndRerank(scored, topK);
}

/** 构建单个结果条目（含层级回溯 + 三分数透出） */
function buildResultItem(fragId: string, rawSimilarity: number, weight: number): SearchResultItem | null {
	const frag = getFragment(fragId);
	if (!frag) return null;

	const daily = getDailySummaryMeta(frag.date);
	const topic = frag.topic_name ? getTopic(frag.topic_name) : null;

	let topicSummary: string | null = null;
	if (topic) {
		topicSummary = topic.entries.map((e) => `${e.date}：${e.summary}`).join("；");
	}

	const round4 = (n: number) => Math.round(n * 10000) / 10000;

	return {
		fragment_id: frag.fragment_id,
		score: round4(rawSimilarity * weight),
		raw_similarity: round4(rawSimilarity),
		weight: round4(weight),
		task_desc: frag.task_desc,
		result_desc: frag.result_desc,
		tags: frag.tags,
		date: frag.date,
		turns_range: `${frag.start_turn_id} ~ ${frag.end_turn_id}`,
		agent_id: frag.agent_id,
		hierarchy: {
			daily_summary: daily?.summary_md ?? null,
			topic_name: frag.topic_name,
			topic_summary: topicSummary,
		},
	};
}

/** 语义检索：embedding 搜索 + 权重重排 + 层级回溯 */
export async function search(query: string, topK: number = 10, agentId?: string): Promise<SearchResults> {
	const filterAgentId = agentId;

	// 回退模式
	if (isFallbackMode()) {
		return {
			query,
			results: fallbackSearch(query, topK, filterAgentId),
		};
	}

	// 正常模式：query 与 document 共用 active manifest 声明的构造规则
	const active = getActiveGeneration();
	const builtQuery = await buildQueryInput(query, active ?? undefined);
	const queryVec = await encode(builtQuery.text);
	if (queryVec.length === 0) {
		return { query, results: fallbackSearch(query, topK, filterAgentId) };
	}

	const allEmbeddings = await loadAllEmbeddings();
	const scored: Array<{ id: string; score: number }> = [];

	for (const [fragId, vec] of allEmbeddings) {
		// 按 agent 过滤
		if (filterAgentId) {
			const frag = getFragment(fragId);
			if (!frag || frag.agent_id !== filterAgentId) continue;
		}
		const sim = cosine(queryVec, vec);
		if (sim > 0) {
			scored.push({ id: fragId, score: sim });
		}
	}

	return { query, results: weightAndRerank(scored, topK) };
}
