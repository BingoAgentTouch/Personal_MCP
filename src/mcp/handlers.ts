// ============================================================
// MCP Tool 执行处理器
// 每个函数接收 input，返回结构化结果
// ============================================================

import type {
	StoreTurnInput,
	CreateFragmentInput,
	CreateDailySummaryInput,
	UpsertTopicInput,
	SearchInput,
	GetFragmentInput,
	GetDailyInput,
	GetTopicInput,
	GetRawTurnsInput,
	ConsolidateTopicsInput,
	MergePlan,
	MergeResultItem,
	MergeErrorItem,
	TopicConsolidateResult,
} from "../types.js";
import { appendTurn, readTurns, listDates as listRawDates } from "../storage/raw.js";
import {
	commitPreparedFragment,
	createFragment,
	getFragment,
	getFragmentRaw,
	listAllFragmentIds,
	metaPath,
	prepareFragment,
	rollbackPreparedFragment,
	writeMeta,
	DEFAULT_META,
} from "../storage/fragments.js";
import { createDailySummary, getDailySummary } from "../storage/daily.js";
import {
	upsertTopic,
	getTopic,
	getTopicRaw,
	listTopics,
	topicSimilarity,
	DEFAULT_TOPIC_THRESHOLD,
	planTopicConsolidationBatch,
	applyTopicConsolidationBatchTransactional,
} from "../storage/topics.js";
import { search } from "../search/retriever.js";
import { logSearch, logGetFragment } from "../storage/signals.js";
import { workMemory } from "../work_memory.js";
import { buildDocumentInput, buildDocumentViews, sourceContentHash } from "../embedding/builder.js";
import { encodeStrict, embeddingModeLabel } from "../embedding/provider.js";
import { getActiveGeneration } from "../embedding/generation.js";
import {
	assertDeltaWritable,
	assertWritesAllowed,
	createPendingDeltaRecord,
	ensureActiveDelta,
	upsertDeltaRecord,
	upsertDeltaViews,
} from "../embedding/delta.js";
import * as fs from "node:fs";
import * as path from "node:path";

export async function handleStoreTurn(input: StoreTurnInput) {
	const record = appendTurn(input.date, input.role, input.content, input.agent_id);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }],
	};
}

export async function handleCreateFragment(input: CreateFragmentInput) {
	const active = getActiveGeneration();
	if (!active) {
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{
							code: "ACTIVE_GENERATION_REQUIRED",
							message: "当前没有 active embedding generation；D1 已移除 legacy 裸向量写入路径，本次未创建 fragment。",
							recommended_action: "请先使用 migrate_embeddings.mjs build/validate/switch 创建并激活 generation，然后再写入 fragment。",
						},
						null,
						2,
					),
				},
			],
			isError: true,
		};
	}
	try {
		assertWritesAllowed();
		ensureActiveDelta();
		const delta = assertDeltaWritable();
		const importance = input.importance ?? DEFAULT_META.importance;
		const prepared = prepareFragment({ ...input, agent_id: input.agent_id, importance });
		const documentInput = {
			task_desc: prepared.meta.task_desc,
			result_desc: prepared.meta.result_desc,
			tags: prepared.meta.tags,
			topic_name: prepared.meta.topic_name,
			turns_text: prepared.meta.turns_text,
		};
		let embeddingDim = 0;
		let singleEmbedding: { vector: number[]; inputHash: string; tokens: unknown } | null = null;
		let multiviewPayload: Array<import("../embedding/delta.js").MaterializedDeltaView> | null = null;
		if (active.representation_kind === "multiview") {
			const builtViews = await buildDocumentViews(documentInput, active);
			const encoded = await Promise.all(builtViews.views.map(async (view) => ({ view, vector: await encodeStrict(view.text) })));
			embeddingDim = encoded[0]?.vector.length ?? 0;
			multiviewPayload = encoded.map(({ view, vector }) => ({ view_id: view.view_id, kind: view.kind, vector, input_hash: view.input_hash, tokens: view.tokens, source_spans: view.source_spans, disclosure: view.disclosure }));
		} else {
			const built = await buildDocumentInput(documentInput, active);
			const vector = await encodeStrict(built.text);
			embeddingDim = vector.length;
			singleEmbedding = { vector, inputHash: built.input_hash, tokens: built.tokens };
		}
		const sourceHash = sourceContentHash(documentInput);
		const { fragment_id, meta } = commitPreparedFragment(prepared);
		try {
			if (active.representation_kind === "multiview") {
				upsertDeltaViews(delta, fragment_id, sourceHash, multiviewPayload!, "create");
			} else {
				upsertDeltaRecord(delta, fragment_id, singleEmbedding!.vector, singleEmbedding!.inputHash, sourceHash, singleEmbedding!.tokens, "create");
			}
		} catch (error) {
			rollbackPreparedFragment(prepared);
			createPendingDeltaRecord(delta, fragment_id, error instanceof Error ? error.message : String(error));
			throw error;
		}
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{
							fragment_id,
							task_desc: meta.task_desc,
							result_desc: meta.result_desc,
							turns_length: meta.turns_text.length,
							embedding_dim: embeddingDim,
							embedding_mode: embeddingModeLabel(),
							embedding_status: "ready",
							embedding_layer: "delta",
							embedding_generation: active.generation_id,
							embedding_delta_id: delta.delta_id,
						},
						null,
						2,
					),
				},
			],
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = message === "compacting" ? "COMPACTION_IN_PROGRESS" : "DELTA_WRITE_FAILED";
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ code, message }, null, 2) }],
			isError: true,
		};
	}
}

