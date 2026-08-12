import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-topic-parse-"));
process.chdir(tempRoot);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topics = await import(pathToFileURL(path.join(projectRoot, "src/storage/topics.ts")).href);

const topicsDir = path.join(tempRoot, "memory/topics");

beforeEach(() => {
	fs.rmSync(path.join(tempRoot, "memory"), { recursive: true, force: true });
	fs.mkdirSync(topicsDir, { recursive: true });
});

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** 直接写一个 topic md 文件（模拟 buildTopicMD 输出 + 可能的污染形态） */
function writeTopic(name: string, lines: string[]): void {
	fs.writeFileSync(path.join(topicsDir, `${name}.md`), lines.join("\n") + "\n", "utf-8");
}

describe("parseTopicMD：行尾链接锚定（修复 summary 内嵌 A→B 截胡）", () => {
	test("summary 内嵌「（179→33 行）」时 fragment_id 仍正确解析", () => {
		writeTopic("通用楼层扩展", [
			"# 主题：通用楼层扩展（2026-08-05 ~ 2026-08-08）",
			"",
			"**涵盖日期**：2026-08-05, 2026-08-08",
			"**状态**：进行中",
			"",
			"## 各阶段",
			"",
			"- 2026-08-08：20F 模板化改造完成：20F 重写为继承 building_floor.tscn（179→33 行），覆盖 P1/StairsUp。（→ daily/2026-08-08.md → 2026-08-08/frag_001）",
			"",
		]);
		const meta = topics.getTopic("通用楼层扩展");
		assert.ok(meta);
		assert.equal(meta.entries.length, 1);
		assert.equal(meta.entries[0].fragment_id, "2026-08-08/frag_001");
	});

	test("summary 内嵌「（-1→0，...）」时 fragment_id 仍正确解析", () => {
		writeTopic("音频系统", [
			"# 主题：音频系统（2026-08-05 ~ 2026-08-05）",
			"",
			"**涵盖日期**：2026-08-05",
			"**状态**：进行中",
			"",
			"## 各阶段",
			"",
			"- 2026-08-05：修复循环音频 bug（wav 导入器 loop_end=-1→0，_apply_loop_flag 按 get_length()*mix_rate 修正）。（→ daily/2026-08-05.md → 2026-08-05/frag_007）",
			"",
		]);
		const meta = topics.getTopic("音频系统");
		assert.ok(meta);
		assert.equal(meta.entries[0].fragment_id, "2026-08-05/frag_007");
	});

	test("summary 内嵌「（v1.0→v1.2）」时 fragment_id 仍正确解析", () => {
		writeTopic("项目经验教训", [
			"# 主题：项目经验教训（2026-08-04 ~ 2026-08-04）",
			"",
			"**涵盖日期**：2026-08-04",
			"**状态**：进行中",
			"",
			"## 各阶段",
			"",
			"- 2026-08-04：不核验 API 就出方案的反复返工（07-31 处决系统方案 v1.0→v1.2 三轮修订）。（→ daily/2026-08-04.md → 2026-08-04/frag_003）",
			"",
		]);
		const meta = topics.getTopic("项目经验教训");
		assert.ok(meta);
		assert.equal(meta.entries[0].fragment_id, "2026-08-04/frag_003");
	});

	test("正常 summary（无内嵌箭头括号）解析不变", () => {
		writeTopic("对话系统", [
			"# 主题：对话系统（2026-08-01 ~ 2026-08-01）",
			"",
			"**涵盖日期**：2026-08-01",
			"**状态**：进行中",
			"",
			"## 各阶段",
			"",
			"- 2026-08-01：设计全局对话触发系统（v1.0 设计文档完成）。（→ daily/2026-08-01.md → 2026-08-01/frag_001）",
			"",
		]);
		const meta = topics.getTopic("对话系统");
		assert.ok(meta);
		assert.equal(meta.entries[0].fragment_id, "2026-08-01/frag_001");
		assert.match(meta.entries[0].summary, /设计全局对话触发系统/);
	});

	test("多条目混合：内嵌箭头条目与正常条目均正确解析", () => {
		writeTopic("门系统", [
			"# 主题：门系统（2026-07-28 ~ 2026-08-05）",
			"",
			"**涵盖日期**：2026-07-28, 2026-08-05",
			"**状态**：进行中",
			"",
			"## 各阶段",
			"",
			"- 2026-07-28：door.tscn 改造为 Toggle 模式：opened 从 StateAnimation 改为 StateInteract，closed.one_shot=false。按E开门→按E关门→循环。（→ daily/2026-07-28.md → 2026-07-28/frag_005）",
			"- 2026-08-05：全局门默认锁定（路径 A）：door.tscn 根节点 allow_open=false。（→ daily/2026-08-05.md → 2026-08-05/frag_009）",
			"",
		]);
		const meta = topics.getTopic("门系统");
		assert.ok(meta);
		assert.equal(meta.entries.length, 2);
		assert.equal(meta.entries[0].fragment_id, "2026-07-28/frag_005");
		assert.equal(meta.entries[1].fragment_id, "2026-08-05/frag_009");
		// summary 完整保留（不被内嵌括号截断）
		assert.match(meta.entries[0].summary, /按E开门→按E关门→循环/);
	});

	test("空 fid（写入层缺失）解析为空字符串而非崩溃", () => {
		writeTopic("门系统", [
			"# 主题：门系统（2026-07-28 ~ 2026-07-28）",
			"",
			"**涵盖日期**：2026-07-28",
			"**状态**：进行中",
			"",
			"## 各阶段",
			"",
			"- 2026-07-28：door.tscn 改造为 Toggle 模式。（→ daily/2026-07-28.md → ）",
			"",
		]);
		const meta = topics.getTopic("门系统");
		assert.ok(meta);
		assert.equal(meta.entries.length, 1);
		assert.equal(meta.entries[0].fragment_id, "");
	});
});
