// ============================================================
// Embedding 引擎
//
// 后端（由 MEMORY_EMBED_PROVIDER 决定，默认 local）：
//   1. local：@xenova/transformers 本地多语言 MiniLM（384 维）
//   2. api  ：OpenAI 兼容 /v1/embeddings HTTP 调用，无需下载本地模型
//   3. 关键词回退（Jaccard 相似度，无依赖）——两个后端都不可用时的兜底
//
// 惰性初始化：首次调用 encode() 时才加载模型 / 建立 API 客户端
//
// 本地模型：默认 paraphrase-multilingual-MiniLM-L12-v2（多语言，中文检索
// 排序正确；原 all-MiniLM-L6-v2 是英文模型，中文语义排序会倒挂）。
// 同为 384 维，drop-in 替换。可用环境变量 MEMORY_EMBED_MODEL 覆盖。
//
// API 模式环境变量：
//   MEMORY_EMBED_PROVIDER=api
//   MEMORY_EMBED_API_URL         必填，含 /v1 的 base URL（如 https://api.openai.com/v1）
//   MEMORY_EMBED_API_KEY         必填，Bearer token
//   MEMORY_EMBED_API_MODEL       可选，默认 text-embedding-3-small
//   MEMORY_EMBED_API_MAX_TOKENS  可选，默认 8191，用于文档预算截断
//   MEMORY_EMBED_API_DIM         可选，固定维度；缺省则首次编码时自动探测
// ============================================================

/** 本地 embedding 模型 ID，可用环境变量 MEMORY_EMBED_MODEL 覆盖 */
export const MODEL_ID = process.env.MEMORY_EMBED_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

/** API 模式下 tokenizer_id 的稳定标识（字符近似计数，与具体 API 模型无关） */
export const CHAR_APPROX_TOKENIZER_ID = "char-approx-v1";

type EncodeFn = (text: string) => Promise<number[]>;

function parsePositiveInt(value: string | undefined, fallback: number | null): number | null {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface ApiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	maxTokens: number;
	dimension: number | null;
}

function apiConfig(): ApiConfig {
	const maxTokens = parsePositiveInt(process.env.MEMORY_EMBED_API_MAX_TOKENS, 8191);
	return {
		baseUrl: process.env.MEMORY_EMBED_API_URL ?? "",
		apiKey: process.env.MEMORY_EMBED_API_KEY ?? "",
		model: process.env.MEMORY_EMBED_API_MODEL || "text-embedding-3-small",
		maxTokens: maxTokens ?? 8191,
		dimension: parsePositiveInt(process.env.MEMORY_EMBED_API_DIM, null),
	};
}

export type EmbeddingBackend = "local" | "api";

/** 当前 embedding 后端（每次从环境变量解析，不缓存，便于测试切换） */
export function embeddingBackend(): EmbeddingBackend {
	return (process.env.MEMORY_EMBED_PROVIDER ?? "").trim().toLowerCase() === "api" ? "api" : "local";
}

/** 写入 generation manifest 的 embedding_model_id */
export function embeddingModelId(): string {
	return embeddingBackend() === "api" ? apiConfig().model : MODEL_ID;
}

/** 写入 generation manifest 的 tokenizer_id */
export function embeddingTokenizerId(): string {
	return embeddingBackend() === "api" ? CHAR_APPROX_TOKENIZER_ID : MODEL_ID;
}

/** 写入 generation manifest 的 runtime_identity */
export function embeddingRuntimeIdentity(): string {
	return embeddingBackend() === "api" ? "openai-compatible-embeddings-v1;node" : "@xenova/transformers@2.17.2;node";
}

export function embeddingPooling(): "mean" {
	return "mean";
}

export function embeddingNormalize(): boolean {
	return true;
}

export function embeddingQuantized(): boolean {
	return embeddingBackend() !== "api";
}

/** API 模式下的模型最大输入 token 数（字符近似计数器的 model_max_length） */
export function apiMaxTokens(): number {
	return apiConfig().maxTokens;
}

let rawEncodeFn: EncodeFn | null = null;
let fallbackActive = false;
let initPromise: Promise<void> | null = null;
let probedApiDimension: number | null = null;

/** 尝试加载 transformers.js 本地模型 */
async function tryLoadTransformers(): Promise<EncodeFn | null> {
	try {
		const { pipeline, env } = await import("@xenova/transformers");
		// 允许离线复用本地缓存的模型（.cache/Xenova/<MODEL_ID>）
		env.allowLocalModels = true;
		const extractor = await pipeline("feature-extraction", MODEL_ID, {
			quantized: true,
		});
		return async (text: string): Promise<number[]> => {
			const result = await extractor(text, { pooling: "mean", normalize: true });
			return Array.from(result.data as Float32Array);
		};
	} catch (err) {
		// 不再静默吞掉：把真实原因打到 stderr，否则会伪装成「正常」跑降级模式
		const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		console.error(`[embedding] MiniLM 模型加载失败，退回关键词 Jaccard 模式。真实原因: ${msg}`);
		console.error(`[embedding] 若为 "fetch failed"：模型未缓存且无法联网。手动放置到 node_modules/@xenova/transformers/.cache/${MODEL_ID}/`);
		return null;
	}
}

