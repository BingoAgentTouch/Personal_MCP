#!/usr/bin/env node
/**
 * inject_memory_usage.mjs — 向各 harness 规则文件幂等注入 memory-mcp 使用声明
 *
 * 用途：启用 memory-mcp-server 后，把"记忆系统使用规范"写入 Claude Code / Deep Code /
 *       Cursor / Cline 等 harness 自动注入的规则文件，让每个 agent 都知道要先查记忆。
 *
 * 用法：
 *   node scripts/inject_memory_usage.mjs [项目根] [选项]
 *
 * 选项：
 *   --files a.md,b.md      指定目标文件清单（默认：常见 harness 文件，只处理存在的）
 *   --settings-path PATH   覆盖模板中 {{settings_path}}（默认 .deepcode/settings.json）
 *   --docs-path PATH       覆盖模板中 {{docs_path}}（可选，提供则生成"更多用法"行）
 *   --template PATH        自定义模板文件（默认同目录 memory_usage_template.md）
 *   --dry-run              只报告将要做什么，不写文件
 *
 * 幂等策略（对每个目标文件）：
 *   1. 文件不存在        → skip（不创建新文件）
 *   2. 已有 marker 区块  → update（替换 BEGIN..END 之间全部内容）
 *   3. 已有同名标题段落  → skip（视为人工维护，不重复注入）
 *   4. 其余              → inject（追加到文件末尾）
 *
 * 示例：
 *   node scripts/inject_memory_usage.mjs D:/ProjectGame/避难末日demo
 *   node scripts/inject_memory_usage.mjs . --docs-path "init_md/memory_mcp规范.md"
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = join(__dirname, "memory_usage_template.md");
const BEGIN_MARKER = "<!-- BEGIN memory-mcp-usage -->";
const END_MARKER = "<!-- END memory-mcp-usage -->";

// 常见 harness 规则文件（按优先级排列；脚本只处理存在的）
const DEFAULT_FILES = [
  "AGENTS.md", // OpenAI Codex / Deep Code / 多数通用 agent
  "CLAUDE.md", // Claude Code
  "GEMINI.md", // Gemini CLI
  ".clinerules", // Cline / Roo Code
  ".cursorrules", // Cursor（旧式）
  ".cursor/rules/memory.mdc", // Cursor（新式规则文件）
  ".windsurfrules", // Windsurf
];

function parseArgs(argv) {
  const args = { projectRoot: ".", files: null, settingsPath: ".deepcode/settings.json", docsPath: null, template: DEFAULT_TEMPLATE, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--files") args.files = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--settings-path") args.settingsPath = argv[++i];
    else if (a === "--docs-path") args.docsPath = argv[++i];
    else if (a === "--template") args.template = argv[++i];
    else rest.push(a);
  }
  if (rest.length > 0) args.projectRoot = rest[0];
  return args;
}

function buildDeclaration(templatePath, settingsPath, docsPath) {
  let tpl = readFileSync(templatePath, "utf8");
  // 去除 BOM
  tpl = tpl.replace(/^\uFEFF/, "");
  const docsLine = docsPath
    ? `（更多用法，如有需要可查阅 "${docsPath}"）`
    : "";
  tpl = tpl.replaceAll("{{settings_path}}", settingsPath).replaceAll("{{docs_line}}", docsLine).replaceAll("{{docs_path}}", docsPath ?? "");
  // 收尾：去掉模板尾部多余空行，保证区块整洁
  tpl = tpl.replace(/\s+$/, "\n");
  return `${BEGIN_MARKER}\n${tpl}${END_MARKER}\n`;
}

function hasMarker(content) {
  return content.includes(BEGIN_MARKER) || content.includes(END_MARKER);
}

function hasSameHeading(content, template) {
  const m = template.match(/^#{1,6}\s+(.+)$/m);
  if (!m) return false;
  const heading = m[1].trim();
  return content.includes(heading);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.projectRoot);
  const files = args.files ?? DEFAULT_FILES;

  if (!existsSync(args.template)) {
    console.error(`[error] 模板不存在: ${args.template}`);
    process.exit(1);
  }
  if (!existsSync(root)) {
    console.error(`[error] 项目根不存在: ${root}`);
    process.exit(1);
  }

  const declaration = buildDeclaration(args.template, args.settingsPath, args.docsPath);
  console.log(`模板: ${args.template}`);
  console.log(`项目根: ${root}`);
  console.log(`目标文件: ${files.length} 个（${args.dryRun ? "dry-run，不写入" : "写入"}）\n`);

  let nInject = 0, nUpdate = 0, nSkip = 0;
  for (const f of files) {
    const path = join(root, f);
    if (!existsSync(path)) {
      console.log(`  [skip ] ${f}   （不存在）`);
      nSkip++;
      continue;
    }
    const content = readFileSync(path, "utf8");

    if (hasMarker(content)) {
      // 替换旧区块（幂等更新）
      const regex = new RegExp(`\\s*${BEGIN_MARKER}[\\s\\S]*?${END_MARKER}\\s*`);
      const updated = content.replace(regex, `\n${declaration}`);
      if (!args.dryRun) writeFileSync(path, updated, "utf8");
      console.log(`  [update] ${f}   已更新 marker 区块`);
      nUpdate++;
    } else if (hasSameHeading(content, declaration)) {
      console.log(`  [skip ] ${f}   已含同标题段落（${f} 人工维护，不覆盖）`);
      nSkip++;
    } else {
      const updated = content.replace(/\s*$/, "\n") + "\n" + declaration;
      if (!args.dryRun) writeFileSync(path, updated, "utf8");
      console.log(`  [inject] ${f}   已追加声明`);
      nInject++;
    }
  }

  console.log(`\n完成：inject ${nInject} / update ${nUpdate} / skip ${nSkip}`);
}

main();
