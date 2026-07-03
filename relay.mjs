// MCP HTTP SSE ↔ STDIO 中转服务
// Cherry Studio --HTTP/SSE--> relay --STDIO--> MCP Server
// 解决 Windows 子进程 stdout 管道不兼容问题

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = resolve(__dirname, "src/index.ts");
const TSX_CLI = resolve(__dirname, "node_modules/tsx/dist/cli.mjs");
const PORT = parseInt(process.env.PORT || "3457", 10);

// ── MCP 子进程 ───────────────────────────────────────────
const child = spawn(process.execPath, [TSX_CLI, MCP_SCRIPT], {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});

child.on("exit", (code) => {
  console.error(`[relay] 子进程退出 (code=${code})`);
  process.exit(code ?? 1);
});

// ── SSE 会话 ─────────────────────────────────────────────
let sseResponse = null; // 当前 SSE 连接的 res 对象
let readBuffer = "";

// 子进程 stdout → 解析 JSON → 通过 SSE 推送
child.stdout.on("data", (chunk) => {
  readBuffer += chunk.toString();
  const lines = readBuffer.split("\n");
  readBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 跳过控制台日志（stderr 已经 inherit 了，但有些日志走 stdout）
    if (trimmed.startsWith("[") || trimmed.startsWith("已") || trimmed.startsWith("等")) continue;
    try {
      const msg = JSON.parse(trimmed);
      // 通过 SSE 推送给 Cherry Studio
      if (sseResponse) {
        sseResponse.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      }
    } catch {
      // 非 JSON 行（console.log 等），忽略
    }
  }
});

// ── HTTP 服务 ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // GET /mcp → 建立 SSE 连接
  if (req.method === "GET" && url.pathname === "/mcp") {
    sseResponse = res;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    // 发送 endpoint 事件告诉客户端 POST 地址
    res.write(`event: endpoint\ndata: /mcp/message?sessionId=default\n\n`);

    req.on("close", () => {
      sseResponse = null;
    });
    return;
  }

  // POST /mcp/message?sessionId=xxx → 转发给子进程
  if (req.method === "POST" && url.pathname === "/mcp/message") {
    let body = "";
    for await (const chunk of req) body += chunk;

    // 转发给子进程（MCP 协议：新行分隔的 JSON）
    child.stdin.write(body + "\n");

    // 立即返回 202 Accepted，响应通过 SSE 推送
    res.writeHead(202).end("Accepted");
    return;
  }

  res.writeHead(404).end("Not Found");
});

server.listen(PORT, () => {
  console.error(`[relay] 中转服务已启动 → http://localhost:${PORT}/mcp`);
});
