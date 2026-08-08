import { createHash } from "node:crypto";
import { AutoTokenizer, env } from "@xenova/transformers";
import { MODEL_ID } from "./provider.js";

export const DOCUMENT_RECIPE_ID = "fragment-structured-budgeted";
export const DOCUMENT_RECIPE_VERSION = 1;
export const MULTIVIEW_DOCUMENT_RECIPE_ID = "fragment-multiview-budgeted";
export const MULTIVIEW_DOCUMENT_RECIPE_VERSION = 1;
export const MULTIVIEW_POLICY_VERSION = 1;
export const MULTIVIEW_AGGREGATION_MODE = "fragment-max-view-v1";
export const MULTIVIEW_EVIDENCE_POLICY_ID = "evidence-gate-candidate-v1";
export const MULTIVIEW_RETRIEVAL_EPOCH = "fragment-multiview-v1";
export const QUERY_RECIPE_ID = "query-plain-normalized";
export const QUERY_RECIPE_VERSION = 1;
export const TOKENIZER_REVISION: string | null = null;

export interface RepresentationManifestLike {
	model_max_length?: number;
	special_token_reserve?: number;
	tokenizer_id?: string;
	tokenizer_revision?: string | null;
	embedding_model_id?: string;
	document_recipe_id?: string;
	document_recipe_version?: number;
	document_policy_version?: number | null;
	query_recipe_id?: string;
	query_recipe_version?: number;
}

export interface DocumentInput {
	task_desc: string;
	result_desc: string;
	tags: string[];
	topic_name: string;
	turns_text: string;
}

export interface BuilderTokens {
	model_max: number;
	reserved_special: number;
	content_budget: number;
	used: number;
	dropped: number;
	truncated: boolean;
	per_field: Record<string, number>;
}

export interface BuiltRepresentation {
	text: string;
	input_hash: string;
	recipe_id: string;
	recipe_version: number;
	tokens: BuilderTokens;
}

export interface MultiViewBuildOptions {
	evidence_window_tokens?: number;
	evidence_overlap_tokens?: number;
	disclosure_snippet_tokens?: number;
}

export interface ViewSourceSpan {
	source_field: "task_desc" | "result_desc" | "tags" | "topic_name" | "turns_text";
	start_char: number;
	end_char: number;
	start_token: number;
	end_token: number;
}

export interface MultiViewTokenDiagnostics extends BuilderTokens {
	source_total_tokens: number;
	source_start_token: number | null;
	source_end_token: number | null;
	window_tokens: number | null;
	overlap_tokens: number;
}

export interface ViewDisclosureMetadata {
	disclosure_level: "T1" | "T2";
	snippet: string;
	snippet_token_count: number;
	snippet_anchor: "view_fallback";
}

export interface BuiltDocumentView {
	view_id: string;
	kind: "summary" | "evidence";
	text: string;
	input_hash: string;
	source_spans: ViewSourceSpan[];
	tokens: MultiViewTokenDiagnostics;
	disclosure: ViewDisclosureMetadata;
}

export const DEFAULT_MULTIVIEW_POLICY = {
	evidence_window_tokens: 288,
	evidence_overlap_tokens: 48,
	disclosure_snippet_tokens: 80,
} as const;

export interface BuiltDocumentViews {
	recipe_id: typeof MULTIVIEW_DOCUMENT_RECIPE_ID;
	recipe_version: typeof MULTIVIEW_DOCUMENT_RECIPE_VERSION;
	policy_version: typeof MULTIVIEW_POLICY_VERSION;
	source_content_hash: string;
	views: BuiltDocumentView[];
	policy: {
		evidence_window_tokens: number;
		evidence_overlap_tokens: number;
		disclosure_snippet_tokens: number;
	};
}

interface TokenizerLike {
	model_max_length?: number;
	(text: string, options?: Record<string, unknown>): { input_ids: { data: ArrayLike<number> } };
	/** @xenova/transformers exposes this internal path for exact no-special-token counts. */
	_encode_text?: (text: string) => unknown[] | null;
}

