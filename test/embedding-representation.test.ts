import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-embedding-"));
process.chdir(tempRoot);

const builder = await import("../src/embedding/builder.ts");
const generation = await import("../src/embedding/generation.ts");

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("embedding representation", () => {
	test("builds deterministic tokenizer-aware document and query inputs", async () => {
		const input = {
			task_desc: "实现长文本检索",
			result_desc: "保留 API_ERROR_512 和 src/search/retriever.ts",
			tags: ["embedding", "中文"],
			topic_name: "记忆系统",
			turns_text: `${"背景信息。".repeat(500)}尾部结论 API_ERROR_512`,
		};
		const first = await builder.buildDocumentInput(input);
		const second = await builder.buildDocumentInput(input);
		assert.equal(first.input_hash, second.input_hash);
		assert.equal(first.text, second.text);
		assert.ok(first.tokens.used <= first.tokens.model_max);
		assert.ok(first.tokens.truncated);
		assert.match(first.text, /API_ERROR_512/);

		const query = await builder.buildQueryInput("中文路径 src/search/retriever.ts API_ERROR_512");
		assert.ok(query.tokens.used <= query.tokens.model_max);
		assert.equal(query.recipe_id, "query-plain-normalized");
	});

	test("creates, indexes, validates, and activates an immutable generation", async () => {
		const manifest = await generation.createGeneration("gen_test_001", "sha256:inventory", 2);
		assert.equal(manifest.state, "building");
		generation.setGenerationExpectedCount("gen_test_001", 1);
		const record = generation.writeGenerationVector(manifest, "2026-08-03/frag_001", [0.5, 0.5], {
			source_content_hash: "sha256:source",
			input_hash: "sha256:input",
			tokens: { used: 2 },
		});
		assert.equal(record.state, "materialized");
		const current = generation.readGenerationManifest("gen_test_001");
		assert.ok(current);
		const ready = generation.finalizeGeneration("gen_test_001");
		assert.equal(ready.state, "ready");
		const pointer = generation.activateGeneration("gen_test_001");
		assert.equal(pointer.active_generation_id, "gen_test_001");
		assert.equal(generation.getActiveGeneration()?.generation_id, "gen_test_001");
		assert.equal(generation.activeVectorExists("2026-08-03/frag_001"), true);
	});
});
