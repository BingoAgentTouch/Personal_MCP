import { performance } from "node:perf_hooks";
import { buildDocumentViews, type DocumentInput } from "../src/embedding/builder.js";

const input: DocumentInput = {
	task_desc: "验证 tokenizer 边界性能",
	result_desc: "保留 API_ERROR_512、src/search/retriever.ts 和中文中间证据",
	tags: ["embedding", "中文", "benchmark"],
	topic_name: "记忆系统",
	turns_text: Array.from(
		{ length: 900 },
		(_, index) => `turn_${String(index).padStart(4, "0")} 中文证据 API_ERROR_${index}。`,
	).join("\n"),
};

const options = {
	evidence_window_tokens: 96,
	evidence_overlap_tokens: 16,
	disclosure_snippet_tokens: 20,
};

const samples = 3;
const durations: number[] = [];
let first: Awaited<ReturnType<typeof buildDocumentViews>> | undefined;

for (let index = 0; index < samples; index += 1) {
	const started = performance.now();
	const result = await buildDocumentViews(input, undefined, options);
	durations.push(performance.now() - started);
	first ??= result;
	if (JSON.stringify(result) !== JSON.stringify(first)) throw new Error("multiview benchmark output is not deterministic");
}

durations.sort((a, b) => a - b);
const percentile = (fraction: number) => durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * fraction))];
console.log(JSON.stringify({
	samples,
	views: first?.views.length ?? 0,
	cold_ms: durations[0],
	p50_ms: percentile(0.5),
	p95_ms: percentile(0.95),
	min_ms: durations[0],
	max_ms: durations.at(-1),
}, null, 2));
