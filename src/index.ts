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

const server = new Server(
	{
		name: "memory-mcp-server",
		version: "0.1.0",
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

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("[memory-mcp-server] 已启动，等待客户端连接...");
}

main().catch((err) => {
	console.error("[memory-mcp-server] 启动失败：", err);
	process.exit(1);
});
