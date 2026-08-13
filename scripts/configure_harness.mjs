#!/usr/bin/env node
/**
 * configure_harness.mjs — 按 harness 生成 memory-mcp 的接入配置（编排器）
 *
 * 背景：热工作记忆（memory/work_memory.md）的「内容生产」由 memory-mcp-server 负责，
 *       「内容消费」由各 harness 各自接入。本脚本按用户声明的 harness，生成该 harness
 *       的完整接入配置包。不做运行时检测——harness 配置天然隔离即分支。
 *
 * 用法：
 *   node scripts/configure_harness.mjs [项目根] --harness claude-code,deepcode [选项]
 *
 * 选项：
 *   --harness LIST      逗号分隔的 harness 名（默认 claude-code；支持 claude-code / deepcode）
 *   --docs-path PATH    注入规则时引用的「更多用法」文档路径（可选）
 *   --dry-run           只报告将要做什么，不写文件
 *
 * 各 harness 生成物：
 *   claude-code  → ① .mcp.json（MCP 注册）② CLAUDE.md（规则注入）③ .claude/settings.json（UserPromptSubmit hook）④ .claude/settings.local.json（权限全 allow）
 *   deepcode     → 已接入（.deepcode/settings.json + AGENTS.md），仅提示无需改动
 *
 * 复用：规则文件注入（CLAUDE.md）委托给 inject_memory_usage.mjs（子进程调用，幂等四态不变）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// memory-mcp-server 仓库根（scripts/ 的上一级），据此推导 dist/index.js 与 hook 脚本路径，避免硬编码
const REPO_ROOT = resolve(__dirname, "..");
const DIST_INDEX = join(REPO_ROOT, "dist", "index.js");
const INJECT_SCRIPT = join(__dirname, "inject_memory_usage.mjs");
// hook 命令会被 Claude Code 以 shell:true 执行（Windows 走 cmd.exe），反斜杠会被吃掉 → 必须正斜杠
const HOOK_SCRIPT = join(__dirname, "claude_hook_work_memory.mjs").replace(/\\/g, "/");

// memory-mcp 全部工具（权限全 allow，用户 2026-08-13 拍板）
const MEMORY_TOOLS = [
  "memory_search",
  "memory_store_turn",
  "memory_create_fragment",
  "memory_create_daily_summary",
  "memory_upsert_topic",
  "memory_get_fragment",
  "memory_get_daily",
  "memory_get_topic",
  "memory_list_dates",
  "memory_get_raw_turns",
  "memory_consolidate_topics",
];

function parseArgs(argv) {
  const args = { projectRoot: ".", harness: ["claude-code"], docsPath: null, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--harness") args.harness = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--docs-path") args.docsPath = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else rest.push(a);
  }
  if (rest.length > 0) args.projectRoot = rest[0];
  return args;
}

function writeJson(file, data, opts) {
  if (!opts.dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}

/** 规则文件不存在时先创建空文件（inject 的幂等策略对不存在文件是 skip，不创建） */
function ensureRuleFile(root, relPath, opts) {
  const file = join(root, relPath);
  if (existsSync(file)) return;
  console.log(`  [create] ${relPath}  空文件（供注入，inject 对不存在文件默认 skip）`);
  if (!opts.dryRun) writeFileSync(file, "", "utf8");
}

/** 规则文件注入（复用 inject_memory_usage.mjs） */
function runInject(root, extraArgs, opts, label) {
  const args = [INJECT_SCRIPT, root, ...extraArgs];
  if (opts.docsPath) args.push("--docs-path", opts.docsPath);
  console.log(`  [inject] ${label}（复用 inject_memory_usage.mjs）`);
  if (opts.dryRun) {
    console.log(`    (dry-run) 命令：node ${args.join(" ")}`);
    return;
  }
  execFileSync("node", args, { stdio: "inherit" });
}

/** ① .mcp.json（MCP 注册） */
function ensureMcpJson(root, opts) {
  const file = join(root, ".mcp.json");
  const server = { type: "stdio", command: "node", args: [DIST_INDEX], env: {} };
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8"));
    if (existing.mcpServers && existing.mcpServers.memory) {
      console.log("  [skip ] .mcp.json  已有 memory server");
      return;
    }
    existing.mcpServers = { ...(existing.mcpServers || {}), memory: server };
    writeJson(file, existing, opts);
    console.log("  [merge] .mcp.json  补 memory server");
  } else {
    writeJson(file, { mcpServers: { memory: server } }, opts);
    console.log("  [create] .mcp.json  MCP 注册");
  }
}

