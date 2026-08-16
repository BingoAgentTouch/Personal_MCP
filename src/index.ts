#!/usr/bin/env node
// ============================================================
// Memory MCP Server 入口
//
// 启动方式：
//   npx tsx src/index.ts
//
// Claude Code 配置 (settings.json):
//   {
//     "mcpServers": {
//       "memory": {
//         "command": "npx",
//         "args": ["tsx", "D:/AgentStore/memory-mcp-server/src/index.ts"]
//       }
//     }
//   }
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./mcp/tools.js";
import { handlerMap } from "./mcp/handlers.js";
import { listAllFragmentIds, getFragmentRaw } from "./storage/fragments.js";
import { listDates as listDailyDates, getDailySummary } from "./storage/daily.js";
import { listTopics, getTopicRaw } from "./storage/topics.js";
import { readTurns, getTurnRangeText } from "./storage/raw.js";
import { listDates as listRawDates } from "./storage/raw.js";
import { startWatcher, observe as watcherObserve } from "./watcher/index.js";
import { workMemory } from "./work_memory.js";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

const server = new Server(
	{
		name: "memory-mcp-server",
		version: VERSION,
	},
	{
		capabilities: {
			tools: {},
			resources: {},
		},
	},
);

// ============================================================
// Tools
// ============================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
	return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	const handler = handlerMap[name];
	if (!handler) {
		return {
			content: [{ type: "text", text: `未知工具：${name}` }],
			isError: true,
		};
	}
	// watcher 观测层：只读旁观，独立 try-catch（try 块外），不污染工具响应
	try {
		watcherObserve(name, args ?? {});
	} catch {
		// best-effort：观测异常绝不影响工具调用
	}
	try {
		return await handler(args ?? {});
	} catch (err: any) {
		return {
			content: [{ type: "text", text: `执行 ${name} 时出错：${err.message}` }],
			isError: true,
		};
	}
});

// ============================================================
// Resources
// ============================================================

/** 解析 memory:// URI */
function parseMemoryUri(uri: string): { type: string; params: string[] } | null {
	const prefix = "memory://";
	if (!uri.startsWith(prefix)) return null;
	const path = uri.slice(prefix.length);
	const parts = path.split("/").filter(Boolean);
	if (parts.length === 0) return { type: "root", params: [] };
	return { type: parts[0], params: parts.slice(1) };
}

/** 动态构建 resource 列表 */
function buildResourceList() {
	const resources: Array<{ uri: string; name: string; mimeType?: string }> = [];

	// raw
	for (const date of listRawDates()) {
		resources.push({
			uri: `memory://raw/${date}`,
			name: `对话记录 ${date}`,
			mimeType: "application/jsonl",
		});
	}

	// fragments
	for (const fragId of listAllFragmentIds()) {
		resources.push({
			uri: `memory://fragments/${fragId}`,
			name: `片段 ${fragId}`,
			mimeType: "text/markdown",
		});
	}

	// daily
	for (const date of listDailyDates()) {
		resources.push({
			uri: `memory://daily/${date}`,
			name: `每日总结 ${date}`,
			mimeType: "text/markdown",
		});
	}

	// topics
	for (const topic of listTopics()) {
		resources.push({
			uri: `memory://topics/${topic}`,
			name: `主题索引 ${topic}`,
			mimeType: "text/markdown",
		});
	}

	return resources;
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
	return { resources: buildResourceList() };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const parsed = parseMemoryUri(request.params.uri);
	if (!parsed) {
		return {
			contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "无效的 memory:// URI" }],
		};
	}

	try {
		switch (parsed.type) {
			case "raw": {
				const [date] = parsed.params;
				const turns = readTurns(date);
				const text = turns.map((t) => JSON.stringify(t)).join("\n");
				return {
					contents: [{ uri: request.params.uri, mimeType: "application/jsonl", text }],
				};
			}
			case "fragments": {
				const [date, id] = parsed.params;
				const md = getFragmentRaw(`${date}/${id}`);
				if (!md) throw new Error("片段不存在");
				return {
					contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: md }],
				};
			}
			case "daily": {
				const [date] = parsed.params;
				const md = getDailySummary(date);
				if (!md) throw new Error("每日总结不存在");
				return {
					contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: md }],
				};
			}
			case "topics": {
				const [topic] = parsed.params;
				const md = getTopicRaw(topic);
				if (!md) throw new Error("主题不存在");
				return {
					contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: md }],
				};
			}
			default:
				return {
					contents: [
						{
							uri: request.params.uri,
							mimeType: "text/plain",
							text: `未知 resource 类型：${parsed.type}\n可用类型：raw, fragments, daily, topics`,
						},
					],
				};
		}
	} catch (err: any) {
		return {
			contents: [
				{
					uri: request.params.uri,
					mimeType: "text/plain",
					text: `读取失败：${err.message}`,
				},
			],
		};
	}
});

// ============================================================
// 启动（STDIO 模式）
// 建议通过 relay.mjs 中转服务启动，以绕过 Windows 子进程
// stdout 管道不兼容问题。
// ============================================================

/**
 * 向当前项目（process.cwd()）的 harness 规则文件注入 memory-mcp 使用声明。
 * 幂等：已有 marker 则更新、已有同标题段落则跳过、文件不存在则跳过。
 * 注意：MCP stdio 模式下 stdout 是协议通道，脚本输出一律不得进 stdout；
 *       这里丢弃脚本 stdout，只捕获 stderr 通过 console.error 透出。
 * 注入失败不阻断服务器启动。
 *
 * 发布友好开关：设 MEMORY_SKIP_INJECT=1（或 true/yes）跳过注入——
 * 对他人机器默认不注入 harness 规则（侵入性行为），本机不设则保留现状。
 */
function injectHarnessUsage() {
	const skip = (process.env.MEMORY_SKIP_INJECT ?? "").trim().toLowerCase();
	if (skip && skip !== "0" && skip !== "false" && skip !== "no") {
		console.error("[memory-mcp-server] MEMORY_SKIP_INJECT 已设置，跳过 harness 规则注入");
		return;
	}
	try {
		const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../scripts/inject_memory_usage.mjs");
		const result = spawnSync(process.execPath, [scriptPath, process.cwd()], {
			timeout: 2000,
			stdio: ["ignore", "ignore", "pipe"],
		});
		if (result.status !== 0) {
			const errOut = (result.stderr ?? "").toString().trim();
			console.error(`[memory-mcp-server] 注入 harness 规则失败 (exit ${result.status})${errOut ? `: ${errOut}` : ""}`);
		}
	} catch (err: any) {
		console.error("[memory-mcp-server] 注入 harness 规则异常：", err?.message ?? err);
	}
}

async function main() {
	// 向 harness 规则文件注入使用声明（幂等，不阻断启动）
	injectHarnessUsage();
	// 热工作记忆：清空上一会话残留（best-effort）
	workMemory.init();
	// 启动 watcher 观测层（随进程初始化，进程退出即结束）
	startWatcher();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("[memory-mcp-server] 已启动，等待客户端连接...");
}

main().catch((err) => {
	console.error("[memory-mcp-server] 启动失败：", err);
	process.exit(1);
});
