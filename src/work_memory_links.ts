// ============================================================
// work_memory 联想链（持久层索引）
//
// 链文件 memory/work_memory_links.json：
//   {
//     "version": 1,
//     "built_at": "...",
//     "source_fingerprint": "...",
//     "links": { "<fragment_id>": ["<fragment_id>", ...] }   // 有向出边，≤ 2
//   }
//
// 读（通道⓪ 扩散）：loadLinks / readLinkFile —— 容错：文件不存在/损坏 → 空。
// 建（阶段二 headless 异步）：buildLinksAsync —— spawn headless，LLM 只输出
//   links 对象到 stdout，服务端收集 → 提取 JSON → 校验/规范化 → 补元数据落盘。
//   元数据（version/built_at/source_fingerprint）由服务端填充，不信任 LLM。
// ============================================================
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export interface LinkFile {
	version: number;
	built_at: string;
	source_fingerprint: string;
	links: Record<string, string[]>;
}

/** 链文件路径（相对 CWD，与 memory/ 数据根一致） */
export const LINKS_PATH = path.resolve("memory/work_memory_links.json");

/** headless 调用版本锁（P0-2；升级需重跑 §8.4 前置验证） */
export const DSH_VERSION = "0.1.0-rc.6";

/**
 * 建链用模型（阶段二 headless）：默认用更快、不思考的 deepseek-v4-flash + off，
 * 因为建链只需两两「强相关」判断，不需要深度推理；pro+high 会拖慢 O(N²) 比较。
 * 可用环境变量覆盖（与 MEMORY_DSH_BIN 同风格）。
 */
export const BUILD_PROVIDER = process.env.MEMORY_BUILD_PROVIDER ?? "deepseek-official";
export const BUILD_MODEL = process.env.MEMORY_BUILD_MODEL ?? "deepseek-v4-flash";
export const BUILD_REASONING_EFFORT = process.env.MEMORY_BUILD_REASONING_EFFORT ?? "off";

// ------------------------------------------------------------
// 读（通道⓪）
// ------------------------------------------------------------

/** 读整个链文件；文件不存在/损坏/结构非法 → null（best-effort，不阻断） */
export function readLinkFile(): LinkFile | null {
	try {
		if (!fs.existsSync(LINKS_PATH)) return null;
		const raw = fs.readFileSync(LINKS_PATH, "utf8");
		const data = JSON.parse(raw) as LinkFile;
		if (typeof data !== "object" || data === null) return null;
		if (typeof data.links !== "object" || data.links === null || Array.isArray(data.links)) return null;
		return data;
	} catch (err) {
		console.error("[work_memory_links] 读链文件失败：", (err as Error)?.message ?? err);
		return null;
	}
}

/**
 * 查询某条目的直接出边邻居（深度=1：只返回直接邻居，不递归）。
 * 文件不存在 / 条目无出边 / 值为非字符串 → 空数组。
 */
export function loadLinks(fragmentId: string): string[] {
	const file = readLinkFile();
	if (!file) return [];
	const out = file.links[fragmentId];
	if (!Array.isArray(out)) return [];
	return out.filter((x): x is string => typeof x === "string");
}

// ------------------------------------------------------------
// 建（阶段二 headless 异步）—— 纯函数部分可单测
// ------------------------------------------------------------

/** 内容指纹（§7.2）：条目 fragment_id 有序列表的 sha256。防重不用 mtime。 */
export function computeFingerprint(ids: string[]): string {
	return "sha256:" + createHash("sha256").update(ids.join("\n")).digest("hex");
}

/**
 * 从 LLM 的 stdout 里提取一个 JSON 对象（容错：直接解析 → markdown 围栏剥离
 * → 提取最外层 {...}）。全失败返回 null。
 */
export function extractJsonObject(text: string): unknown {
	const t = text.trim();
	try {
		return JSON.parse(t);
	} catch {
		/* 继续 */
	}
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fence) {
		try {
			return JSON.parse(fence[1].trim());
		} catch {
			/* 继续 */
		}
	}
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(t.slice(start, end + 1));
		} catch {
			/* 继续 */
		}
	}
	return null;
}

