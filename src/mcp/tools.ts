// ============================================================
// MCP Tool 定义（name / description / inputSchema）
// ============================================================

export const TOOLS = [
	{
		name: "memory_store_turn",
		description:
			"追加一轮对话到长期记忆。每次对话结束时调用，全量保留原文一字不改。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: {
					type: "string",
					description: "日期，格式 YYYY-MM-DD，如 2025-06-15",
				},
				role: {
					type: "string",
					enum: ["user", "assistant"],
					description: "角色",
				},
				content: {
					type: "string",
					description: "对话内容原文",
				},
				agent_id: {
					type: "string",
					description: "所属 agent ID（可选），用于多 agent 隔离",
				},
			},
			required: ["date", "role", "content"],
		},
	},
	{
		name: "memory_create_fragment",
		description:
			"创建一个任务-结果片段（层级 1）。将几轮讨论同一任务的对话打包为片段，自动计算 embedding。需要先调用 memory_store_turn 存储轮次。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: { type: "string", description: "日期 YYYY-MM-DD" },
				start_turn_id: { type: "string", description: "起始轮次 ID，如 turn_0001" },
				end_turn_id: { type: "string", description: "结束轮次 ID，如 turn_0005" },
				task_desc: { type: "string", description: "一句话描述：这次在做什么" },
				result_desc: { type: "string", description: "一句话描述：得出了什么结论" },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "标签列表，如 ['godot', 'particles']",
				},
				topic_name: { type: "string", description: "所属主题名称，如 '粒子系统'" },
				agent_id: { type: "string", description: "所属 agent ID（可选）" },
			},
			required: ["date", "start_turn_id", "end_turn_id", "task_desc", "result_desc", "tags", "topic_name"],
		},
	},
	{
		name: "memory_create_daily_summary",
		description:
			"创建每日总结（层级 2）。将当天所有片段汇总为总摘要，由 LLM 生成后写入。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: { type: "string", description: "日期 YYYY-MM-DD" },
				summary_md: {
					type: "string",
					description: "每日总结的完整 Markdown 内容",
				},
			},
			required: ["date", "summary_md"],
		},
	},
	{
		name: "memory_upsert_topic",
		description:
			"创建或更新多日主题索引（层级 3）。将同一主题跨天的片段合并为高级索引，追加新日期/阶段信息。",
		inputSchema: {
			type: "object" as const,
			properties: {
				topic_name: { type: "string", description: "主题名称" },
				date: { type: "string", description: "本次关联的日期 YYYY-MM-DD" },
				fragment_id: {
					type: "string",
					description: "本次关联的片段 ID，如 '2025-06-15/frag_003'",
				},
				summary_md: {
					type: "string",
					description: "本次阶段的简要描述，如 '粒子系统选型 → 决定用 GPUParticles2D'",
				},
			},
			required: ["topic_name", "date", "fragment_id", "summary_md"],
		},
	},
	{
		name: "memory_search",
		description:
			"语义检索长期记忆。对用户问题做 embedding 搜索，命中层级 1 的片段后回溯层级 2（每日总结）和层级 3（主题索引），返回带完整上下文的结果。",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "用户的问题或搜索关键词" },
				top_k: {
					type: "number",
					description: "返回前几条结果，默认 10",
				},
				agent_id: {
					type: "string",
					description: "按 agent 过滤（可选），不传则搜索全部",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "memory_get_fragment",
		description: "根据片段 ID 读取完整片段内容（含原文）。",
		inputSchema: {
			type: "object" as const,
			properties: {
				fragment_id: {
					type: "string",
					description: "片段 ID，如 '2025-06-15/frag_003'",
				},
			},
			required: ["fragment_id"],
		},
	},
	{
		name: "memory_get_daily",
		description: "读取指定日期的每日总结。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: { type: "string", description: "日期 YYYY-MM-DD" },
			},
			required: ["date"],
		},
	},
	{
		name: "memory_get_topic",
		description: "读取指定主题的多日索引，含各阶段摘要和关联片段 ID。",
		inputSchema: {
			type: "object" as const,
			properties: {
				topic_name: { type: "string", description: "主题名称" },
			},
			required: ["topic_name"],
		},
	},
	{
		name: "memory_list_dates",
		description: "列出所有有记录的日期。",
		inputSchema: {
			type: "object" as const,
			properties: {},
		},
	},
];
