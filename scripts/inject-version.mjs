#!/usr/bin/env node
/**
 * inject-version.mjs — 把 package.json 的 version 注入 src/version.ts
 *
 * 单一版本来源 = package.json 的 version 字段。src/index.ts 通过 import
 * { VERSION } from "./version.js" 读取，避免版本号散落在两处手写。
 *
 * 由 build/dev/check 三个 npm script 前置调用；也手动执行：
 *   node scripts/inject-version.mjs
 *
 * 幂等：生成内容与现有文件一致时跳过写入，避免无意义 mtime 变化触发 watcher。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || version.length === 0) {
	console.error("[inject-version] package.json 缺少 version 字段");
	process.exit(1);
}

const out = `// 本文件由 scripts/inject-version.mjs 从 package.json 自动生成，请勿手改。\nexport const VERSION = ${JSON.stringify(version)};\n`;
const target = resolve(root, "src", "version.ts");

if (existsSync(target) && readFileSync(target, "utf8") === out) {
	// 已是最新，跳过
	process.exit(0);
}

writeFileSync(target, out, "utf8");
console.log(`[inject-version] 已写入 src/version.ts (${version})`);
