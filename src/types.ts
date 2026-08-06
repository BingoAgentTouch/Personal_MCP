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
	importance?: number; // 先天重要性 0.0~1.0，缺省 0.5；新片段按保守分档评分，普通记忆不要默认 0.7+
}

// ============================================================
// 权重元数据（frag_NNN.meta.json）
// 结构一次定义到位：SM-2 字段（ease/interval/repetition/last_hit_at）
// 是第二期占位，第一期只读写 importance。
// ============================================================

export interface FragmentWeightMeta {
	importance: number; // 先天重要性 0.0~1.0
	ease: number; // SM-2 easiness factor，第二期用
	interval: number; // SM-2 复习间隔（天），第二期用
	repetition: number; // SM-2 命中次数，第二期用
	last_hit_at: string | null; // 上次命中时间 ISO，第二期用
	earned_importance?: number; // P3 提取花费累积值，0.0~1.0
	earned_event_count?: number; // P3 已应用事件数
	earned_last_updated_at?: string | null; // P3 最近应用时间
	earned_policy_version?: string | null; // P3 最近应用 policy
}

// ============================================================
// Embedding representation generations
// ============================================================

export type EmbeddingGenerationState = "building" | "ready" | "active" | "failed";

export interface EmbeddingGenerationManifest {
	manifest_schema_version: number;
	generation_id: string;
	state: EmbeddingGenerationState;
	document_recipe_id: string;
	document_recipe_version: number;
	query_recipe_id: string;
	query_recipe_version: number;
	embedding_model_id: string;
	embedding_model_revision: string | null;
	tokenizer_id: string;
	tokenizer_revision: string | null;
	runtime_identity: string;
	pooling: "mean";
	normalize: boolean;
	quantized: boolean;
	dimension: number;
	model_max_length: number;
	special_token_reserve: number;
	source_schema_version: number;
	source_inventory_hash: string;
	representation_identity_hash: string;
	manifest_content_hash: string;
	expected_count: number;
	materialized_count: number;
	failed_count: number;
	searchable_coverage: number;
}

export interface ActiveEmbeddingPointer {
	pointer_schema_version: number;
	active_generation_id: string;
	active_manifest_hash: string;
	previous_generation_id: string | null;
}

export interface EmbeddingGenerationRecord {
	fragment_id: string;
	generation_id: string;
	source_content_hash: string;
	input_hash: string;
	vector_hash: string;
	dimension: number;
	tokens: Record<string, unknown>;
	state: "materialized" | "failed";
}

export type EmbeddingDeltaState = "active" | "sealed" | "merged" | "failed";
export type EmbeddingDeltaRecordState =
	| "pending"
	| "materialized"
	| "tombstone"
	| "source_missing"
	| "encode_failed"
	| "vector_corrupt"
	| "dimension_mismatch"
	| "hash_mismatch"
	| "generation_mismatch"
	| "stale";

export interface EmbeddingDeltaManifest {
	delta_schema_version: number;
	delta_id: string;
	state: EmbeddingDeltaState;
	base_generation_id: string;
	base_manifest_hash: string;
	representation_identity_hash: string;
	document_recipe_id: string;
	document_recipe_version: number;
	query_recipe_id: string;
	query_recipe_version: number;
	source_schema_version: number;
	sequence: number;
	record_count: number;
	materialized_count: number;
	failed_count: number;
	created_at: string;
	manifest_content_hash: string;
}

export interface EmbeddingDeltaRecord {
	record_schema_version: number;
	delta_id: string;
	fragment_id: string;
	state: EmbeddingDeltaRecordState;
	operation: "create" | "update" | "delete" | "reconcile";
	source_content_hash: string | null;
	constructed_input_hash: string | null;
	vector_hash: string | null;
	vector_dimension: number | null;
	representation_identity_hash: string;
	tokens: unknown;
	created_at: string;
	failure: string | null;
}

export type EmbeddingLayer = "base" | "delta";
export type EmbeddingHealthStatus = "healthy" | "healthy_with_delta" | "degraded" | "invalid";

