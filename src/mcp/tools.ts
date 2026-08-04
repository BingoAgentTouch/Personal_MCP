// ============================================================
// MCP 工具定义（name / description / inputSchema）
// ============================================================

export const TOOLS = [
	{
		name: "memory_store_turn",
		description:
			"追加一轮对话到长期记忆。每次对话结束时调用，全量保留原文一字不改。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: { type: "string", description: "日期，格式 YYYY-MM-DD，如 2025-06-15" },
				role: { type: "string", enum: ["user", "assistant"], description: "角色" },
				content: { type: "string", description: "对话内容原文" },
				agent_id: { type: "string", description: "所属 agent ID（可选），用于多 agent 隔离" },
			},
			required: ["date", "role", "content"],
		},
	},
	{
		name: "memory_create_fragment",
		description:
			"创建一个任务-结果片段（层级 1）。将几轮讨论同一任务的对话打包为片段并自动计算 embedding；需要先调用 memory_store_turn 存储轮次。当前简化模型：必须已有 active embedding generation；工具会把新片段写入当前 delta，并立即参与检索。若 compaction 进行中、delta 已 sealed、或没有 active generation，则拒绝创建且不写入 fragment/meta/向量。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: { type: "string", description: "日期 YYYY-MM-DD" },
				start_turn_id: { type: "string", description: "起始轮次 ID，如 turn_0001" },
				end_turn_id: { type: "string", description: "结束轮次 ID，如 turn_0005" },
				task_desc: { type: "string", description: "一句话描述：这次在做什么" },
				result_desc: { type: "string", description: "一句话描述：得出了什么结论" },
				tags: { type: "array", items: { type: "string" }, description: "标签列表，如 ['godot', 'particles']" },
				topic_name: { type: "string", description: "所属主题名称，如 '粒子系统'" },
				agent_id: { type: "string", description: "所属 agent ID（可选）" },
				importance: {
					type: "number",
					minimum: 0,
					maximum: 1,
					description: "先天重要性 0.0~1.0（可选，缺省 0.5）。检索时重要的记忆在相似度接近时上浮。锚点：架构决策≈0.9，功能实现≈0.7，工具配置≈0.5，临时排查≈0.35，闲聊≈0.15",
				},
			},
			required: ["date", "start_turn_id", "end_turn_id", "task_desc", "result_desc", "tags", "topic_name"],
		},
	},
	{
		name: "memory_create_daily_summary",
		description: "创建每日总结（层级 2）。将当天所有片段汇总为总摘要，由 LLM 生成后写入。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: { type: "string", description: "日期 YYYY-MM-DD" },
				summary_md: { type: "string", description: "每日总结的完整 Markdown 内容" },
			},
			required: ["date", "summary_md"],
		},
	},
	{
		name: "memory_upsert_topic",
		description: "创建或更新多日主题索引（层级 3）。将同一主题跨天的片段合并为高级索引，追加新日期/阶段信息。",
		inputSchema: {
			type: "object" as const,
			properties: {
				topic_name: { type: "string", description: "主题名称" },
				date: { type: "string", description: "本次关联的日期 YYYY-MM-DD" },
				fragment_id: { type: "string", description: "本次关联的片段 ID，如 '2025-06-15/frag_003'" },
				summary_md: { type: "string", description: "本次阶段的简要描述，如 '粒子系统选型 → 决定用 GPUParticles2D'" },
			},
			required: ["topic_name", "date", "fragment_id", "summary_md"],
		},
	},
	{
		name: "memory_search",
		description:
			"语义检索长期记忆。对用户问题做 embedding 搜索，命中层级 1 的片段后回溯层级 2（每日总结）和层级 3（主题索引），返回带完整上下文的结果。\n\n" +
			"检索工作流（ReAct + 人工闸门）：先看返回的一批摘要，用人话把你的语义判断念出来（哪条像、哪条不像、为什么），别把相似度分数摊给用户。如果这批都不对，换个检索词再搜一次——每次 reformulate 都是有意义的成本信号，不要憋着一次问完。当你锁定某一条、但拿不准时，先问用户「要不要我读一遍这条的原文？」，得到肯定答复后再用 confirmed_by=user 调 memory_get_fragment。\n" +
			"护栏：rank-1 明显碾压、一击命中时，直接用，别表演整套循环也别烦用户。把「念推理 + 问用户」只留给真绕、真拿不准的回忆。",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "用户的问题或搜索关键词" },
				top_k: { type: "number", description: "返回前几条结果，默认 10" },
				agent_id: { type: "string", description: "按 agent 过滤（可选），不传则搜索全部" },
			},
			required: ["query"],
		},
	},
	{
		name: "memory_get_fragment",
		description:
			"根据片段 ID 读取完整片段内容（含原文）。通常在 memory_search 已给出足够摘要后仍需看逐字原文时才调用。读取前若经过「拿不准 → 问用户 → 用户点头」的确认，请传 confirmed_by='user'（这是人工判定「对题、采用」的金标准成功信号）；若是 AI 自行判定要读、没经人工确认，传 confirmed_by='agent'。并把促成本次读取的检索词填进 query，便于把检索→读取重建成一次回忆 episode。",
		inputSchema: {
			type: "object" as const,
			properties: {
				fragment_id: { type: "string", description: "片段 ID，如 '2025-06-15/frag_003'" },
				confirmed_by: { type: "string", enum: ["user", "agent"], description: "谁促成本次读原文（可选）：'user'=经用户点头确认采用（金标准成功信号）；'agent'=AI 自行判定要读，未经人工确认" },
				query: { type: "string", description: "促成本次读取的检索词（可选），助离线把检索→读取重建成回忆 episode" },
				agent_id: { type: "string", description: "所属 agent ID（可选），埋点配对键之一" },
			},
			required: ["fragment_id"],
		},
	},
	{
		name: "memory_get_daily",
		description: "读取指定日期的每日总结。",
		inputSchema: {
			type: "object" as const,
			properties: { date: { type: "string", description: "日期 YYYY-MM-DD" } },
			required: ["date"],
		},
	},
	{
		name: "memory_get_topic",
		description: "读取指定主题的多日索引，含各阶段摘要和关联片段 ID。",
		inputSchema: {
			type: "object" as const,
			properties: { topic_name: { type: "string", description: "主题名称" } },
			required: ["topic_name"],
		},
	},
	{
		name: "memory_list_dates",
		description: "列出所有有记录的日期。",
		inputSchema: { type: "object" as const, properties: {} },
	},
	{
		name: "memory_get_raw_turns",
		description:
			"读取原始对话轮次（层级 0）。查询模式严格互斥：" +
			"① 精确单轮：传 date + turn_id；" +
			"② 范围查询：传 date + turn_start + turn_end；" +
			"③ 最近 N 轮：传 date + limit，limit 必须为正整数；" +
			"④ 全量查询：只传 date。以上模式均可附带可选 agent_id 过滤；指定模式失败时直接返回错误，不会降级到其他模式。" +
			"返回逐轮 transcript 原文，通常只在拿不准 fragment 总结是否准确、需要回去看逐字原文时使用。",
		inputSchema: {
			type: "object" as const,
			properties: {
				date: { type: "string", description: "日期 YYYY-MM-DD" },
				turn_id: { type: "string", description: "模式1：精确读取某一轮，如 'turn_0007'" },
				turn_start: { type: "string", description: "模式2：起始轮次，如 'turn_0005'" },
				turn_end: { type: "string", description: "模式2：结束轮次，如 'turn_0010'" },
				limit: { type: "integer", minimum: 1, description: "模式3：返回最近 N 轮，必须为正整数" },
				agent_id: { type: "string", description: "可选，严格匹配指定 agent 的轮次" },
			},
			required: ["date"],
		},
	},
	{
		name: "memory_consolidate_topics",
		description:
			"检测并合并冗余的 Topic 索引。\n" +
			"detect：按主题名 70% + 摘要 30% 的 Jaccard 相似度找出相似主题对，返回完整内容供 LLM 审阅。\n" +
			"execute：先完整校验整个合并批次，再修复 fragment 回指、更新 target、备份并删除 source。dry_run=true 时只返回计划，不写入或删除文件。",
		inputSchema: {
			type: "object" as const,
			properties: {
				action: { type: "string", enum: ["detect", "execute"] },
				threshold: {
					type: "number",
					minimum: 0,
					maximum: 1,
					description: "Jaccard 阈值 0~1，默认 0.3（已按中文 Topic 正负样本校准）",
				},
				dry_run: { type: "boolean", description: "execute 时仅校验并返回变更计划，不写入或删除任何文件" },
				merges: {
					type: "array",
					items: {
						type: "object",
						properties: {
							target: { type: "string" },
							sources: { type: "array", items: { type: "string" } },
							skip: { type: "boolean" },
						},
						required: ["target", "sources"],
					},
				},
			},
			required: ["action"],
		},
	},
];