/**
 * 把 LLM 输出的 links 规范化为可信结构：
 * - 只保留键/值都在 validIds 内的条目（防 LLM 编造 fragment_id）；
 * - 值必须是字符串数组，过滤非法项、排除自环；
 * - 出度强制 ≤ 2（LLM 超规则时截断，宽容优于丢弃）；
 * - 无出边的条目省略。
 * 输入不是对象 → null。
 */
export function normalizeLinks(raw: unknown, validIds: Set<string>): Record<string, string[]> | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const out: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!validIds.has(k)) continue;
		if (!Array.isArray(v)) continue;
		// 宽容：值既可能是 fragment_id 字符串数组（规范），也可能是 LLM 误输出的
		// [{fragment_id: "..."}] 对象数组（flash 常见），统一抽成字符串。
		const vals: string[] = [];
		for (const x of v) {
			const id = toFragmentId(x);
			if (id !== null && validIds.has(id) && id !== k) vals.push(id);
		}
		if (vals.length === 0) continue;
		out[k] = vals.slice(0, 2);
	}
	return out;
}

/** 把 LLM 输出的一条「指向」抽成 fragment_id 字符串：字符串直取，对象取 .fragment_id，其余 null。 */
function toFragmentId(x: unknown): string | null {
	if (typeof x === "string") return x;
	if (typeof x === "object" && x !== null) {
		const fid = (x as { fragment_id?: unknown }).fragment_id;
		if (typeof fid === "string") return fid;
	}
	return null;
}

/** 服务端落盘：补元数据（version/built_at/source_fingerprint），原子写（tmp+rename） */
export function writeLinkFile(links: Record<string, string[]>, fingerprint: string): void {
	const file: LinkFile = {
		version: 1,
		built_at: new Date().toISOString(),
		source_fingerprint: fingerprint,
		links,
	};
	fs.mkdirSync(path.dirname(LINKS_PATH), { recursive: true });
	const tmp = LINKS_PATH + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(file), "utf8");
	fs.renameSync(tmp, LINKS_PATH);
}

// ------------------------------------------------------------
// 建（阶段二 headless 异步）—— spawn 部分
// ------------------------------------------------------------

export interface LinkBuildEntry {
	fragment_id: string;
	title: string;
	summary: string;
	topic: string | null;
}

export interface LinkBuildResult {
	ok: boolean;
	linksCount?: number;
	error?: string;
}

/** spawn 实现可注入（测试替换为假实现） */
export type HeadlessSpawnFn = (command: string, args: string[], options: { cwd: string }) => {
	stdout: { on(event: "data", cb: (d: Buffer) => void): unknown; on(event: string, cb: (...a: unknown[]) => void): unknown };
	stderr: { on(event: "data", cb: (d: Buffer) => void): unknown };
	on(event: "close", cb: (code: number | null) => void): unknown;
};

let spawnImpl: HeadlessSpawnFn = spawn as unknown as HeadlessSpawnFn;

/** 注入假 spawn（测试用） */
export function setSpawnImpl(fn: HeadlessSpawnFn): void {
	spawnImpl = fn;
}

/** 恢复默认 spawn（真实 headless） */
export function resetSpawnImpl(): void {
	spawnImpl = spawn as unknown as HeadlessSpawnFn;
}

// ------------------------------------------------------------
// DSH 二进制定位（阶段二 headless 复用本地 DSH）
// ------------------------------------------------------------

/**
 * 定位 DSH 的 bin.js（headless 建链要复用本地 DSH，避免 npx 联网安装 + Node 22
 * 对 .cmd spawn 的 EINVAL 限制）：
 * ① MEMORY_DSH_BIN 环境变量显式指定（优先）；
 * ② 扫描 npm 缓存 `_npx/<hash>/node_modules/@deepseek-ai/dsh/lib/bin.js`，
 *    优先取版本 === DSH_VERSION 的，否则取任意一个；
 * 都找不到 → null（调用方回退 npx 锁版本）。
 */
