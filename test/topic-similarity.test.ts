import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-topic-similarity-"));
process.chdir(tempRoot);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topics = await import(pathToFileURL(path.join(projectRoot, "src/storage/topics.ts")).href);
const handlers = await import(pathToFileURL(path.join(projectRoot, "src/mcp/handlers.ts")).href);

const topic = (name: string, ...summaries: string[]) => ({
	name,
	entries: summaries.map((summary, index) => ({
		date: `2026-08-${String(index + 1).padStart(2, "0")}`,
		fragment_id: `2026-08-${String(index + 1).padStart(2, "0")}/frag_${String(index + 1).padStart(3, "0")}`,
		summary,
	})),
});

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Topic tokenizer and similarity", () => {
	test("T3-01/T3-02: related Chinese text shares bigrams and unrelated text scores lower", () => {
		const related = topics.jaccardSimilarity("对话系统", "对话系统改造");
		const unrelated = topics.jaccardSimilarity("对话系统", "数据库备份");
		assert.ok(related > 0);
		assert.ok(related > unrelated);
	});

	test("T3-03: single Chinese characters use unigram tokens", () => {
		assert.deepEqual([...topics.tokenizeTopicText("甲")], ["zh:甲"]);
		assert.equal(topics.jaccardSimilarity("甲", "甲"), 1);
	});

	test("T3-04/T3-05: words normalize case and mixed punctuation is only a boundary", () => {
		assert.deepEqual(topics.tokenizeTopicText("Memory AGENT 2"), topics.tokenizeTopicText("memory-agent 2"));
		const tokens = topics.tokenizeTopicText("中文,Memory! AGENT-2");
		assert.ok(tokens.has("zh:中文"));
		assert.ok(tokens.has("word:memory"));
		assert.ok(tokens.has("word:agent"));
		assert.ok(tokens.has("word:2"));
		assert.ok(![...tokens].some((token) => token.endsWith(":")));
	});

	test("T3-06/T3-07: empty text is zero and identical text is one", () => {
		assert.equal(topics.jaccardSimilarity("!!!", "??"), 0);
		assert.equal(topics.jaccardSimilarity("对话系统 Memory", "对话系统 Memory"), 1);
	});

	test("T3-08/T3-09: topic name and summary weights are explicitly 0.7/0.3", () => {
		const sameName = topics.topicSimilarity(topic("对话系统", "甲乙丙"), topic("对话系统", "丁戊己"));
		assert.equal(sameName.name_score, 1);
		assert.equal(sameName.summary_score, 0);
		assert.equal(sameName.similarity, 0.7);

		const sameSummary = topics.topicSimilarity(topic("甲乙", "共同摘要内容"), topic("丙丁", "共同摘要内容"));
		assert.equal(sameSummary.name_score, 0);
		assert.equal(sameSummary.summary_score, 1);
		assert.equal(sameSummary.similarity, 0.3);
	});

	test("T3-10: detect returns pairs in descending total score with component scores", async () => {
		topics.upsertTopic("对话系统", "2026-08-01", "2026-08-01/frag_001", "输入控制与对话管理");
		topics.upsertTopic("对话系统改造", "2026-08-02", "2026-08-02/frag_002", "输入控制与对话管理");
		topics.upsertTopic("对话系统与输入控制", "2026-08-03", "2026-08-03/frag_003", "输入控制");
		const response = await handlers.handleConsolidateTopics({ action: "detect", threshold: 0 });
		assert.equal(response.isError, undefined);
		const payload = JSON.parse(response.content[0].text);
		assert.ok(payload.pairs.length >= 2);
		for (let i = 1; i < payload.pairs.length; i++) {
			assert.ok(payload.pairs[i - 1].similarity >= payload.pairs[i].similarity);
		}
		assert.equal(typeof payload.pairs[0].name_score, "number");
		assert.equal(typeof payload.pairs[0].summary_score, "number");
	});

	test("T3-11/T3-12: threshold accepts endpoints and rejects invalid values", async () => {
		for (const threshold of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
			const response = await handlers.handleConsolidateTopics({ action: "detect", threshold });
			assert.equal(response.isError, true, `threshold ${String(threshold)} should fail`);
		}
		for (const threshold of [0, 1]) {
			const response = await handlers.handleConsolidateTopics({ action: "detect", threshold });
			assert.equal(response.isError, undefined);
		}
	});

	test("T3-13: calibrated default threshold includes confirmed positives and excludes unrelated pair", async () => {
		const positiveA = topics.topicSimilarity(topic("对话系统", "对话系统输入处理"), topic("对话系统改造", "对话系统输入控制改造"));
		const positiveB = topics.topicSimilarity(topic("对话系统", "对话系统输入处理"), topic("对话系统与输入控制", "对话系统输入控制"));
		const negative = topics.topicSimilarity(topic("对话系统", "对话系统输入处理"), topic("数据库备份", "数据库备份与恢复"));
		assert.ok(positiveA.similarity >= 0.3);
		assert.ok(positiveB.similarity >= 0.3);
		assert.ok(negative.similarity < 0.3);

		const response = await handlers.handleConsolidateTopics({ action: "detect" });
		const payload = JSON.parse(response.content[0].text);
		assert.equal(payload.threshold, 0.3);
		assert.ok(payload.pairs.every((pair: { similarity: number }) => pair.similarity >= 0.3));
	});
});
