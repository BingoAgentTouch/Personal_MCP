import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const provider = await import("../src/embedding/provider.ts");
const builder = await import("../src/embedding/builder.ts");

const ENV_KEYS = [
	"MEMORY_EMBED_PROVIDER",
	"MEMORY_EMBED_API_URL",
	"MEMORY_EMBED_API_KEY",
	"MEMORY_EMBED_API_MODEL",
	"MEMORY_EMBED_API_MAX_TOKENS",
	"MEMORY_EMBED_API_DIM",
] as const;

const savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

function saveEnv(): void {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
}

function clearApiEnv(): void {
	for (const key of ENV_KEYS) delete process.env[key];
}

function setApiEnv(overrides: Record<string, string> = {}): void {
	clearApiEnv();
	process.env.MEMORY_EMBED_PROVIDER = "api";
	process.env.MEMORY_EMBED_API_URL = overrides.MEMORY_EMBED_API_URL ?? "https://example.com/v1";
	process.env.MEMORY_EMBED_API_KEY = overrides.MEMORY_EMBED_API_KEY ?? "sk-test";
	process.env.MEMORY_EMBED_API_MODEL = overrides.MEMORY_EMBED_API_MODEL ?? "test-embed-model";
	if (overrides.MEMORY_EMBED_API_MAX_TOKENS !== undefined) process.env.MEMORY_EMBED_API_MAX_TOKENS = overrides.MEMORY_EMBED_API_MAX_TOKENS;
	if (overrides.MEMORY_EMBED_API_DIM !== undefined) process.env.MEMORY_EMBED_API_DIM = overrides.MEMORY_EMBED_API_DIM;
}

