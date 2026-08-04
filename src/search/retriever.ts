import * as fs from "node:fs";
import type { EmbeddingLayer, SearchResultItem, SearchResults } from "../types.js";
import { listAllFragmentIds, getFragment, readMeta } from "../storage/fragments.js";
import { getDailySummaryMeta } from "../storage/daily.js";
import { getTopic } from "../storage/topics.js";
import { encode, cosine, jaccardSimilarity, isFallbackMode } from "../embedding/provider.js";
import { buildQueryInput } from "../embedding/builder.js";
import { generationVectorPath, getActiveGeneration } from "../embedding/generation.js";
import { buildEffectiveEmbeddingView, deltaVectorPath } from "../embedding/delta.js";

/**
 * 由先天重要性映射出保底权重（第一期 combined_weight = decay_floor）。
 *   decay_floor = importance × 0.7 + (1 - importance) × 0.3 = 0.4 × importance + 0.3
 * 值域 [0.3, 0.7]，恒 ≤ 1.0：纯衰减、只重排、绝不放大到原始相似度之上。
 */
export function decayFloor(importance: number): number {
	const imp = Math.max(0, Math.min(1, importance));
	return 0.4 * imp + 0.3;
}

async function loadAllEmbeddings(): Promise<{
	vectors: Map<string, { vector: number[]; layer: EmbeddingLayer }>;
	health: SearchResults["health"];
	deltaId: string | null;
	baseGenerationId: string | null;
}> {
	const map = new Map<string, { vector: number[]; layer: EmbeddingLayer }>();
	const { baseGeneration, deltaManifest, index, health } = buildEffectiveEmbeddingView();
	for (const [fragId, entry] of index) {
		const ep = entry.layer === "delta"
			? deltaVectorPath(fragId)
			: baseGeneration
				? generationVectorPath(baseGeneration.generation_id, fragId)
				: null;
		if (!ep || !fs.existsSync(ep)) continue;
		try {
			const raw = fs.readFileSync(ep, "utf-8");
			const vec = JSON.parse(raw) as number[];
			if (!Array.isArray(vec) || vec.some((value) => !Number.isFinite(value))) throw new Error("invalid vector");
			if (baseGeneration && vec.length !== baseGeneration.dimension) throw new Error("dimension mismatch");
			map.set(fragId, { vector: vec, layer: entry.layer });
		} catch (error) {
			console.error(`[embedding] 无法加载 ${fragId} 的 ${entry.layer} vector：${String(error)}`);
		}
	}
	return {
		vectors: map,
		health,
		deltaId: deltaManifest?.delta_id ?? null,
		baseGenerationId: baseGeneration?.generation_id ?? null,
	};
}

/**
 * 对候选池（已按 raw similarity 排好序）套第一期权重重排，取 top_k。
 *   final_score = similarity × decayFloor(importance)
 * 读 meta 只发生在候选池（top_k×3），是相对全量检索的边际成本。
 */
function weightAndRerank(
	scored: Array<{ id: string; score: number; layer: EmbeddingLayer }>,
	topK: number,
	baseGenerationId: string | null,
	deltaId: string | null,
): SearchResultItem[] {
	scored.sort((a, b) => b.score - a.score);
	const pool = scored.slice(0, topK * 3);

	const weighted = pool.map((s) => {
		const meta = readMeta(s.id);
		const weight = decayFloor(meta.importance);
		return {
			id: s.id,
			layer: s.layer,
			rawSimilarity: s.score,
			weight,
			final: s.score * weight,
		};
	});

	weighted.sort((a, b) => b.final - a.final);

	const results: SearchResultItem[] = [];
	for (const w of weighted.slice(0, topK)) {
		const item = buildResultItem(w.id, w.rawSimilarity, w.weight, w.layer, baseGenerationId, deltaId);
		if (item) results.push(item);
	}
	return results;
}

/** 回退模式搜索：Jaccard 相似度 + 第一期权重重排 */
function fallbackSearch(query: string, topK: number, agentId?: string): SearchResultItem[] {
	const ids = listAllFragmentIds();
	const scored: Array<{ id: string; score: number; layer: EmbeddingLayer }> = [];

	for (const fragId of ids) {
		const frag = getFragment(fragId);
		if (!frag) continue;
		if (agentId && frag.agent_id !== agentId) continue;
		const text = frag.task_desc + " " + frag.result_desc + " " + frag.turns_text.slice(0, 2000);
		const score = jaccardSimilarity(query, text);
		if (score > 0) {
			scored.push({ id: fragId, score, layer: "base" });
		}
	}

	return weightAndRerank(scored, topK, null, null);
}

/** 构建单个结果条目（含层级回溯 + 三分数透出） */
function buildResultItem(
	fragId: string,
	rawSimilarity: number,
	weight: number,
	layer: EmbeddingLayer,
	baseGenerationId: string | null,
	deltaId: string | null,
): SearchResultItem | null {
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
		embedding_layer: layer,
		base_generation_id: baseGenerationId,
		delta_id: layer === "delta" ? deltaId : null,
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

	if (isFallbackMode()) {
		return {
			query,
			results: fallbackSearch(query, topK, filterAgentId),
		};
	}

	const active = getActiveGeneration();
	const builtQuery = await buildQueryInput(query, active ?? undefined);
	const queryVec = await encode(builtQuery.text);
	if (queryVec.length === 0) {
		return { query, results: fallbackSearch(query, topK, filterAgentId) };
	}

	const allEmbeddings = await loadAllEmbeddings();
	const scored: Array<{ id: string; score: number; layer: EmbeddingLayer }> = [];

	for (const [fragId, entry] of allEmbeddings.vectors) {
		if (filterAgentId) {
			const frag = getFragment(fragId);
			if (!frag || frag.agent_id !== filterAgentId) continue;
		}
		const sim = cosine(queryVec, entry.vector);
		if (sim > 0) {
			scored.push({ id: fragId, score: sim, layer: entry.layer });
		}
	}

	return {
		query,
		results: weightAndRerank(scored, topK, allEmbeddings.baseGenerationId, allEmbeddings.deltaId),
		health: allEmbeddings.health,
	};
}
