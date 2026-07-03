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
} from "../types.js";
import { appendTurn, readTurns, listDates as listRawDates } from "../storage/raw.js";
import { createFragment, getFragment, getFragmentRaw, listAllFragmentIds } from "../storage/fragments.js";
import { createDailySummary, getDailySummary } from "../storage/daily.js";
import { upsertTopic, getTopic, getTopicRaw, listTopics } from "../storage/topics.js";
import { search } from "../search/retriever.js";
import { encode, isFallbackMode } from "../embedding/provider.js";
import { embeddingPath } from "../storage/fragments.js";
import * as fs from "node:fs";

export async function handleStoreTurn(input: StoreTurnInput) {
	const record = appendTurn(input.date, input.role, input.content, input.agent_id);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }],
	};
}

export async function handleCreateFragment(input: CreateFragmentInput) {
	const { fragment_id, meta } = createFragment({ ...input, agent_id: input.agent_id });

	// 生成 embedding —— 编码任务描述+结论+原文，查询多针对结论，纳入后召回更准
	const embedText = `${meta.task_desc}\n${meta.result_desc}\n${meta.turns_text}`;
	const embedding = await encode(embedText);
	const ep = embeddingPath(input.date, fragment_id.split("/")[1]);
	if (embedding.length === 0) {
		// 降级模式：不写空向量伪装成功，留空文件缺失让回填/搜索走 Jaccard 并可被察觉
		console.error(`[embedding] ⚠ 片段 ${fragment_id} 未生成向量（降级模式），跳过 .embedding 落盘。`);
	} else {
		fs.writeFileSync(ep, JSON.stringify(embedding), "utf-8");
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
						embedding_dim: embedding.length,
						embedding_mode: isFallbackMode() ? "fallback" : "transformers",
					},
					null,
					2,
				),
			},
		],
	};
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
};
