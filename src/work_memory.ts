/**
 * 热工作记忆（Hot Working Memory）
 *
 * 机制：
 *  - LLM 每次 memory_search 触发 refresh()：把最新命中的条目作为「主体」（primary）
 *    替换进热文件，保留之前后台轮询追加的条目（appended）。
 *  - 后台定时轮询（固定 300ms 间隔）：
 *    通道⓪ 先查联想链（work_memory_links.json，深度=1 直接出边邻居），
 *    再走通道①关键词语义检索（最近 query + 已注入条目的 topic_name），
 *    两条通道共同发现新的相关记忆，追加摘要 + 路径。
 *  - 预算：默认 4% × 128K ≈ 5120 tokens（按 ~2 字符/token 折算为字符数）为
 *    **appended（主体外条目）的预算**——「主体外的条目加起来满 4%」即停；
 *    主体（primary）是 LLM 主动检索的结果，不占预热预算。
 *  - search 触发：保留 appended、替换主体；appended 超预算时从最老的 appended 条目
 *    裁起（主体不裁）腾出空间；并**无条件重新开始轮询**，直到 appended 再度满预算。
 *  - 注入通道与 server 解耦：当前 harness（Deep Code）靠 AGENTS.md 引导 LLM
 *    主动 Read 本文件；未来换 harness 后可改为 hook 每次注入同一文件。
 *
 * 容错原则：任何失败只 console.error，不阻断检索本身（best-effort）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FragmentMeta, SearchResultItem, SearchResults } from "./types.js";
import { search } from "./search/retriever.js";
import { getFragment } from "./storage/fragments.js";
import {
	buildLinksAsync,
	computeFingerprint,
	loadLinks,
	readLinkFile,
} from "./work_memory_links.js";

const WORK_MEMORY_PATH = path.resolve("memory/work_memory.md");

/** 预算：4% × 128K ≈ 5120 tokens；按 ~2 字符/token 折算为字符数（保守估算） */
const MAX_TOKENS = 5120;
/** appended（主体外条目）预算：轮询停止阈值（主体不占预算） */
const APPENDED_BUDGET = MAX_TOKENS * 2;

/** 固定轮询间隔（原动态 3s→15min 平方曲线已过时，2026-08-16 改固定 300ms） */
const POLL_INTERVAL_MS = 300;

/** 每轮轮询每个关键词取几条；search 触发时主体条目数 */
const POLL_TOP_K = 5;

type EntryKind = "primary" | "appended";

interface WorkMemoryEntry {
	fragment_id: string;
	title: string;
	summary: string;
	topic: string | null;
	kind: EntryKind;
	addedAt: number;
}