async function syncFragmentToDelta(fragmentId: string, operation: "create" | "update" | "reconcile" = "update"): Promise<void> {
	const active = getActiveGeneration();
	if (!active) return;
	assertWritesAllowed();
	ensureActiveDelta();
	const delta = assertDeltaWritable();
	const fragment = getFragment(fragmentId);
	if (!fragment) {
		createPendingDeltaRecord(delta, fragmentId, "fragment_missing_after_update");
		return;
	}
	const documentInput = {
		task_desc: fragment.task_desc,
		result_desc: fragment.result_desc,
		tags: fragment.tags,
		topic_name: fragment.topic_name,
		turns_text: fragment.turns_text,
	};
	const sourceHash = sourceContentHash(documentInput);
	if (active.representation_kind === "multiview") {
		const builtViews = await buildDocumentViews(documentInput, active);
		const encodedViews = await Promise.all(builtViews.views.map(async (view) => ({ view, vector: await encodeStrict(view.text) })));
		upsertDeltaViews(delta, fragmentId, sourceHash, encodedViews.map(({ view, vector }) => ({ view_id: view.view_id, kind: view.kind, vector, input_hash: view.input_hash, tokens: view.tokens, source_spans: view.source_spans, disclosure: view.disclosure })), operation);
	} else {
		const built = await buildDocumentInput(documentInput, active);
		const vector = await encodeStrict(built.text);
		upsertDeltaRecord(delta, fragmentId, vector, built.input_hash, sourceHash, built.tokens, operation);
	}
}

export async function handleCreateDailySummary(input: CreateDailySummaryInput) {
	createDailySummary(input.date, input.summary_md);
	return {
		content: [
			{
				type: "text" as const,
				text: `每日总结已写入：daily/${input.date}.md`,
			},
		],
	};
}

export async function handleUpsertTopic(input: UpsertTopicInput) {
	const meta = upsertTopic(input.topic_name, input.date, input.fragment_id, input.summary_md);
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(meta, null, 2),
			},
		],
	};
}

export async function handleSearch(input: SearchInput) {
	const results = await search(input.query, input.top_k ?? 10, input.agent_id);
	// P3 埋点：纯观察，记录本次检索 surface 出的片段名次/相似度/权重，不影响排名
	logSearch(results, input.agent_id);
	// 热工作记忆：search 触发主体条目替换（best-effort，不阻断检索）
	workMemory.refresh(input.query, results);
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(results, null, 2),
			},
		],
	};
}

export async function handleGetFragment(input: GetFragmentInput) {
	const md = getFragmentRaw(input.fragment_id);
	if (!md) {
		return {
			content: [{ type: "text" as const, text: `片段不存在：${input.fragment_id}` }],
			isError: true,
		};
	}
	// 遇到缺失权重 meta 的老片段，顺手补写默认（不阻塞本次返回）
	const [date, id] = input.fragment_id.split("/");
	if (date && id && !fs.existsSync(metaPath(date, id))) {
		try {
			writeMeta(date, id, { ...DEFAULT_META });
		} catch {
			// 补写失败不影响本次读取
		}
	}
	// P3 埋点：纯观察，记录本次读原文的成功信号（confirmed_by）与促成检索词，不影响返回
	logGetFragment(input.fragment_id, input.confirmed_by, input.query, input.agent_id);
	return {
		content: [{ type: "text" as const, text: md }],
	};
}

export async function handleGetDaily(input: GetDailyInput) {
	const md = getDailySummary(input.date);
	if (!md) {
		return {
			content: [{ type: "text" as const, text: `该日期没有每日总结：${input.date}` }],
			isError: true,
		};
	}
	return {
		content: [{ type: "text" as const, text: md }],
	};
}

