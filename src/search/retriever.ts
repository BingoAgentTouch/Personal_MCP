import * as fs from "node:fs";
import type {
	EmbeddingLayer,
	EmbeddingSourceSpan,
	FragmentWeightMeta,
	RawSimilarityMode,
	SearchResultItem,
	SearchResults,
	SearchSnippetAnchor,
} from "../types.js";
import { listAllFragmentIds, getFragment, readMeta } from "../storage/fragments.js";
import { getDailySummaryMeta } from "../storage/daily.js";
import { getTopic } from "../storage/topics.js";
import { encode, cosine, jaccardSimilarity, isFallbackMode } from "../embedding/provider.js";
import { buildQueryInput } from "../embedding/builder.js";
import {
	generationVectorPath,
	getActiveGeneration,
	isMultiviewGeneration,
	readGenerationIndex,
	readGenerationMultiviewViews,
} from "../embedding/generation.js";
import {
	buildEffectiveEmbeddingView,
	deltaVectorPath,
	readDeltaMultiviewViews,
	type EffectiveMultiviewView,
} from "../embedding/delta.js";

/**
 * 由先天重要性映射出保底权重（第一期 combined_weight = decay_floor）。
 *   decay_floor = importance × 0.7 + (1 - importance) × 0.3 = 0.4 × importance + 0.3
 * 值域 [0.3, 0.7]，恒 ≤ 1.0：纯衰减、只重排、绝不放大到原始相似度之上。
 */
export function decayFloor(importance: number): number {
	const imp = Math.max(0, Math.min(1, importance));
	return 0.4 * imp + 0.3;
}

/** P3 Phase 1c：earned 只能提升有效重要性，不能降低先天 importance。 */
export function effectiveImportance(meta: Pick<FragmentWeightMeta, "importance" | "earned_importance">): number {
	const base = Number.isFinite(meta.importance) ? meta.importance : 0.5;
	const earned = Number.isFinite(meta.earned_importance) ? meta.earned_importance ?? 0 : 0;
	return Math.max(0, Math.min(1, Math.max(base, earned)));
}

/** A multiview evidence score affects ranking only through a validated policy snapshot. */
export const MULTIVIEW_CANDIDATE_POOL_MULTIPLIER = 3;

type LoadedVector = { vector: number[]; layer: EmbeddingLayer };
type LoadedMultiview = { views: EffectiveMultiviewView[]; layer: EmbeddingLayer };

interface RetrievalIdentity {
	generationId: string | null;
	representationIdentityHash: string | null;
	retrievalEpoch: string | null;
	evidencePolicyId: string | null;
	evidencePolicy: import("../types.js").EvidenceGatePolicySnapshot | null;
}

async function loadAllEmbeddings(): Promise<{
	vectors: Map<string, LoadedVector>;
	multiview: Map<string, LoadedMultiview>;
	health: SearchResults["health"];
	deltaId: string | null;
	baseGenerationId: string | null;
}> {
	const vectors = new Map<string, LoadedVector>();
	const multiview = new Map<string, LoadedMultiview>();
	const { baseGeneration, deltaManifest, index, health } = buildEffectiveEmbeddingView();
	const activeIsMultiview = baseGeneration ? isMultiviewGeneration(baseGeneration) : false;
	const baseGenerationIndex = activeIsMultiview && baseGeneration
		? readGenerationIndex(baseGeneration.generation_id)
		: null;
	for (const [fragId, entry] of index) {
		if (activeIsMultiview) {
			const views = entry.layer === "delta"
				? readDeltaMultiviewViews(fragId, entry.record ?? undefined, baseGeneration!.dimension)
				: readGenerationMultiviewViews(
					baseGeneration!.generation_id,
					fragId,
					baseGenerationIndex?.[fragId],
					baseGeneration!.dimension,
				);
			if (views) multiview.set(fragId, { views, layer: entry.layer });
			continue;
		}
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
			vectors.set(fragId, { vector: vec, layer: entry.layer });
		} catch (error) {
			console.error(`[embedding] 无法加载 ${fragId} 的 ${entry.layer} vector：${String(error)}`);
		}
	}
	return {
		vectors,
		multiview,
		health,
		deltaId: deltaManifest?.delta_id ?? null,
		baseGenerationId: baseGeneration?.generation_id ?? null,
	};
}

interface ScoredFragment {
	id: string;
	rawSimilarity: number;
	layer: EmbeddingLayer;
	matchedView?: EffectiveMultiviewView;
	rawSimilarityMode: RawSimilarityMode;
}

function chooseBestView(current: { score: number; view: EffectiveMultiviewView } | null, candidate: { score: number; view: EffectiveMultiviewView }): { score: number; view: EffectiveMultiviewView } {
	if (!current || candidate.score > current.score || (candidate.score === current.score && candidate.view.view_id.localeCompare(current.view.view_id) < 0)) return candidate;
	return current;
}

