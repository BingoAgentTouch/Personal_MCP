// ============================================================
// Embedding 引擎
//
// 优先级：
//   1. @xenova/transformers (本地 MiniLM，384 维)
//   2. 关键词回退（Jaccard 相似度，无依赖）
//
// 惰性初始化：首次调用 encode() 时才加载模型
// ============================================================

type EncodeFn = (text: string) => Promise<number[]>;

let encodeFn: EncodeFn | null = null;
let initialized = false;
let modelLoadError = false;

/** 尝试加载 transformers.js */
async function tryLoadTransformers(): Promise<EncodeFn | null> {
	try {
		const { pipeline, env } = await import("@xenova/transformers");
		// 允许离线复用本地缓存的模型（.cache/Xenova/all-MiniLM-L6-v2）
		env.allowLocalModels = true;
		const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
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
		console.error(`[embedding] 若为 "fetch failed"：模型未缓存且无法联网。手动放置到 node_modules/@xenova/transformers/.cache/Xenova/all-MiniLM-L6-v2/`);
		return null;
	}
}

/** 初始化 embedding 引擎 */
async function init(): Promise<EncodeFn> {
	if (encodeFn) return encodeFn;

	const fn = await tryLoadTransformers();
	if (fn) {
		encodeFn = fn;
		initialized = true;
		return encodeFn;
	}

	// 回退：关键词 tokenize（简单 Jaccard 不需要 encode function）
	console.error("[embedding] ⚠ 运行在降级模式：memory_search 使用关键词 Jaccard 而非语义向量，召回质量会明显下降。");
	modelLoadError = true;
	initialized = true;
	encodeFn = async (_text: string) => [];
	return encodeFn;
}

/** 编码文本为向量 */
export async function encode(text: string): Promise<number[]> {
	const fn = await init();
	return fn(text);
}

/** 是否在使用回退模式 */
export function isFallbackMode(): boolean {
	return modelLoadError;
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