/** ③ .claude/settings.json（UserPromptSubmit hook） */
function ensureHooksSettings(root, opts) {
  const file = join(root, ".claude", "settings.json");
  const hookEntry = { type: "command", command: `node ${HOOK_SCRIPT}` };
  let settings = {};
  if (existsSync(file)) {
    settings = JSON.parse(readFileSync(file, "utf8"));
  }
  settings.hooks = settings.hooks || {};
  const existing = settings.hooks.UserPromptSubmit || [];
  // 幂等：已含 claude_hook_work_memory 的 hook 时，command 相同→skip，不同（如反斜杠→正斜杠）→更新
  const idx = existing.findIndex((g) => (g.hooks || []).some((h) => (h.command || "").includes("claude_hook_work_memory")));
  if (idx !== -1) {
    if (existing[idx].hooks?.[0]?.command === hookEntry.command) {
      console.log("  [skip ] .claude/settings.json  UserPromptSubmit hook 已存在");
      return;
    }
    const updated = [...existing];
    updated[idx] = { matcher: "", hooks: [hookEntry] };
    settings.hooks.UserPromptSubmit = updated;
    writeJson(file, settings, opts);
    console.log("  [update] .claude/settings.json  UserPromptSubmit hook command（正斜杠化）");
    return;
  }
  settings.hooks.UserPromptSubmit = [...existing, { matcher: "", hooks: [hookEntry] }];
  writeJson(file, settings, opts);
  console.log("  [inject] .claude/settings.json  UserPromptSubmit hook");
}

/** ④ .claude/settings.local.json（权限全 allow） */
function ensurePermissions(root, opts) {
  const file = join(root, ".claude", "settings.local.json");
  let settings = {};
  if (existsSync(file)) {
    settings = JSON.parse(readFileSync(file, "utf8"));
  }
  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  const allow = settings.permissions.allow;
  const tools = MEMORY_TOOLS.map((t) => `mcp__memory__${t}`);
  const missing = tools.filter((t) => !allow.includes(t));
  if (missing.length === 0) {
    console.log(`  [skip ] .claude/settings.local.json  权限已全 allow（${tools.length}/${tools.length}）`);
    return;
  }
  allow.push(...missing);
  writeJson(file, settings, opts);
  console.log(`  [update] .claude/settings.local.json  权限 +${missing.length}（→ ${tools.length}/${tools.length} 全 allow）`);
}

function configureClaudeCode(root, opts) {
  ensureMcpJson(root, opts);
  ensureRuleFile(root, "CLAUDE.md", opts);
  runInject(root, ["--files", "CLAUDE.md", "--settings-path", ".mcp.json"], opts, "CLAUDE.md 规则注入");
  ensureHooksSettings(root, opts);
  ensurePermissions(root, opts);
}

function configureDeepCode(root, opts) {
  // Deep Code 已接入：.deepcode/settings.json（MCP 注册）+ AGENTS.md（规则 marker 区块已存在）
  console.log("  [skip ] Deep Code 已接入（.deepcode/settings.json + AGENTS.md），无需改动");
}

const ACTIONS = { "claude-code": configureClaudeCode, deepcode: configureDeepCode };

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = resolve(opts.projectRoot);
  if (!existsSync(root)) {
    console.error(`[error] 项目根不存在: ${root}`);
    process.exit(1);
  }
  if (!existsSync(DIST_INDEX)) {
    console.error(`[error] dist/index.js 不存在: ${DIST_INDEX}`);
    process.exit(1);
  }

  console.log(`项目根: ${root}`);
  console.log(`harness: ${opts.harness.join(", ")}`);
  console.log(`模式: ${opts.dryRun ? "dry-run（不写入）" : "写入"}\n`);

  for (const h of opts.harness) {
    const fn = ACTIONS[h];
    if (!fn) {
      console.log(`[warn] 未支持的 harness: ${h}（支持：${Object.keys(ACTIONS).join(", ")}）`);
      continue;
    }
    console.log(`=== ${h} ===`);
    fn(root, opts);
  }
  console.log("\n完成");
}

main();
