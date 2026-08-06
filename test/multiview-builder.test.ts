import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-multiview-"));

let builder: typeof import("../src/embedding/builder.ts");

before(async () => {
	process.chdir(tempRoot);
	builder = await import("../src/embedding/builder.ts");
});

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

const input = {
	task_desc: "验证中文长文本多视图检索",
	result_desc: "保留 API_ERROR_512、src/search/retriever.ts 和中间证据",
	tags: ["embedding", "中文"],
	topic_name: "记忆系统",
	turns_text: Array.from({ length: 900 }, (_, index) => `turn_${String(index).padStart(4, "0")} 中文证据 API_ERROR_${index}。`).join("\n"),
};

const options = {
	evidence_window_tokens: 96,
	evidence_overlap_tokens: 16,
	disclosure_snippet_tokens: 20,
};

describe("fragment multiview builder prototype", () => {
	test("builds deterministic summary and evidence views", async () => {
		const first = await builder.buildDocumentViews(input, undefined, options);
		const second = await builder.buildDocumentViews(input, undefined, options);

		assert.deepEqual(first, second);
		assert.equal(first.recipe_id, "fragment-multiview-budgeted");
		assert.equal(first.recipe_version, 1);
		assert.equal(first.views[0].view_id, "summary");
		assert.equal(first.views[0].disclosure.disclosure_level, "T1");
		assert.equal(first.views[1].view_id, "evidence_001");
		assert.equal(first.views[1].disclosure.disclosure_level, "T2");
		assert.equal(first.views[1].disclosure.snippet_anchor, "view_fallback");
	});

	test("covers the full source with stable overlapping evidence spans", async () => {
		const result = await builder.buildDocumentViews(input, undefined, options);
		const evidence = result.views.filter((view) => view.kind === "evidence");
		assert.ok(evidence.length > 1);
		assert.equal(evidence[0].source_spans[0].start_token, 0);
		assert.equal(evidence.at(-1)?.source_spans[0].end_token, evidence[0].tokens.source_total_tokens);

		for (const [index, view] of evidence.entries()) {
			assert.ok(view.tokens.used <= view.tokens.model_max);
			const span = view.source_spans[0];
			assert.ok(span.end_token > span.start_token);
			assert.ok(span.end_char > span.start_char);
			if (index > 0) {
				const previous = evidence[index - 1].source_spans[0];
				assert.equal(span.start_token, previous.end_token - options.evidence_overlap_tokens);
			}
		}
	});

	test("handles empty turns without creating evidence views", async () => {
		const result = await builder.buildDocumentViews({ ...input, turns_text: "" }, undefined, options);
		assert.deepEqual(result.views.map((view) => view.view_id), ["summary"]);
	});

	test("rejects invalid window options and incompatible recipes", async () => {
	await assert.rejects(
		builder.buildDocumentViews(input, undefined, { ...options, evidence_overlap_tokens: options.evidence_window_tokens }),
		/evidence_overlap_tokens/,
	);
	await assert.rejects(
		builder.buildDocumentViews(input, { document_recipe_id: "fragment-structured-budgeted" }, options),
		/requires recipe fragment-multiview-budgeted/,
	);
	await assert.rejects(
		builder.buildDocumentViews(input, {
			document_recipe_id: "fragment-multiview-budgeted",
			document_recipe_version: 2,
			document_policy_version: 1,
		}, options),
		/requires recipe version 1/,
	);
	await assert.rejects(
		builder.buildDocumentViews(input, {
			document_recipe_id: "fragment-multiview-budgeted",
			document_recipe_version: 1,
			document_policy_version: 2,
		}, options),
		/requires policy version 1/,
	);
	});
});