export function resolveDshBin(): string | null {
	const env = process.env.MEMORY_DSH_BIN;
	if (env && fs.existsSync(env)) return env;
	const localAppData = process.env.LOCALAPPDATA;
	const home = process.env.USERPROFILE;
	const cache =
		process.env.NPM_CONFIG_CACHE ||
		path.join(localAppData || path.join(home || "", "AppData", "Local"), "npm-cache");
	const npxDir = path.join(cache, "_npx");
	let fallback: string | null = null;
	try {
		if (!fs.existsSync(npxDir)) return null;
		for (const dir of fs.readdirSync(npxDir)) {
			const base = path.join(npxDir, dir, "node_modules", "@deepseek-ai", "dsh");
			const bin = path.join(base, "lib", "bin.js");
			if (!fs.existsSync(bin)) continue;
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")) as {
					version?: string;
				};
				if (pkg.version === DSH_VERSION) return bin;
			} catch {
				/* ignore 单个缓存目录的 package.json 损坏 */
			}
			if (!fallback) fallback = bin;
		}
	} catch {
		/* ignore 缓存目录读取失败 */
	}
	return fallback;
}

/** 解析器可注入（测试替换为固定值） */
let resolveDshBinImpl: () => string | null = resolveDshBin;

/** 注入假解析器（测试用） */
export function setResolveDshBinImpl(fn: () => string | null): void {
	resolveDshBinImpl = fn;
}

/** 恢复默认解析器 */
export function resetResolveDshBinImpl(): void {
	resolveDshBinImpl = resolveDshBin;
}

/**
 * 写临时 settings + patch overlay，让 headless 建链用更快模型（默认 flash + off），
 * 不受用户 settings.yaml 里 `agent-default-model`（默认 pro + high）的覆盖。
 * 返回 `patchArg`（传给 --patch 的绝对路径，正斜杠）与 `cleanup`（删除临时目录）。
 */
function writeBuildSettingsOverlay(): { patchArg: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-build-"));
	const settingsFile = path.join(dir, "settings.yaml");
	const patchFile = path.join(dir, "patch.yaml");
	fs.writeFileSync(
		settingsFile,
		[
			"agent-default-model:",
			`  provider: ${BUILD_PROVIDER}`,
			`  model: ${BUILD_MODEL}`,
			`  reasoningEffort: ${BUILD_REASONING_EFFORT}`,
			"",
		].join("\n"),
		"utf8",
	);
	const settingsArg = settingsFile.replace(/\\/g, "/");
	fs.writeFileSync(patchFile, `- id: settings\n  config:\n    path: "${settingsArg}"\n`, "utf8");
	const patchArg = patchFile.replace(/\\/g, "/");
	return {
		patchArg,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore 临时文件清理失败 */
			}
		},
	};
}

/** 构造建链任务文本（内嵌条目列表，绝对路径供 headless 参考） */
export function buildLinkTask(entries: LinkBuildEntry[], workMemoryPath: string): string {
	const items = entries.map((e) => ({
		fragment_id: e.fragment_id,
		title: e.title,
		summary: e.summary,
		topic: e.topic,
	}));
	return (
		"你是记忆系统的建链器。以下是 work_memory.md（" + workMemoryPath + "）当前的全部记忆条目（JSON 数组）：\n\n" +
		JSON.stringify(items) +
		"\n\n任务：判断这些条目两两之间的相关性，只保留【强相关】的关系" +
		"（语义先后/因果/互补/同机制演进等）。弱相关、纯时间相邻、纯同主题但无实际关联的一律不连。" +
		"每条条目最多指向 2 条最相关的（有向，A→B 不要求 B→A）；若强相关超过 2 条，按相关性降序取前 2，宁可少连也不要弱边凑数。" +
		"只输出一个 JSON 对象到 stdout：键=源条目 fragment_id 字符串，值=其指向的 fragment_id 字符串数组（数组里直接放字符串，不要放对象）。" +
		"格式示例：{\"2026-08-05/frag_007\": [\"2026-08-05/frag_008\", \"2026-08-08/frag_003\"]}。" +
		"不要任何其他文字、不要 markdown 代码块、不要解释。没有强相关关系的条目不要出现在 JSON 里。"
	);
}