export class WorkMemory {
	private query = "";
	private keywords: string[] = [];
	private entries: WorkMemoryEntry[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	/** 检索实现可注入（默认真实 retriever；测试可替换为假实现） */
	private searchImpl: (query: string, topK: number) => Promise<SearchResults> = search;

	setSearchImpl(fn: (query: string, topK: number) => Promise<SearchResults>): void {
		this.searchImpl = fn;
	}

	/** server 启动时调用：清空热文件（会话残留），停止轮询 */
	init(): void {
		this.stop();
		this.entries = [];
		this.query = "";
		this.keywords = [];
		this.budgetReached = false;
		this.linkBuildInFlight = false;
		this.render();
	}

	/** search 触发：替换主体条目（保留 appended），重算线索，无条件重启调度 */
	refresh(query: string, results: SearchResults): void {
		this.query = query;
		// primary 去重：同一 fragment 只保留第一次命中（retriever 一般不重复，防御性处理）
		const primaryIds = new Set<string>();
		const primary: WorkMemoryEntry[] = [];
		for (const r of results.results.slice(0, POLL_TOP_K)) {
			if (primaryIds.has(r.fragment_id)) continue;
			primaryIds.add(r.fragment_id);
			primary.push(this.toEntry(r, "primary"));
		}
		// appended 去重：排除 primary 已包含的 fragment，避免同一记忆「主体 + 追加」双份占预算
		const appended = this.entries.filter(
			(e) => e.kind === "appended" && !primaryIds.has(e.fragment_id),
		);
		this.entries = [...primary, ...appended];
		this.recomputeKeywords();
		this.render(); // trimToBudget：总文件超预算时裁最老 appended 腾空间（保主体）
		// 重置调度：search 一触发就重新开始轮询（appended 是否还能积累由 schedule 内判断）
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.schedule();
	}

	private toEntry(r: SearchResultItem, kind: EntryKind): WorkMemoryEntry {
		return {
			fragment_id: r.fragment_id,
			title: r.task_desc || r.fragment_id,
			summary: r.result_desc || r.matched_snippet || "",
			topic: r.hierarchy?.topic_name ?? null,
			kind,
			addedAt: Date.now(),
		};
	}

	/** 从 FragmentMeta 构造 WorkMemoryEntry（链扩散通道⓪用；FragmentMeta 无 matched_snippet，兜底只取 result_desc） */
	private entryFromFragment(frag: FragmentMeta, kind: EntryKind): WorkMemoryEntry {
		return {
			fragment_id: frag.fragment_id,
			title: frag.task_desc || frag.fragment_id,
			summary: frag.result_desc || "",
			topic: frag.topic_name || null,
			kind,
			addedAt: Date.now(),
		};
	}

	private recomputeKeywords(): void {
		const topics = new Set<string>();
		for (const e of this.entries) {
			if (e.topic) topics.add(e.topic);
		}
		this.keywords = [this.query, ...Array.from(topics)].map((k) => k.trim()).filter(Boolean);
	}

	/** appended 是否曾触达预算线（追加后检测）。trimToBudget 的裁剪条件（> 预算）
	 *  与 schedule 停轮询条件（>= 预算）之间存在缝隙：追加 → 超线 → trim 裁回线内
	 *  → 永远 < 预算 → 「存满」几乎不可达。故以「曾触顶」作为存满信号。 */
	private budgetReached = false;

	private schedule(): void {
		if (this.timer) return; // 已有待触发 timer（poll 末尾的 schedule 会被 refresh 的 timer 挡住）
		if (this.appendedChars() >= APPENDED_BUDGET || this.budgetReached) {
			// appended 满预算（或曾触顶）：停轮询，直到下次 search；此时触发异步建链（阶段二）
			this.budgetReached = false;
			this.maybeTriggerLinkBuild();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.poll();
		}, POLL_INTERVAL_MS);
		// unref：后台轮询不应阻止进程退出。测试/一次性脚本场景下事件循环
		// 清空即退出；server 场景（stdio 等活跃句柄存在）定时器照常触发。
		// 修复前：refresh → schedule → poll → finally 再 schedule 形成无限循环，
		// 任何 handleSearch 调用后进程永不退出（全量测试卡死 30 分钟的根因）。
		this.timer.unref();
	}

	/**
	 * 存满时异步触发 headless 建链（阶段二）。不 await——fire-and-forget 语义，
	 * buildLinksAsync 内部收集 stdout + 校验 + 落盘，失败只留日志。
	 * 防重：① 进程内进行中标志；② 内容指纹与链文件一致则跳过（§7.2）。
	 */
	private linkBuildInFlight = false;

	private maybeTriggerLinkBuild(): void {
		if (this.linkBuildInFlight) return; // 建链进行中，不重复触发
		const ids = this.entries.map((e) => e.fragment_id);
		const fingerprint = computeFingerprint(ids);
		const existing = readLinkFile();
		if (existing && existing.source_fingerprint === fingerprint) return; // 链已覆盖当前内容
		if (ids.length === 0) return; // 无条目，无链可建
		this.linkBuildInFlight = true;
		void buildLinksAsync({
			entries: this.entries.map((e) => ({
				fragment_id: e.fragment_id,
				title: e.title,
				summary: e.summary,
				topic: e.topic,
			})),
			fingerprint,
			cwd: process.cwd(),
			workMemoryPath: WORK_MEMORY_PATH,
		})
			.then((result) => {
				console.log(
					"[work_memory] 建链结果：",
					result.ok
						? `ok (${result.linksCount} 条出边条目)`
						: `失败：${result.error ?? "unknown"}`,
				);
			})
			.catch((err) => {
				console.error("[work_memory] 建链异常：", (err as Error)?.message ?? err);
			})
			.finally(() => {
				this.linkBuildInFlight = false;
			});
	}