export interface EmbeddingHealthSnapshot {
	active_generation_id: string | null;
	active_manifest_hash: string | null;
	representation_identity_hash: string | null;
	active_delta_id: string | null;
	delta_state: EmbeddingDeltaState | null;
	source_fragments: number;
	base_generation_fragments: number;
	delta_materialized_fragments: number;
	delta_tombstones: number;
	effective_vectors: number;
	missing_vectors: number;
	stale_vectors: number;
	corrupt_vectors: number;
	dimension_mismatches: number;
	source_hash_mismatches: number;
	identity_mismatches: number;
	base_coverage: number;
	effective_coverage: number;
	status: EmbeddingHealthStatus;
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
	score: number; // final_score = raw_similarity × weight（重排依据）
	raw_similarity: number; // 原始 cosine/jaccard 相似度
	weight: number; // combined_weight（第一期 = decay_floor），调试用
	task_desc: string;
	result_desc: string;
	tags: string[];
	date: string;
	turns_range: string;
	agent_id?: string;
	embedding_layer?: EmbeddingLayer;
	base_generation_id?: string | null;
	delta_id?: string | null;
	hierarchy: {
		daily_summary: string | null;
		topic_name: string;
		topic_summary: string | null;
	};
}

export interface SearchResults {
	query: string;
	results: SearchResultItem[];
	health?: EmbeddingHealthSnapshot;
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
	importance?: number; // 先天重要性 0.0~1.0，缺省 0.5；新片段按保守分档评分，普通记忆不要默认 0.7+
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
	// —— P3 观察埋点（Phase 0，只记录不影响读取）——
	confirmed_by?: "user" | "agent"; // 谁促成本次读原文：user=人工点头（金标准成功），agent=AI 自行判定
	query?: string; // 促成本次读取的检索词，助离线把 search→get_fragment 配对成 episode
	agent_id?: string; // 所属 agent，配对键之一（ts + agent_id + fragment_id + query）
}

export interface GetDailyInput {
	date: string;
}

export interface GetTopicInput {
	topic_name: string;
}

// ============================================================
// memory_consolidate_topics
// ============================================================

export interface ConsolidateTopicsInput {
	action: "detect" | "execute";
	threshold?: number; // Jaccard 阈值 [0, 1]，默认按中文 Topic 正负样本校准为 0.3
	merges?: MergePlan[];
	dry_run?: boolean; // execute 时仅校验并预览，不写入或删除文件
}

export interface MergePlan {
	target: string;       // 合并目标主题名
	sources: string[];    // 要合并到 target 的主题名列表
	skip?: boolean;       // 跳过此组
}

export interface TopicConsolidateResult {
	pairs?: SimilarTopicPair[];
	total_pairs?: number;
	threshold?: number;
	total_topics?: number;
	merged?: MergeResultItem[];
	skipped?: MergeResultItem[];
	errors?: MergeErrorItem[];
	dry_run?: boolean;
	validated?: boolean;
	changes?: TopicConsolidateChanges;
	committed?: boolean;
	transaction_path?: string;
	recovery_failed?: boolean;
}

export interface TopicConsolidateChanges {
	topics_to_update: string[];
	topics_to_remove: string[];
	fragments_to_update: string[];
	backups_to_create: number;
}

export interface SimilarTopicPair {
	similarity: number;
	name_score: number;
	summary_score: number;
	topic_a: TopicIndexMeta;
	topic_b: TopicIndexMeta;
}

export interface MergeResultItem {
	target: string;
	sources_merged: string[];
	new_entries_count: number;
	fragments_updated: number;
	status: string;
}

export interface MergeErrorItem {
	group_index: number;
	error: string;
}

/**
 * memory_get_raw_turns 的输入。
 *
 * 四种严格互斥的查询模式：
 * 1) 精确单轮：传 date + turn_id
 * 2) 范围查询：传 date + turn_start + turn_end
 * 3) 最近 N 轮：传 date + limit，limit 必须为正整数
 * 4) 全量查询：只传 date
 *
 * 所有模式均可附带 agent_id，先过滤指定 agent 再执行查询。
 */
export interface GetRawTurnsInput {
date: string;
turn_id?: string;
turn_start?: string;
turn_end?: string;
limit?: number;
agent_id?: string;
}