interface TokenCounter {
	count(text: string, addSpecialTokens?: boolean): number;
	tokenCount(text: string): number;
}

let tokenizerPromise: Promise<TokenizerLike> | null = null;

function normalize(value: string): string {
	if (typeof value !== "string") throw new Error("embedding builder requires string fields");
	return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

export function hashText(text: string): string {
	return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

export function sourceContentHash(input: DocumentInput): string {
	const normalized = normalizedDocument(input);
	return hashText(JSON.stringify(normalized));
}

async function getTokenizer(): Promise<TokenizerLike> {
	if (!tokenizerPromise) {
		tokenizerPromise = (async () => {
			env.allowLocalModels = true;
			env.allowRemoteModels = false;
			return (await AutoTokenizer.from_pretrained(MODEL_ID, { local_files_only: true })) as unknown as TokenizerLike;
		})();
	}
	return tokenizerPromise;
}

export function resetTokenizerForTests(): void {
	tokenizerPromise = null;
}

function createTokenCounter(tokenizer: TokenizerLike): TokenCounter {
	const cache = new Map<string, number>();
	const count = (text: string, addSpecialTokens = true): number => {
		const key = `${addSpecialTokens ? "special" : "content"}:${text}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		let value: number;
		if (!addSpecialTokens && tokenizer._encode_text) {
			const encoded = tokenizer._encode_text(text);
			value = encoded?.length ?? 0;
		} else {
			const encoded = tokenizer(text, { add_special_tokens: addSpecialTokens, truncation: false });
			value = encoded.input_ids.data.length;
		}
		cache.set(key, value);
		return value;
	};
	return {
		count,
		tokenCount: (text: string) => count(text, false),
	};
}

function getBudget(tokenizer: TokenizerLike, counter: TokenCounter, manifest?: RepresentationManifestLike): { max: number; special: number; budget: number } {
	const max = manifest?.model_max_length ?? tokenizer.model_max_length ?? 512;
	const measuredSpecial = counter.count("", true);
	const special = manifest?.special_token_reserve ?? measuredSpecial;
	if (!Number.isInteger(max) || max < 1 || !Number.isInteger(special) || special < 0 || special >= max) {
		throw new Error(`invalid tokenizer budget: max=${max}, special=${special}`);
	}
	return { max, special, budget: max - special };
}

function validateMultiViewManifest(manifest: RepresentationManifestLike | undefined, tokenizer: TokenizerLike, actual: { max: number; special: number }): void {
	if (!manifest) return;
	if (manifest.document_recipe_id !== MULTIVIEW_DOCUMENT_RECIPE_ID) {
		throw new Error(`multiview builder requires recipe ${MULTIVIEW_DOCUMENT_RECIPE_ID}`);
	}
	if (manifest.document_recipe_version !== MULTIVIEW_DOCUMENT_RECIPE_VERSION) {
		throw new Error(`multiview builder requires recipe version ${MULTIVIEW_DOCUMENT_RECIPE_VERSION}`);
	}
	if (manifest.document_policy_version !== MULTIVIEW_POLICY_VERSION) {
		throw new Error(`multiview builder requires policy version ${MULTIVIEW_POLICY_VERSION}`);
	}
	if (manifest.embedding_model_id !== undefined && manifest.embedding_model_id !== MODEL_ID) {
		throw new Error(`multiview builder requires model ${MODEL_ID}`);
	}
	if (manifest.tokenizer_id !== undefined && manifest.tokenizer_id !== MODEL_ID) {
		throw new Error(`multiview builder requires tokenizer ${MODEL_ID}`);
	}
	if (manifest.tokenizer_revision !== undefined && manifest.tokenizer_revision !== TOKENIZER_REVISION) {
		throw new Error(`multiview builder tokenizer revision mismatch`);
	}
	if (manifest.model_max_length !== undefined && manifest.model_max_length !== actual.max) {
		throw new Error(`multiview builder model_max_length mismatch`);
	}
	if (manifest.special_token_reserve !== undefined && manifest.special_token_reserve !== actual.special) {
		throw new Error(`multiview builder special_token_reserve mismatch`);
	}
	if (tokenizer.model_max_length !== undefined && tokenizer.model_max_length !== actual.max) {
		throw new Error(`multiview tokenizer model_max_length is inconsistent`);
	}
}

interface Field {
	name: string;
	value: string;
}

function render(fields: Field[]): string {
	return fields
		.filter((field) => field.value.length > 0)
		.map((field) => `${field.name}: ${field.value}`)
		.join("\n");
}

function codePoints(value: string): string[] {
	return Array.from(value);
}

function fitPrefix(
	fields: Field[],
	fieldIndex: number,
	value: string,
	counter: TokenCounter,
	budget: number,
): string {
	if (!value) return "";
	const full = [...fields];
	full[fieldIndex] = { ...full[fieldIndex], value };
	if ((counter.count(render(full))) <= budget) return value;
	const points = codePoints(value);
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = points.slice(0, mid).join("");
		const trial = [...fields];
		trial[fieldIndex] = { ...trial[fieldIndex], value: candidate };
		if ((counter.count(render(trial))) <= budget) low = mid;
		else high = mid - 1;
	}
	return points.slice(0, low).join("");
}

function fitHeadTail(
	fields: Field[],
	fieldIndex: number,
	value: string,
	counter: TokenCounter,
	budget: number,
): string {
	if (!value) return "";
	const points = codePoints(value);
	const marker = "[…]";
	const candidate = (keep: number): string => {
		if (keep >= points.length) return value;
		if (keep === 0) return "";
		const headCount = Math.ceil(keep / 2);
		const tailCount = keep - headCount;
		return `${points.slice(0, headCount).join("")}${marker}${tailCount ? points.slice(-tailCount).join("") : ""}`;
	};
	const full = [...fields];
	full[fieldIndex] = { ...full[fieldIndex], value };
	if ((counter.count(render(full))) <= budget) return value;
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const trial = [...fields];
		trial[fieldIndex] = { ...trial[fieldIndex], value: candidate(mid) };
		if ((counter.count(render(trial))) <= budget) low = mid;
		else high = mid - 1;
	}
	return candidate(low);
}

function normalizedDocument(input: DocumentInput): DocumentInput {
	return {
		task_desc: normalize(input.task_desc),
		result_desc: normalize(input.result_desc),
		tags: input.tags.map(normalize).filter(Boolean),
		topic_name: normalize(input.topic_name),
		turns_text: normalize(input.turns_text),
	};
}

function normalizedViewFields(input: DocumentInput): Field[] {
	return [
		{ name: "结论", value: input.result_desc },
		{ name: "任务", value: input.task_desc },
		{ name: "标签", value: [...input.tags, input.topic_name].filter(Boolean).join(" ") },
	];
}

function summarySourceSpans(input: DocumentInput, counter: TokenCounter): ViewSourceSpan[] {
	const fields: Array<{ source_field: ViewSourceSpan["source_field"]; value: string }> = [
		{ source_field: "result_desc", value: input.result_desc },
		{ source_field: "task_desc", value: input.task_desc },
		{ source_field: "tags", value: input.tags.join(" ") },
		{ source_field: "topic_name", value: input.topic_name },
	];
	return fields
		.filter((field) => field.value.length > 0)
		.map((field) => ({
			source_field: field.source_field,
			start_char: 0,
			end_char: field.value.length,
			start_token: 0,
			end_token: counter.tokenCount(field.value),
		}));
}

function validateMultiViewOptions(options: Required<MultiViewBuildOptions>): void {
	if (!Number.isInteger(options.evidence_window_tokens) || options.evidence_window_tokens <= 0) throw new Error("evidence_window_tokens must be a positive integer");
	if (!Number.isInteger(options.evidence_overlap_tokens) || options.evidence_overlap_tokens < 0 || options.evidence_overlap_tokens >= options.evidence_window_tokens) {
		throw new Error("evidence_overlap_tokens must be an integer smaller than evidence_window_tokens");
	}
	if (!Number.isInteger(options.disclosure_snippet_tokens) || options.disclosure_snippet_tokens <= 0) throw new Error("disclosure_snippet_tokens must be a positive integer");
}

function resolveMultiViewOptions(options?: MultiViewBuildOptions): Required<MultiViewBuildOptions> {
	const resolved = {
		evidence_window_tokens: options?.evidence_window_tokens ?? DEFAULT_MULTIVIEW_POLICY.evidence_window_tokens,
		evidence_overlap_tokens: options?.evidence_overlap_tokens ?? DEFAULT_MULTIVIEW_POLICY.evidence_overlap_tokens,
		disclosure_snippet_tokens: options?.disclosure_snippet_tokens ?? DEFAULT_MULTIVIEW_POLICY.disclosure_snippet_tokens,
	};
	validateMultiViewOptions(resolved);
	return resolved;
}

class PrefixBoundaryResolver {
	private readonly points: string[];
	private readonly boundaries = new Map<number, number>();

	constructor(private readonly value: string, private readonly counter: TokenCounter) {
		this.points = Array.from(value);
		this.boundaries.set(0, 0);
	}

	find(targetTokens: number): number {
		if (!Number.isInteger(targetTokens) || targetTokens < 0) throw new Error("prefix token target must be a non-negative integer");
		const cached = this.boundaries.get(targetTokens);
		if (cached !== undefined) return cached;
		let low = 0;
		let high = this.points.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			const candidate = this.points.slice(0, mid).join("");
			if (this.counter.tokenCount(candidate) <= targetTokens) low = mid;
			else high = mid - 1;
		}
		const boundary = this.points.slice(0, low).join("").length;
		this.boundaries.set(targetTokens, boundary);
		return boundary;
	}
}

function renderWithinBudget(fields: Field[], counter: TokenCounter, max: number): { text: string; used: number } {
	const text = render(fields);
	const used = counter.count(text);
	if (used > max) throw new Error(`multiview input exceeds model max length: ${used} > ${max}`);
	return { text, used };
}

function fixedSnippet(value: string, tokenLimit: number, counter: TokenCounter, resolver?: PrefixBoundaryResolver): { text: string; tokens: number } {
	if (!value) return { text: "", tokens: 0 };
	const total = counter.tokenCount(value);
	const target = Math.min(total, tokenLimit);
	const end = target >= total ? value.length : (resolver ?? new PrefixBoundaryResolver(value, counter)).find(target);
	const text = value.slice(0, end);
	return { text, tokens: counter.tokenCount(text) };
}

export async function buildDocumentViews(input: DocumentInput, manifest?: RepresentationManifestLike, options?: MultiViewBuildOptions): Promise<BuiltDocumentViews> {
	const tokenizer = await getTokenizer();
	const counter = createTokenCounter(tokenizer);
	const measured = { max: tokenizer.model_max_length ?? 512, special: counter.count("", true) };
	const { max, special, budget } = getBudget(tokenizer, counter, manifest);
	validateMultiViewManifest(manifest, tokenizer, measured);
	const policy = resolveMultiViewOptions(options);
	const normalized = normalizedDocument(input);
	const sourceContentHashValue = hashText(JSON.stringify(normalized));
	const views: BuiltDocumentView[] = [];
	const summaryFields = normalizedViewFields(normalized);
	const summaryText = render(summaryFields);
	const summaryUsed = counter.count(summaryText);
	if (summaryUsed > max) throw new Error(`multiview summary exceeds model max length: ${summaryUsed} > ${max}`);
	const summaryResolver = new PrefixBoundaryResolver(summaryText, counter);
	const summarySnippet = fixedSnippet(summaryText, policy.disclosure_snippet_tokens, counter, summaryResolver);
	views.push({
		view_id: "summary",
		kind: "summary",
		text: summaryText,
		input_hash: hashText(summaryText),
		source_spans: summarySourceSpans(normalized, counter),
		tokens: {
			model_max: max,
			reserved_special: special,
			content_budget: budget,
			used: summaryUsed,
			dropped: 0,
			truncated: false,
			per_field: Object.fromEntries(summaryFields.map((field) => [field.name, field.value ? counter.tokenCount(field.value) : 0])),
			source_total_tokens: summaryUsed,
			source_start_token: null,
			source_end_token: null,
			window_tokens: null,
			overlap_tokens: 0,
		},
		disclosure: {
			disclosure_level: "T1",
			snippet: summarySnippet.text,
			snippet_token_count: summarySnippet.tokens,
			snippet_anchor: "view_fallback",
		},
	});
	if (!normalized.turns_text) return { recipe_id: MULTIVIEW_DOCUMENT_RECIPE_ID, recipe_version: MULTIVIEW_DOCUMENT_RECIPE_VERSION, policy_version: MULTIVIEW_POLICY_VERSION, source_content_hash: sourceContentHashValue, views, policy };
	const totalTokens = counter.tokenCount(normalized.turns_text);
	const sourceResolver = new PrefixBoundaryResolver(normalized.turns_text, counter);
	const labelTokens = counter.tokenCount("原文: ");
	const effectiveWindowTokens = Math.min(policy.evidence_window_tokens, budget - labelTokens);
	if (effectiveWindowTokens <= 0) throw new Error("multiview evidence window does not fit the model budget");
	if (policy.evidence_overlap_tokens >= effectiveWindowTokens) throw new Error("evidence_overlap_tokens must be smaller than the effective evidence window");
	const step = effectiveWindowTokens - policy.evidence_overlap_tokens;
	if (step <= 0) throw new Error("multiview evidence window step must be positive");
	let startToken = 0;
	let ordinal = 1;
	while (startToken < totalTokens) {
		const endToken = Math.min(totalTokens, startToken + effectiveWindowTokens);
		const startChar = sourceResolver.find(startToken);
		const endChar = endToken >= totalTokens ? normalized.turns_text.length : sourceResolver.find(endToken);
		const sourceText = normalized.turns_text.slice(startChar, endChar);
		const rendered = await renderWithinBudget([{ name: "原文", value: sourceText }], counter, max);
		const snippet = await fixedSnippet(sourceText, policy.disclosure_snippet_tokens, counter);
		const viewId = `evidence_${String(ordinal).padStart(3, "0")}`;
		views.push({
			view_id: viewId,
			kind: "evidence",
			text: rendered.text,
			input_hash: hashText(rendered.text),
			source_spans: [{ source_field: "turns_text", start_char: startChar, end_char: endChar, start_token: startToken, end_token: endToken }],
			tokens: {
				model_max: max,
				reserved_special: special,
				content_budget: budget,
				used: rendered.used,
				dropped: Math.max(0, totalTokens - (endToken - startToken)),
				truncated: endToken - startToken < totalTokens,
				per_field: { 原文: counter.tokenCount(rendered.text) },
				source_total_tokens: totalTokens,
				source_start_token: startToken,
				source_end_token: endToken,
				window_tokens: endToken - startToken,
				overlap_tokens: ordinal === 1 ? 0 : policy.evidence_overlap_tokens,
			},
			disclosure: {
				disclosure_level: "T2",
				snippet: snippet.text,
				snippet_token_count: snippet.tokens,
				snippet_anchor: "view_fallback",
			},
		});
		if (endToken >= totalTokens) break;
		startToken += step;
		ordinal += 1;
	}
	return { recipe_id: MULTIVIEW_DOCUMENT_RECIPE_ID, recipe_version: MULTIVIEW_DOCUMENT_RECIPE_VERSION, policy_version: MULTIVIEW_POLICY_VERSION, source_content_hash: sourceContentHashValue, views, policy };
}

export async function buildDocumentInput(input: DocumentInput, manifest?: RepresentationManifestLike): Promise<BuiltRepresentation> {
	const tokenizer = await getTokenizer();
	const counter = createTokenCounter(tokenizer);
	const { max, special, budget } = getBudget(tokenizer, counter, manifest);
	const normalized = normalizedDocument(input);
	const fields: Field[] = [
		{ name: "结论", value: normalized.result_desc },
		{ name: "任务", value: normalized.task_desc },
		{ name: "标签", value: [...normalized.tags, normalized.topic_name].filter(Boolean).join(" ") },
		{ name: "原文", value: normalized.turns_text },
	];
	const built: Field[] = fields.map((field) => ({ ...field, value: "" }));
	for (let i = 0; i < fields.length - 1; i++) {
		built[i].value = fitPrefix(built, i, fields[i].value, counter, budget);
	}
	built[fields.length - 1].value = fitHeadTail(built, fields.length - 1, fields[fields.length - 1].value, counter, budget);
	let text = render(built);
	let used = await counter.count(text);
	if (used > max) throw new Error(`embedding input exceeds model max length: ${used} > ${max}`);
	const perField: Record<string, number> = {};
	for (const field of built) perField[field.name] = field.value ? counter.tokenCount(`${field.name}: ${field.value}`) : 0;
	const originalText = render(fields);
	const originalTokens = counter.count(originalText);
	const dropped = Math.max(0, originalTokens - used);
	return {
		text,
		input_hash: hashText(text),
		recipe_id: manifest?.document_recipe_id ?? DOCUMENT_RECIPE_ID,
		recipe_version: manifest?.document_recipe_version ?? DOCUMENT_RECIPE_VERSION,
		tokens: {
			model_max: max,
			reserved_special: special,
			content_budget: budget,
			used,
			dropped,
			truncated: text !== originalText,
			per_field: perField,
		},
	};
}

export async function buildQueryInput(query: string, manifest?: RepresentationManifestLike): Promise<BuiltRepresentation> {
	const tokenizer = await getTokenizer();
	const counter = createTokenCounter(tokenizer);
	const { max, special, budget } = getBudget(tokenizer, counter, manifest);
	const normalized = normalize(query);
	const fields: Field[] = [{ name: "查询", value: normalized }];
	const value = fitPrefix(fields, 0, normalized, counter, budget);
	const text = render([{ name: "查询", value }]);
	const used = await counter.count(text);
	if (used > max) throw new Error(`query input exceeds model max length: ${used} > ${max}`);
	return {
		text,
		input_hash: hashText(text),
		recipe_id: manifest?.query_recipe_id ?? QUERY_RECIPE_ID,
		recipe_version: manifest?.query_recipe_version ?? QUERY_RECIPE_VERSION,
		tokens: {
			model_max: max,
			reserved_special: special,
			content_budget: budget,
			used,
			dropped: Math.max(0, counter.count(`查询: ${normalized}`) - used),
			truncated: value !== normalized,
			per_field: { 查询: counter.tokenCount(text) },
		},
	};
}

export async function getTokenizerManifest(): Promise<{
	tokenizer_id: string;
	tokenizer_revision: string | null;
	model_max_length: number;
	special_token_reserve: number;
}> {
	const tokenizer = await getTokenizer();
	const counter = createTokenCounter(tokenizer);
	const max = tokenizer.model_max_length ?? 512;
	const special = counter.count("", true);
	return { tokenizer_id: MODEL_ID, tokenizer_revision: TOKENIZER_REVISION, model_max_length: max, special_token_reserve: special };
}
