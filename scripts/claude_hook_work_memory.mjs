#!/usr/bin/env node
/**
 * claude_hook_work_memory.mjs — Claude Code UserPromptSubmit hook：注入热工作记忆
 *
 * 每次用户提交提示词后，把 <cwd>/memory/work_memory.md 的最新内容注入到本轮请求上下文。
 * 由 configure_harness.mjs 生成 .claude/settings.json 时挂接（UserPromptSubmit 事件）。
 *
 * 容错原则（与 work_memory.ts 一致，best-effort）：
 *  - 热文件不存在 / 读失败 → 输出空 JSON，绝不阻断用户提问
 *  - 只在出错时往 stderr 打日志，stdout 保持干净协议通道
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Claude Code 在项目根启动，process.cwd() 即项目根；与 Deep Code 读到同一文件
const WORK_MEMORY = resolve(process.cwd(), "memory/work_memory.md");

function main() {
  let content = "";
  try {
    if (existsSync(WORK_MEMORY)) {
      content = readFileSync(WORK_MEMORY, "utf8");
    }
  } catch (err) {
    console.error(`[claude_hook_work_memory] 读热文件失败：${err?.message ?? err}`);
  }
  // UserPromptSubmit hook 的 stdout 注入格式（官方）：JSON additionalContext
  // 内容为空时 additionalContext 为空串，Claude Code 会忽略（等价于不注入）
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: content,
      },
    }),
  );
}

main();