export async function handleGetTopic(input: GetTopicInput) {
	const md = getTopicRaw(input.topic_name);
	if (!md) {
		return {
			content: [
				{
					type: "text" as const,
					text: `主题不存在：${input.topic_name}。可用主题：${listTopics().join(", ") || "无"}`,
				},
			],
			isError: true,
		};
	}
	return {
		content: [{ type: "text" as const, text: md }],
	};
}

export async function handleListDates() {
	const rawDates = listRawDates();
	const dailyDates = (await import("../storage/daily.js")).listDates();
	const allDates = [...new Set([...rawDates, ...dailyDates])].sort();
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						dates: allDates,
						count: allDates.length,
						has_raw: rawDates.length,
						has_daily: dailyDates.length,
					},
					null,
					2,
				),
			},
		],
	};
}

type RawTurnsQuery =
	| { mode: "all" }
	| { mode: "exact"; turn_id: string }
	| { mode: "range"; turn_start: string; turn_end: string }
	| { mode: "recent"; limit: number };

function resolveRawTurnsQuery(input: GetRawTurnsInput): { query: RawTurnsQuery } | { error: string } {
	const hasTurnId = input.turn_id !== undefined;
	const hasTurnStart = input.turn_start !== undefined;
	const hasTurnEnd = input.turn_end !== undefined;
	const hasLimit = input.limit !== undefined;

	if (hasLimit && (typeof input.limit !== "number" || !Number.isFinite(input.limit) || !Number.isInteger(input.limit) || input.limit < 1)) {
		return { error: "参数 limit 必须是大于等于 1 的有限正整数" };
	}
	if (hasTurnStart !== hasTurnEnd) {
		return { error: "参数 turn_start 与 turn_end 必须同时提供" };
	}
	if (hasTurnId && (hasTurnStart || hasTurnEnd)) {
		return { error: "参数 turn_id 不能与范围参数同时提供" };
	}
	if (hasTurnId && hasLimit) {
		return { error: "参数 turn_id 不能与 limit 同时提供" };
	}
	if ((hasTurnStart || hasTurnEnd) && hasLimit) {
		return { error: "范围参数不能与 limit 同时提供" };
	}

	if (hasTurnId) return { query: { mode: "exact", turn_id: input.turn_id! } };
	if (hasTurnStart && hasTurnEnd) {
		return { query: { mode: "range", turn_start: input.turn_start!, turn_end: input.turn_end! } };
	}
	if (hasLimit) return { query: { mode: "recent", limit: input.limit! } };
	return { query: { mode: "all" } };
}

function formatRawTurnTranscript(turns: Array<{
	turn_id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	agent_id?: string;
}>) {
	const roleLabels = { user: "用户", assistant: "AI" } as const;
	return turns
		.map((turn) => {
			const agentLine = turn.agent_id !== undefined ? `\nAgent：${turn.agent_id}` : "";
			return [
				`## ${turn.turn_id} · ${roleLabels[turn.role]}`,
				`时间：${turn.timestamp}${agentLine}`,
				"",
				turn.content,
			].join("\n");
		})
		.join("\n\n---\n\n");
}

export async function handleGetRawTurns(input: GetRawTurnsInput) {
	const { date, agent_id } = input;
	const resolved = resolveRawTurnsQuery(input);
	if ("error" in resolved) {
		return {
			content: [{ type: "text" as const, text: resolved.error }],
			isError: true,
		};
	}

	const allTurns = readTurns(date);
	if (!allTurns.length) {
		return {
			content: [{ type: "text" as const, text: `该日期没有对话记录：${date}` }],
			isError: true,
		};
	}

	let turns = agent_id === undefined ? allTurns : allTurns.filter((turn) => turn.agent_id === agent_id);
	if (!turns.length && agent_id !== undefined) {
		return {
			content: [{ type: "text" as const, text: `该日期没有 agent 对应的对话记录：${date} / ${agent_id}` }],
			isError: true,
		};
	}

	const query = resolved.query;
	if (query.mode === "exact") {
		const found = turns.find((t) => t.turn_id === query.turn_id);
		if (!found) {
			return {
				content: [{ type: "text" as const, text: `轮次不存在：${query.turn_id}` }],
				isError: true,
			};
		}
		turns = [found];
	} else if (query.mode === "range") {
		const startIdx = turns.findIndex((t) => t.turn_id === query.turn_start);
		const endIdx = turns.findIndex((t) => t.turn_id === query.turn_end);
		if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
			return {
				content: [{ type: "text" as const, text: `轮次范围无效：${query.turn_start} ~ ${query.turn_end}` }],
				isError: true,
			};
		}
		turns = turns.slice(startIdx, endIdx + 1);
	} else if (query.mode === "recent") {
		turns = turns.slice(-query.limit);
	}

	return {
		content: [
			{
				type: "text" as const,
				text: `# 原始对话轮次（${date}）\n\n${formatRawTurnTranscript(turns)}`,
			},
		],
	};
}