	private async poll(): Promise<void> {
		this.running = true;
		try {
			const existing = new Set(this.entries.map((e) => e.fragment_id));
			// ── 通道⓪：链扩散（先查链，深度=1：只追加直接出边邻居，不递归）──
			// 快照遍历：循环内 push 的邻居不会被本通道再次遍历（天然深度=1）
			for (const e of [...this.entries]) {
				if (this.appendedChars() >= APPENDED_BUDGET) break;
				for (const nid of loadLinks(e.fragment_id)) {
					if (this.appendedChars() >= APPENDED_BUDGET) break;
					if (existing.has(nid)) continue;          // 去重复用现有 Set
					const frag = getFragment(nid);
					if (!frag) continue;                     // 存在性校验：快照可能指向已删 fragment
					this.entries.push(this.entryFromFragment(frag, "appended"));
					existing.add(nid);
					if (this.appendedChars() >= APPENDED_BUDGET) this.budgetReached = true;
				}
			}
			// ── 通道①：关键词语义检索（现有，不动）──
			for (const kw of this.keywords) {
				if (this.appendedChars() >= APPENDED_BUDGET) break;
				const results = await this.searchImpl(kw, POLL_TOP_K);
				for (const r of results.results) {
					if (this.appendedChars() >= APPENDED_BUDGET) break;
					if (existing.has(r.fragment_id)) continue;
					this.entries.push(this.toEntry(r, "appended"));
					existing.add(r.fragment_id);
					if (this.appendedChars() >= APPENDED_BUDGET) this.budgetReached = true;
				}
			}
			this.render();
		} catch (err) {
			console.error("[work_memory] 轮询失败：", (err as Error)?.message ?? err);
		} finally {
			this.running = false;
			this.schedule();
		}
	}

	/** appended 条目渲染后的字符数（主体不占轮询预算判断） */
	private appendedChars(): number {
		let n = 0;
		for (const e of this.entries) {
			if (e.kind !== "appended") continue;
			n += this.entryText(e).length + 1; // +1 换行
		}
		return n;
	}

	/** 单条目渲染（primary/appended 共用，保持格式一致） */
	private entryText(e: WorkMemoryEntry): string {
		const lines = [`1. **${e.title}**（${e.fragment_id}）`];
		if (e.topic) lines.push(`   主题：${e.topic}`);
		lines.push(`   摘要：${e.summary}`);
		lines.push(`   路径：memory_get_fragment(${e.fragment_id})`);
		return lines.join("\n");
	}

	/** 注满裁剪：appended 超预算时从最老的 appended 条目裁起（primary 主体不裁）腾出空间 */
	private trimToBudget(): void {
		while (this.appendedChars() > APPENDED_BUDGET) {
			const idx = this.entries.findIndex((e) => e.kind === "appended");
			if (idx === -1) break;
			this.entries.splice(idx, 1);
		}
	}

	private renderText(): string {
		const now = new Date().toISOString();
		// 头部展示：appended 填充率（主体不占轮询预算）
		const fill = Math.min(1, this.appendedChars() / APPENDED_BUDGET);
		const lines: string[] = [
			"# 热工作记忆（Hot Working Memory）",
			"",
			"> 由 memory-mcp 自动维护 · 检索记忆后请主动 Read 本文件（摘要 + 路径，深挖用 memory_get_fragment）",
			`> 更新：${now} · 联想填充 ${Math.round(fill * 100)}%（预算 ${MAX_TOKENS} tokens） · 轮询间隔 ${POLL_INTERVAL_MS}ms`,
			"",
			"## 当前线索",
			"",
			"- " + (this.keywords.length > 0 ? this.keywords.join("、") : "（等待检索触发）"),
			"",
			"## 相关记忆（摘要 + 路径）",
			"",
		];
		this.entries.forEach((e, i) => {
			lines.push(`${i + 1}. **${e.title}**（${e.fragment_id}${e.kind === "primary" ? " · 主体" : ""}）`);
			if (e.topic) lines.push(`   主题：${e.topic}`);
			lines.push(`   摘要：${e.summary}`);
			lines.push(`   路径：memory_get_fragment(${e.fragment_id})`);
			lines.push("");
		});
		return lines.join("\n");
	}

	private render(): void {
		this.trimToBudget();
		try {
			fs.mkdirSync(path.dirname(WORK_MEMORY_PATH), { recursive: true });
			fs.writeFileSync(WORK_MEMORY_PATH, this.renderText(), "utf8");
		} catch (err) {
			console.error("[work_memory] 写热文件失败：", (err as Error)?.message ?? err);
		}
	}

	private stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}

export const workMemory = new WorkMemory();