function queryNeedles(query: string): string[] {
	const normalized = query.normalize("NFC").toLocaleLowerCase();
	const needles = new Set<string>();
	for (const token of normalized.match(/[\p{L}\p{N}_.:/\\-]+/gu) ?? []) {
		if (token.length >= 2) needles.add(token);
	}
	const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
	for (const run of hanRuns) {
		for (let index = 0; index < run.length - 1; index++) needles.add(run.slice(index, index + 2));
		if (run.length === 1) needles.add(run);
	}
	return [...needles].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function lexicalSnippet(query: string, source: string): string | null {
	const normalized = source.normalize("NFC");
	const lower = normalized.toLocaleLowerCase();
	const needle = queryNeedles(query).find((candidate) => lower.indexOf(candidate) >= 0);
	if (!needle) return null;
	const match = lower.indexOf(needle);
	const points = Array.from(normalized);
	const start = Math.max(0, Array.from(lower.slice(0, match)).length - 180);
	const end = Math.min(points.length, start + 420);
	return points.slice(start, end).join("").trim() || null;
}

function viewDisclosure(query: string, fragment: NonNullable<ReturnType<typeof getFragment>>, view?: EffectiveMultiviewView): {
	matchedView: string | null;
	matchedSourceRange: EmbeddingSourceSpan | null;
	matchedSnippet: string | null;
	snippetAnchor: SearchSnippetAnchor;
} {
	if (!view) return { matchedView: null, matchedSourceRange: null, matchedSnippet: null, snippetAnchor: null };
	if (view.kind === "summary") {
		return {
			matchedView: view.view_id,
			matchedSourceRange: null,
			matchedSnippet: view.disclosure.snippet || null,
			snippetAnchor: view.disclosure.snippet ? "view_fallback" : null,
		};
	}
	const sourceRange = view.source_spans.find((span) => span.source_field === "turns_text") ?? null;
	if (!sourceRange) return {
		matchedView: view.view_id,
		matchedSourceRange: null,
		matchedSnippet: view.disclosure.snippet || null,
		snippetAnchor: view.disclosure.snippet ? "view_fallback" : null,
	};
	const source = fragment.turns_text.slice(sourceRange.start_char, sourceRange.end_char);
	const anchored = lexicalSnippet(query, source);
	return {
		matchedView: view.view_id,
		matchedSourceRange: sourceRange,
		matchedSnippet: anchored ?? view.disclosure.snippet ?? null,
		snippetAnchor: anchored ? "lexical_overlap" : view.disclosure.snippet ? "view_fallback" : null,
	};
}

function weightAndRerank(
	scored: ScoredFragment[],
	topK: number,
	baseGenerationId: string | null,
	deltaId: string | null,
	identity: RetrievalIdentity,
	query: string,
	poolMultiplier = 3,
): SearchResultItem[] {
	scored.sort((a, b) => b.rawSimilarity - a.rawSimilarity || a.id.localeCompare(b.id));
	const pool = scored.slice(0, topK * poolMultiplier);
	const weighted = pool.map((s) => {
		const meta = readMeta(s.id);
		const weight = decayFloor(effectiveImportance(meta));
		return { ...s, weight, final: s.rawSimilarity * weight };
	});
	weighted.sort((a, b) => b.final - a.final || b.rawSimilarity - a.rawSimilarity || a.id.localeCompare(b.id));
	const results: SearchResultItem[] = [];
	for (const w of weighted.slice(0, topK)) {
		const item = buildResultItem(w, baseGenerationId, deltaId, identity, query);
		if (item) results.push(item);
	}
	return results;
}

function aggregateMultiview(
	multiview: Map<string, LoadedMultiview>,
	queryVec: number[],
	topK: number,
	baseGenerationId: string | null,
	deltaId: string | null,
	identity: RetrievalIdentity,
	query: string,
): SearchResultItem[] {
	const scored: ScoredFragment[] = [];
	for (const [fragmentId, entry] of multiview) {
		let summary: { score: number; view: EffectiveMultiviewView } | null = null;
		let evidence: { score: number; view: EffectiveMultiviewView } | null = null;
		for (const view of entry.views) {
			const candidate = { score: cosine(queryVec, view.vector), view };
			if (view.kind === "summary") summary = chooseBestView(summary, candidate);
			else evidence = chooseBestView(evidence, candidate);
		}
		const policy = identity.evidencePolicy;
		const evidenceAllowed = Boolean(policy?.status === "validated" && policy.raw_similarity_mode === "fragment-max-view-v1");
		const evidencePassed = Boolean(evidenceAllowed && evidence && evidence.score >= policy!.evidence_threshold);
		const winner = evidencePassed && evidence && (!summary || evidence.score >= summary.score) ? evidence : summary;
		if (!winner || winner.score <= 0) continue;
		scored.push({
			id: fragmentId,
			rawSimilarity: winner.score,
			layer: entry.layer,
			matchedView: winner.view,
			rawSimilarityMode: evidencePassed ? "fragment-max-view-v1" : "fragment-summary-only-shadow-v1",
		});
	}
	return weightAndRerank(scored, topK, baseGenerationId, deltaId, identity, query, MULTIVIEW_CANDIDATE_POOL_MULTIPLIER);
}

/** 回退模式搜索：Jaccard 相似度 + 第一期权重重排 */
function fallbackSearch(query: string, topK: number, agentId?: string): SearchResultItem[] {
	const ids = listAllFragmentIds();
	const scored: ScoredFragment[] = [];
	for (const fragId of ids) {
		const frag = getFragment(fragId);
		if (!frag) continue;
		if (agentId && frag.agent_id !== agentId) continue;
		const text = frag.task_desc + " " + frag.result_desc + " " + frag.turns_text.slice(0, 2000);
		const score = jaccardSimilarity(query, text);
		if (score > 0) scored.push({ id: fragId, rawSimilarity: score, layer: "base", rawSimilarityMode: "fragment-fallback-jaccard-v1" });
	}
	return weightAndRerank(scored, topK, null, null, { generationId: null, representationIdentityHash: null, retrievalEpoch: null, evidencePolicyId: null, evidencePolicy: null }, query);
}

/** 构建单个结果条目（含层级回溯 + 三分数透出） */
function buildResultItem(
	scored: ScoredFragment & { weight: number },
	baseGenerationId: string | null,
	deltaId: string | null,
	identity: RetrievalIdentity,
	query: string,
): SearchResultItem | null {
	const frag = getFragment(scored.id);
	if (!frag) return null;
	const daily = getDailySummaryMeta(frag.date);
	const topic = frag.topic_name ? getTopic(frag.topic_name) : null;
	let topicSummary: string | null = null;
	if (topic) topicSummary = topic.entries.map((e) => `${e.date}：${e.summary}`).join("；");
	const disclosure = viewDisclosure(query, frag, scored.matchedView);
	const round4 = (n: number) => Math.round(n * 10000) / 10000;
	return {
		fragment_id: frag.fragment_id,
		score: round4(scored.rawSimilarity * scored.weight),
		raw_similarity: round4(scored.rawSimilarity),
		weight: round4(scored.weight),
		task_desc: frag.task_desc,
		result_desc: frag.result_desc,
		tags: frag.tags,
		date: frag.date,
		turns_range: `${frag.start_turn_id} ~ ${frag.end_turn_id}`,
		agent_id: frag.agent_id,
		embedding_layer: scored.layer,
		base_generation_id: baseGenerationId,
		delta_id: scored.layer === "delta" ? deltaId : null,
		matched_view: disclosure.matchedView,
		matched_source_range: disclosure.matchedSourceRange,
		matched_snippet: disclosure.matchedSnippet,
		snippet_anchor: disclosure.snippetAnchor,
		generation_id: identity.generationId,
		representation_identity_hash: identity.representationIdentityHash,
		retrieval_epoch: identity.retrievalEpoch,
		raw_similarity_mode: scored.rawSimilarityMode,
		evidence_policy_id: identity.evidencePolicyId,
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
	if (isFallbackMode()) return { query, results: fallbackSearch(query, topK, filterAgentId) };
	const active = getActiveGeneration();
	const identity: RetrievalIdentity = {
		generationId: active?.generation_id ?? null,
		representationIdentityHash: active?.representation_identity_hash ?? null,
		retrievalEpoch: active?.retrieval_epoch ?? null,
		evidencePolicyId: active?.evidence_policy_id ?? null,
		evidencePolicy: active?.evidence_policy ?? null,
	};
	const builtQuery = await buildQueryInput(query, active ?? undefined);
	const queryVec = await encode(builtQuery.text);
	if (queryVec.length === 0) return { query, results: fallbackSearch(query, topK, filterAgentId) };
	const allEmbeddings = await loadAllEmbeddings();
	if (active && isMultiviewGeneration(active)) {
		const filtered = new Map([...allEmbeddings.multiview].filter(([fragId]) => {
			if (!filterAgentId) return true;
			const frag = getFragment(fragId);
			return Boolean(frag && frag.agent_id === filterAgentId);
		}));
		return {
			query,
			results: aggregateMultiview(filtered, queryVec, topK, allEmbeddings.baseGenerationId, allEmbeddings.deltaId, identity, query),
			health: allEmbeddings.health,
		};
	}
	const scored: ScoredFragment[] = [];
	for (const [fragId, entry] of allEmbeddings.vectors) {
		if (filterAgentId) {
			const frag = getFragment(fragId);
			if (!frag || frag.agent_id !== filterAgentId) continue;
		}
		const sim = cosine(queryVec, entry.vector);
		if (sim > 0) scored.push({ id: fragId, rawSimilarity: sim, layer: entry.layer, rawSimilarityMode: "fragment-single-vector-v1" });
	}
	return {
		query,
		results: weightAndRerank(scored, topK, allEmbeddings.baseGenerationId, allEmbeddings.deltaId, identity, query),
		health: allEmbeddings.health,
	};
}