// ============================================================
// memory_consolidate_topics
// ============================================================

const FRAGMENTS_BASE = path.resolve("memory/fragments");

export async function handleConsolidateTopics(input: ConsolidateTopicsInput) {
	const threshold = input.threshold ?? DEFAULT_TOPIC_THRESHOLD;
	if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
		return {
			content: [{ type: "text" as const, text: "参数 threshold 必须是 [0, 1] 范围内的有限数字" }],
			isError: true,
		};
	}
	const result: TopicConsolidateResult = {};

	if (input.action === "detect") {
		const topicNames = listTopics();
		result.total_topics = topicNames.length;
		result.threshold = threshold;

		const pairs: TopicConsolidateResult["pairs"] = [];
		const topics = topicNames
			.map((name) => getTopic(name))
			.filter((meta): meta is NonNullable<typeof meta> => meta !== null);

		for (let i = 0; i < topics.length; i++) {
			for (let j = i + 1; j < topics.length; j++) {
				const score = topicSimilarity(topics[i], topics[j]);
				if (score.similarity >= threshold) {
					pairs.push({
						similarity: Math.round(score.similarity * 10000) / 10000,
						name_score: Math.round(score.name_score * 10000) / 10000,
						summary_score: Math.round(score.summary_score * 10000) / 10000,
						topic_a: topics[i],
						topic_b: topics[j],
					});
				}
			}
		}

		pairs.sort((a, b) => b.similarity - a.similarity);
		result.pairs = pairs;
		result.total_pairs = pairs.length;
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
		};
	}

	if (input.action === "execute") {
		const merges: MergePlan[] = input.merges ?? [];
		const dryRun = input.dry_run ?? false;
		if (!dryRun) {
			try {
				assertWritesAllowed();
			} catch {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ code: "COMPACTION_IN_PROGRESS", message: "compacting" }, null, 2) }],
					isError: true,
				};
			}
		}
		const plan = planTopicConsolidationBatch(merges, FRAGMENTS_BASE);
		const plannedByGroup = new Map(plan.groups.map((group) => [group.group_index, group]));
		const merged: MergeResultItem[] = [];
		const skipped: MergeResultItem[] = [];

		for (let i = 0; i < merges.length; i++) {
			const merge = merges[i];
			if (merge.skip) {
				skipped.push({
					target: merge.target,
					sources_merged: merge.sources,
					new_entries_count: 0,
					fragments_updated: 0,
					status: "skipped",
				});
				continue;
			}
			const planned = plannedByGroup.get(i);
			merged.push({
				target: merge.target,
				sources_merged: merge.sources,
				new_entries_count: planned?.new_entries_count ?? 0,
				fragments_updated: planned?.fragments_updated ?? 0,
				status: plan.validated ? "ok" : "error",
			});
		}

		result.merged = merged;
		result.skipped = skipped;
		result.errors = plan.errors;
		result.dry_run = dryRun;
		result.validated = plan.validated;
		result.changes = plan.changes;

		if (plan.validated && !dryRun) {
			const commit = applyTopicConsolidationBatchTransactional(plan);
			result.committed = !commit.error;
			if (commit.transaction_path) result.transaction_path = commit.transaction_path;
			if (commit.recovery_failed) result.recovery_failed = true;
			if (commit.error) {
				result.errors = [{ group_index: -1, error: commit.error }];
				for (const item of merged) item.status = "error";
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
					isError: true,
				};
			}
			try {
				for (const group of plan.groups) {
					for (const update of group.fragment_updates) {
						await syncFragmentToDelta(update.fragment_id, "update");
					}
				}
			} catch (error) {
				result.errors = [{ group_index: -1, error: error instanceof Error ? error.message : String(error) }];
				for (const item of merged) item.status = "error";
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
					isError: true,
				};
			}
		}

		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			...(plan.validated ? {} : { isError: true }),
		};
	}

	return {
		content: [{ type: "text" as const, text: `未知 action：${(input as any).action}` }],
		isError: true,
	};
}

/** 路由表 */
export const handlerMap: Record<string, (input: any) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>> = {
	memory_store_turn: handleStoreTurn,
	memory_create_fragment: handleCreateFragment,
	memory_create_daily_summary: handleCreateDailySummary,
	memory_upsert_topic: handleUpsertTopic,
	memory_search: handleSearch,
	memory_get_fragment: handleGetFragment,
	memory_get_daily: handleGetDaily,
	memory_get_topic: handleGetTopic,
	memory_list_dates: handleListDates,
	memory_get_raw_turns: handleGetRawTurns,
	memory_consolidate_topics: handleConsolidateTopics,
};
