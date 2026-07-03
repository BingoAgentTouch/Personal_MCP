// ============================================================
// 层级 0：原始对话轮次
// ============================================================

export interface TurnRecord {
	turn_id: string; // "turn_0047"
	role: "user" | "assistant";
	content: string;
	timestamp: string; // ISO 8601
	agent_id?: string; // 所属 agent，用于多 agent 隔离
}

// ============================================================
// 层级 1：任务-结果片段
// ============================================================

export interface FragmentMeta {
	fragment_id: string; // "2025-06-15/frag_003"
	date: string;
	start_turn_id: string;
	end_turn_id: string;
	task_desc: string;
	result_desc: string;
	tags: string[];
	topic_name: string;
	agent_id?: string;
	turns_text: string; // 从 raw 提取的完整原文
}

// fragment md 文件写入时只需要存这些字段
export interface FragmentInput {
	date: string;
	start_turn_id: string;
	end_turn_id: string;
	task_desc: string;
	result_desc: string;
	tags: string[];
	topic_name: string;
	agent_id?: string;
}

// ============================================================
// 层级 2：每日总结
// ============================================================

export interface DailySummaryMeta {
	date: string;
	topics: string[];
	summary_md: string;
}

// ============================================================
// 层级 3：多日主题索引
// ============================================================

export interface TopicEntry {
	date: string;
	fragment_id: string;
	summary: string;
}

export interface TopicIndexMeta {
	name: string;
	date_range: { start: string; end: string };
	status: "active" | "completed";
	entries: TopicEntry[];
	constraints: string[];
}

// ============================================================
// 检索结果
// ============================================================

export interface SearchResultItem {
	fragment_id: string;
	score: number;
	task_desc: string;
	result_desc: string;
	tags: string[];
	date: string;
	turns_range: string;
	agent_id?: string;
	hierarchy: {
		daily_summary: string | null;
		topic_name: string;
		topic_summary: string | null;
	};
}

export interface SearchResults {
	query: string;
	results: SearchResultItem[];
}

// ============================================================
// MCP Tool 输入类型
// ============================================================

export interface StoreTurnInput {
	date: string; // "2025-06-15"
	role: "user" | "assistant";
	content: string;
	agent_id?: string;
}

export interface CreateFragmentInput {
	date: string;
	start_turn_id: string;
	end_turn_id: string;
	task_desc: string;
	result_desc: string;
	tags: string[];
	topic_name: string;
	agent_id?: string;
}

export interface CreateDailySummaryInput {
	date: string;
	summary_md: string;
}

export interface UpsertTopicInput {
	topic_name: string;
	date: string;
	fragment_id: string;
	summary_md: string;
}

export interface SearchInput {
	query: string;
	top_k?: number;
	agent_id?: string; // 按 agent 过滤
}

export interface GetFragmentInput {
	fragment_id: string; // "2025-06-15/frag_003"
}

export interface GetDailyInput {
	date: string;
}

export interface GetTopicInput {
	topic_name: string;
}