function mockEmbeddingFetch(vector: number[], status = 200, body = ""): void {
	globalThis.fetch = (async () => {
		if (status !== 200) {
			return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
		}
		return new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

before(() => {
	saveEnv();
	clearApiEnv();
});

after(() => {
	restoreEnv();
	globalThis.fetch = originalFetch;
	provider.resetEmbeddingEngineForTests();
	builder.resetTokenizerForTests();
});

describe("embedding 后端解析", () => {
	test("默认 local，且 embeddingModelId/tokenizerId 指向本地模型", () => {
		clearApiEnv();
		assert.equal(provider.embeddingBackend(), "local");
		assert.equal(provider.embeddingModelId(), provider.MODEL_ID);
		assert.equal(provider.embeddingTokenizerId(), provider.MODEL_ID);
		assert.equal(provider.embeddingRuntimeIdentity(), "@xenova/transformers@2.17.2;node");
		assert.equal(provider.embeddingQuantized(), true);
	});

	test("MEMORY_EMBED_PROVIDER=api 时切换到 OpenAI 兼容后端", () => {
		setApiEnv();
		assert.equal(provider.embeddingBackend(), "api");
		assert.equal(provider.embeddingModelId(), "test-embed-model");
		assert.equal(provider.embeddingTokenizerId(), provider.CHAR_APPROX_TOKENIZER_ID);
		assert.match(provider.embeddingRuntimeIdentity(), /openai-compatible-embeddings/);
		assert.equal(provider.embeddingQuantized(), false);
		assert.equal(provider.embeddingNormalize(), true);
		assert.equal(provider.embeddingPooling(), "mean");
	});
});

describe("字符近似 token 计数", () => {
	test("空串为 0，CJK 按字符、ASCII 按 4 字符 1 token", () => {
		assert.equal(builder.approximateTokenCount(""), 0);
		assert.equal(builder.approximateTokenCount("中文"), 2);
		assert.equal(builder.approximateTokenCount("abcd"), 1);
		assert.equal(builder.approximateTokenCount("abcde"), 2);
		assert.equal(builder.approximateTokenCount("你好world"), 4); // 2 CJK + ceil(5/4)
	});
});

describe("API 模式分词器与预算（不依赖 @xenova）", () => {
	test("getTokenizerManifest 返回 char-approx tokenizer_id 与可配置 max tokens", async () => {
		setApiEnv({ MEMORY_EMBED_API_MAX_TOKENS: "128" });
		builder.resetTokenizerForTests();
		const manifest = await builder.getTokenizerManifest();
		assert.equal(manifest.tokenizer_id, provider.CHAR_APPROX_TOKENIZER_ID);
		assert.equal(manifest.model_max_length, 128);
		assert.equal(manifest.special_token_reserve, 0);
	});

	test("buildQueryInput / buildDocumentInput 在 API 模式可用", async () => {
		setApiEnv({ MEMORY_EMBED_API_MAX_TOKENS: "8191" });
		builder.resetTokenizerForTests();
		const query = await builder.buildQueryInput("中文查询 语义检索");
		assert.ok(query.tokens.used <= query.tokens.model_max);
		assert.equal(query.tokens.model_max, 8191);
		const doc = await builder.buildDocumentInput({
			task_desc: "实现嵌入 API",
			result_desc: "用 OpenAI 兼容端点代替本地模型",
			tags: ["embedding"],
			topic_name: "记忆系统",
			turns_text: "一些原文。".repeat(100),
		});
		assert.ok(doc.tokens.used <= doc.tokens.model_max);
		assert.ok(!doc.tokens.truncated);
	});
});

describe("API 编码", () => {
	test("encode/encodeStrict 走 OpenAI 兼容端点并返回向量", async () => {
		setApiEnv();
		provider.resetEmbeddingEngineForTests();
		mockEmbeddingFetch([1, 2, 3]);
		const vector = await provider.encode("任意文本");
		assert.deepEqual(vector, [1, 2, 3]);
		assert.equal(provider.embeddingModeLabel(), "api");
		const strict = await provider.encodeStrict("严格");
		assert.deepEqual(strict, [1, 2, 3]);
	});

	test("无 MEMORY_EMBED_API_DIM 时通过探测得到维度", async () => {
		setApiEnv();
		provider.resetEmbeddingEngineForTests();
		mockEmbeddingFetch([0.1, 0.2, 0.3, 0.4]);
		const dimension = await provider.getEmbeddingDimension();
		assert.equal(dimension, 4);
	});

	test("配置 MEMORY_EMBED_API_DIM 时直接返回，不额外探测", async () => {
		setApiEnv({ MEMORY_EMBED_API_DIM: "7" });
		provider.resetEmbeddingEngineForTests();
		const dimension = await provider.getEmbeddingDimension();
		assert.equal(dimension, 7);
	});

	test("API 调用失败时 encode 回退空向量、encodeStrict 抛错", async () => {
		setApiEnv();
		provider.resetEmbeddingEngineForTests();
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const vector = await provider.encode("任意文本");
		assert.deepEqual(vector, []);
		await assert.rejects(() => provider.encodeStrict("严格"), /network down/);
	});

	test("维度与 MEMORY_EMBED_API_DIM 不符时 encodeStrict 抛错", async () => {
		setApiEnv({ MEMORY_EMBED_API_DIM: "2" });
		provider.resetEmbeddingEngineForTests();
		mockEmbeddingFetch([1, 2, 3]);
		await assert.rejects(() => provider.encodeStrict("严格"), /维度与 MEMORY_EMBED_API_DIM 不符/);
	});
});

describe("API 未配置", () => {
	test("provider=api 但缺 URL/KEY 时进入降级模式", async () => {
		process.env.MEMORY_EMBED_PROVIDER = "api";
		delete process.env.MEMORY_EMBED_API_URL;
		delete process.env.MEMORY_EMBED_API_KEY;
		provider.resetEmbeddingEngineForTests();
		const vector = await provider.encode("任意文本");
		assert.deepEqual(vector, []);
		assert.equal(provider.isFallbackMode(), true);
		assert.equal(provider.embeddingModeLabel(), "fallback");
		await assert.rejects(() => provider.encodeStrict("严格"));
	});
});