/** OpenAI 兼容 /v1/embeddings 编码（失败抛错，由上层决定降级或直接失败） */
async function apiEncode(text: string): Promise<number[]> {
	const config = apiConfig();
	if (!config.baseUrl || !config.apiKey) {
		throw new Error("embedding API 未配置：请设置 MEMORY_EMBED_API_URL 与 MEMORY_EMBED_API_KEY");
	}
	const trimmed = config.baseUrl.replace(/\/+$/, "");
	const endpoint = trimmed.endsWith("/embeddings") ? trimmed : `${trimmed}/embeddings`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
		},
		body: JSON.stringify({ model: config.model, input: text }),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`embedding API 请求失败 ${response.status}: ${body.slice(0, 300)}`);
	}
	const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
	const vector = payload.data?.[0]?.embedding;
	if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
		throw new Error("embedding API 返回了非法向量");
	}
	if (probedApiDimension === null) {
		probedApiDimension = vector.length;
	} else if (vector.length !== probedApiDimension) {
		throw new Error(`embedding API 维度漂移：期望 ${probedApiDimension}，实际 ${vector.length}`);
	}
	if (config.dimension !== null && vector.length !== config.dimension) {
		throw new Error(`embedding API 维度与 MEMORY_EMBED_API_DIM 不符：期望 ${config.dimension}，实际 ${vector.length}`);
	}
	return vector;
}

async function ensureInit(): Promise<void> {
	if (rawEncodeFn || fallbackActive) return;
	if (!initPromise) {
		initPromise = (async () => {
			if (embeddingBackend() === "api") {
				const config = apiConfig();
				if (!config.baseUrl || !config.apiKey) {
					fallbackActive = true;
					console.error("[embedding] ⚠ 已选择 API 模式但未配置 MEMORY_EMBED_API_URL / MEMORY_EMBED_API_KEY，运行在关键词 Jaccard 降级模式。");
					return;
				}
				rawEncodeFn = apiEncode;
				return;
			}
			const fn = await tryLoadTransformers();
			if (fn) {
				rawEncodeFn = fn;
			} else {
				fallbackActive = true;
				console.error("[embedding] ⚠ 运行在降级模式：memory_search 使用关键词 Jaccard 而非语义向量，召回质量会明显下降。");
			}
		})();
	}
	await initPromise;
}

/** 编码文本为向量（宽容：后端不可用或调用失败时返回空向量，检索侧据此回退 Jaccard） */
export async function encode(text: string): Promise<number[]> {
	await ensureInit();
	if (!rawEncodeFn) return [];
	try {
		return await rawEncodeFn(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[embedding] 编码失败，本次检索回退关键词模式：${msg}`);
		return [];
	}
}

/** 严格 dense 编码：迁移、回填和 generation 构建禁止回退，调用失败即抛错。 */
export async function encodeStrict(text: string): Promise<number[]> {
	await ensureInit();
	if (!rawEncodeFn) {
		throw new Error("strict embedding encode failed: dense model unavailable or vector invalid");
	}
	const vector = await rawEncodeFn(text);
	if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
		throw new Error("strict embedding encode failed: dense model unavailable or vector invalid");
	}
	return vector;
}

/** 是否在使用回退模式 */
export function isFallbackMode(): boolean {
	return fallbackActive;
}

/** embedding 模式标签（用于 create_fragment 返回值） */
export function embeddingModeLabel(): string {
	if (isFallbackMode()) return "fallback";
	return embeddingBackend() === "api" ? "api" : "transformers";
}

/** 当前后端维度：local 固定 384；api 用 MEMORY_EMBED_API_DIM 或首次编码探测。 */
export async function getEmbeddingDimension(): Promise<number> {
	if (embeddingBackend() === "api") {
		const config = apiConfig();
		if (config.dimension !== null) return config.dimension;
		if (probedApiDimension !== null) return probedApiDimension;
		const probe = await encodeStrict("维度探测");
		return probe.length;
	}
	return 384;
}

/** 重置惰性初始化状态（仅测试用） */
export function resetEmbeddingEngineForTests(): void {
	rawEncodeFn = null;
	fallbackActive = false;
	initPromise = null;
	probedApiDimension = null;
}

/** 余弦相似度 */
export function cosine(a: number[], b: number[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	if (a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

// ============================================================
// 回退方案：关键词 Jaccard 相似度
// ============================================================

/** 简单中文/英文分词 */
function tokenize(text: string): Set<string> {
	// 提取中文字符 + 英文单词
	const tokens = new Set<string>();
	// 中文：单字 + 双字组合
	const chineseChars = text.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i < chineseChars.length; i++) {
		tokens.add(chineseChars[i]);
		if (i < chineseChars.length - 1) {
			tokens.add(chineseChars[i] + chineseChars[i + 1]);
		}
	}
	// 英文：按词分割
	const englishWords = text.match(/[a-zA-Z_]\w*/g) ?? [];
	for (const w of englishWords) {
		tokens.add(w.toLowerCase());
	}
	return tokens;
}

/** Jaccard 相似度 */
export function jaccardSimilarity(textA: string, textB: string): number {
	const a = tokenize(textA);
	const b = tokenize(textB);
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
