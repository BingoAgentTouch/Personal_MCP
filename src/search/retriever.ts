import * as fs from "node:fs";
import type { SearchResultItem, SearchResults } from "../types.js";
import { listAllFragmentIds, getFragment, embeddingPath } from "../storage/fragments.js";
import { getDailySummaryMeta } from "../storage/daily.js";
import { getTopic } from "../storage/topics.js";
import { encode, cosine, jaccardSimilarity, isFallbackMode } from "../embedding/provider.js";

/** 加载所有片段的 embedding 向量 */
async function loadAllEmbeddings(): Promise<Map<string, number[]>> {
	const map = new Map<string, number[]>();
	const ids = listAllFragmentIds();
	for (const fragId of ids) {
		const ep = embeddingPath(...fragId.split("/") as [string, string]);
		if (fs.existsSync(ep)) {
			try {
				const raw = fs.readFileSync(ep, "utf-8");
				const vec = JSON.parse(raw) as number[];
				map.set(fragId, vec);
			} catch {
				// 跳过损坏的 embedding
			}
		}
	}
	return map;
}

/** 回退模式搜索：Jaccard 相似度 */
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

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topK).map((s) => buildResultItem(s.id, s.score)).filter((x): x is SearchResultItem => x !== null);
}

/** 构建单个结果条目（含层级回溯） */
function buildResultItem(fragId: string, score: number): SearchResultItem | null {
	const frag = getFragment(fragId);
	if (!frag) return null;

	const daily = getDailySummaryMeta(frag.date);
	const topic = frag.topic_name ? getTopic(frag.topic_name) : null;

	let topicSummary: string | null = null;
	if (topic) {
		topicSummary = topic.entries.map((e) => `${e.date}：${e.summary}`).join("；");
	}

	return {
		fragment_id: frag.fragment_id,
		score: Math.round(score * 10000) / 10000,
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

/** 语义检索：embedding 搜索 + 层级回溯 */
export async function search(query: string, topK: number = 10, agentId?: string): Promise<SearchResults> {
	// const file-scoped variable for agent filtering
	const filterAgentId = agentId;

	// 回退模式
	if (isFallbackMode()) {
		return {
			query,
			results: fallbackSearch(query, topK, filterAgentId),
		};
	}

	// 正常模式：embedding 搜索
	const queryVec = await encode(query);
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

	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, topK);

	const results: SearchResultItem[] = [];
	for (const s of top) {
		const item = buildResultItem(s.id, s.score);
		if (item) results.push(item);
	}

	return { query, results };
}