/**
 * 异步建链（§8.1）：spawn headless（锁版本 + 固定 cwd + stderr 留痕），
 * 收集 stdout → extractJsonObject → normalizeLinks → writeLinkFile。
 * 返回 Promise<LinkBuildResult>；调用方不 await 即为异步。
 */
export async function buildLinksAsync(input: {
	entries: LinkBuildEntry[];
	fingerprint: string;
	cwd: string;
	workMemoryPath: string;
}): Promise<LinkBuildResult> {
	const task = buildLinkTask(input.entries, input.workMemoryPath);

	// 定位本地 DSH bin.js（env 指定或 npm 缓存自动发现）；找到则 node 直跑，
	// 避开 npx 联网 + Node 22 对 .cmd spawn 的 EINVAL；找不到回退 npx 锁版本。
	const bin = resolveDshBinImpl();
	const command = bin ? process.execPath : process.platform === "win32" ? "npx.cmd" : "npx";
	// 用临时 settings + patch overlay 让 headless 走更快模型（默认 flash + off）
	const overlay = writeBuildSettingsOverlay();
	const args = bin
		? [bin, "--profile", "headless", "--patch", overlay.patchArg, task]
		: ["@deepseek-ai/dsh@" + DSH_VERSION, "--profile", "headless", "--patch", overlay.patchArg, task];

	const startedAt = Date.now();
	console.log("[work_memory_links] 建链启动：" + JSON.stringify({ pid: "n/a", command, model: BUILD_MODEL, reasoningEffort: BUILD_REASONING_EFFORT, startedAt, entries: input.entries.length }));

	return new Promise<LinkBuildResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let child: ReturnType<HeadlessSpawnFn>;
		try {
			child = spawnImpl(command, args, { cwd: input.cwd });
		} catch (err) {
			overlay.cleanup();
			console.error("[work_memory_links] 建链 spawn 失败：", (err as Error)?.message ?? err);
			resolve({ ok: false, error: "spawn failed: " + ((err as Error)?.message ?? err) });
			return;
		}
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("close", (code) => {
			overlay.cleanup();
			console.log("[work_memory_links] 建链结束：" + JSON.stringify({ code, stdoutChars: stdout.length, elapsedMs: Date.now() - startedAt }));
			if (code !== 0) {
				console.error("[work_memory_links] 建链失败（exit " + code + "）：" + stderr.slice(0, 500));
				resolve({ ok: false, error: "headless exit " + code });
				return;
			}
			const parsed = extractJsonObject(stdout);
			if (parsed === null) {
				console.error("[work_memory_links] 建链失败：stdout 无合法 JSON（前 200 字符）：" + stdout.slice(0, 200));
				resolve({ ok: false, error: "no valid json in stdout" });
				return;
			}
			const validIds = new Set(input.entries.map((e) => e.fragment_id));
			const links = normalizeLinks(parsed, validIds);
			if (links === null) {
				console.error("[work_memory_links] 建链失败：JSON 不是对象");
				resolve({ ok: false, error: "parsed json is not an object" });
				return;
			}
			try {
				writeLinkFile(links, input.fingerprint);
			} catch (err) {
				console.error("[work_memory_links] 建链落盘失败：", (err as Error)?.message ?? err);
				resolve({ ok: false, error: "write failed: " + ((err as Error)?.message ?? err) });
				return;
			}
			console.log("[work_memory_links] 建链完成：" + JSON.stringify({ linksCount: Object.keys(links).length }));
			resolve({ ok: true, linksCount: Object.keys(links).length });
		});
	});
}
