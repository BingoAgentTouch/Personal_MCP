import { createHash } from "node:crypto";
import { AutoTokenizer, env } from "@xenova/transformers";
import { MODEL_ID } from "./provider.js";

export const DOCUMENT_RECIPE_ID = "fragment-structured-budgeted";
export const DOCUMENT_RECIPE_VERSION = 1;
export const QUERY_RECIPE_ID = "query-plain-normalized";
export const QUERY_RECIPE_VERSION = 1;
export const TOKENIZER_REVISION: string | null = null;

export interface RepresentationManifestLike {
	model_max_length?: number;
	special_token_reserve?: number;
	tokenizer_id?: string;
	document_recipe_id?: string;
	document_recipe_version?: number;
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

interface TokenizerLike {
	model_max_length?: number;
	(text: string, options?: Record<string, unknown>): { input_ids: { data: ArrayLike<number> } };
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

async function tokenizerStats(text: string, tokenizer: TokenizerLike, addSpecialTokens = true): Promise<number> {
	const encoded = tokenizer(text, { add_special_tokens: addSpecialTokens, truncation: false });
	return encoded.input_ids.data.length;
}

async function getBudget(tokenizer: TokenizerLike, manifest?: RepresentationManifestLike): Promise<{ max: number; special: number; budget: number }> {
	const max = manifest?.model_max_length ?? tokenizer.model_max_length ?? 512;
	const measuredSpecial = await tokenizerStats("", tokenizer, true);
	const special = manifest?.special_token_reserve ?? measuredSpecial;
	if (!Number.isInteger(max) || max < 1 || !Number.isInteger(special) || special < 0 || special >= max) {
		throw new Error(`invalid tokenizer budget: max=${max}, special=${special}`);
	}
	return { max, special, budget: max - special };
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

async function fitPrefix(
	fields: Field[],
	fieldIndex: number,
	value: string,
	tokenizer: TokenizerLike,
	budget: number,
): Promise<string> {
	if (!value) return "";
	const full = [...fields];
	full[fieldIndex] = { ...full[fieldIndex], value };
	if ((await tokenizerStats(render(full), tokenizer)) <= budget) return value;
	const points = codePoints(value);
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = points.slice(0, mid).join("");
		const trial = [...fields];
		trial[fieldIndex] = { ...trial[fieldIndex], value: candidate };
		if ((await tokenizerStats(render(trial), tokenizer)) <= budget) low = mid;
		else high = mid - 1;
	}
	return points.slice(0, low).join("");
}

async function fitHeadTail(
	fields: Field[],
	fieldIndex: number,
	value: string,
	tokenizer: TokenizerLike,
	budget: number,
): Promise<string> {
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
	if ((await tokenizerStats(render(full), tokenizer)) <= budget) return value;
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const trial = [...fields];
		trial[fieldIndex] = { ...trial[fieldIndex], value: candidate(mid) };
		if ((await tokenizerStats(render(trial), tokenizer)) <= budget) low = mid;
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

export async function buildDocumentInput(input: DocumentInput, manifest?: RepresentationManifestLike): Promise<BuiltRepresentation> {
	const tokenizer = await getTokenizer();
	const { max, special, budget } = await getBudget(tokenizer, manifest);
	const normalized = normalizedDocument(input);
	const fields: Field[] = [
		{ name: "结论", value: normalized.result_desc },
		{ name: "任务", value: normalized.task_desc },
		{ name: "标签", value: [...normalized.tags, normalized.topic_name].filter(Boolean).join(" ") },
		{ name: "原文", value: normalized.turns_text },
	];
	const built: Field[] = fields.map((field) => ({ ...field, value: "" }));
	for (let i = 0; i < fields.length - 1; i++) {
		built[i].value = await fitPrefix(built, i, fields[i].value, tokenizer, budget);
	}
	built[fields.length - 1].value = await fitHeadTail(built, fields.length - 1, fields[fields.length - 1].value, tokenizer, budget);
	let text = render(built);
	let used = await tokenizerStats(text, tokenizer);
	if (used > max) throw new Error(`embedding input exceeds model max length: ${used} > ${max}`);
	const perField: Record<string, number> = {};
	for (const field of built) perField[field.name] = field.value ? await tokenizerStats(`${field.name}: ${field.value}`, tokenizer, false) : 0;
	const originalText = render(fields);
	const originalTokens = await tokenizerStats(originalText, tokenizer);
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
	const { max, special, budget } = await getBudget(tokenizer, manifest);
	const normalized = normalize(query);
	const fields: Field[] = [{ name: "查询", value: normalized }];
	const value = await fitPrefix(fields, 0, normalized, tokenizer, budget);
	const text = render([{ name: "查询", value }]);
	const used = await tokenizerStats(text, tokenizer);
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
			dropped: Math.max(0, (await tokenizerStats(`查询: ${normalized}`, tokenizer)) - used),
			truncated: value !== normalized,
			per_field: { 查询: await tokenizerStats(text, tokenizer, false) },
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
	const max = tokenizer.model_max_length ?? 512;
	const special = await tokenizerStats("", tokenizer, true);
	return { tokenizer_id: MODEL_ID, tokenizer_revision: TOKENIZER_REVISION, model_max_length: max, special_token_reserve: special };
}
