// P3 Phase 0 信号分析：离线重建「回忆 episode」，回答 go/no-go 三问。
// 只读 memory/signals/*.jsonl，不改任何东西，随时可跑。
//
// 必须从「记忆库所在的项目根目录」运行（存储层与埋点都用
// path.resolve("memory/...") 相对 cwd 定位，别 cd 进 memory 里面）：
//   cd <项目根> && node D:/AgentStore/memory-mcp-server/analyze_signals.mjs
//
// 回答的三问（对应设计稿 Phase 0 的 go/no-go）：
//   1. get_fragment 到底 fire 不 fire？多频繁？confirmed_by=user 占多少？
//   2. reformulated 检索能否重建成 episode 并数出迭代次数？迭代数有方差吗？
//   3. 多迭代 + 人工点头的记忆，是不是事后独立回看也认为「重要」的？（这问靠人看清单）
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = path.resolve("memory/signals");
// 同一 agent 内，两次 search 间隔超过这个秒数就切一个新 episode
const EPISODE_GAP_SEC = 15 * 60;

function readJsonl(name) {
	const p = path.join(BASE, name);
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

const searches = readJsonl("search.jsonl");
const gets = readJsonl("get_fragment.jsonl");

console.log("=== 原始计数 ===");
console.log(`search.jsonl:        ${searches.length} 行`);
console.log(`get_fragment.jsonl:  ${gets.length} 行`);
if (searches.length === 0 && gets.length === 0) {
	console.log("\n还没有任何信号。等真实使用积累几天再跑。");
	process.exit(0);
}

// ---- 问题 1：get_fragment 频率 + confirmed_by 分布 ----
const byConfirm = { user: 0, agent: 0, null: 0 };
for (const g of gets) byConfirm[g.confirmed_by ?? "null"]++;
console.log("\n=== 问题1：读原文事件 ===");
console.log(`get_fragment 触发 ${gets.length} 次`);
console.log(`  confirmed_by=user  : ${byConfirm.user}  ← 金标准成功`);
console.log(`  confirmed_by=agent : ${byConfirm.agent}`);
console.log(`  未标注 (null)      : ${byConfirm.null}`);
const searchToGet = searches.length ? (gets.length / searches.length).toFixed(2) : "n/a";
console.log(`get/search 比例: ${searchToGet}（太低说明 search 结果通常已够用，很少读原文）`);

// ---- 把 search 按 (agent, 时间邻近) 聚成 episode ----
const key = (r) => r.agent_id ?? "∅";
const groups = new Map();
for (const s of searches) {
	const k = key(s);
	if (!groups.has(k)) groups.set(k, []);
	groups.get(k).push(s);
}
const episodes = [];
for (const [agent, rows] of groups) {
	rows.sort((a, b) => a.ts.localeCompare(b.ts));
	let cur = null;
	for (const s of rows) {
		const t = Date.parse(s.ts);
		if (cur && t - cur.lastTs <= EPISODE_GAP_SEC * 1000) {
			cur.searches.push(s);
			cur.lastTs = t;
		} else {
			cur = { agent, startTs: s.ts, lastTs: t, searches: [s] };
			episodes.push(cur);
		}
	}
}

// 把 get_fragment 归入时间上落在其后、同 agent、最近的那个 episode
for (const g of gets) {
	const t = Date.parse(g.ts);
	let best = null;
	for (const e of episodes) {
		if (e.agent !== (g.agent_id ?? "∅")) continue;
		const start = Date.parse(e.startTs);
		if (start <= t && t - e.lastTs <= EPISODE_GAP_SEC * 1000) {
			if (!best || Date.parse(e.startTs) > Date.parse(best.startTs)) best = e;
		}
	}
	if (best) {
		best.gets = best.gets ?? [];
		best.gets.push(g);
	}
}

// ---- 问题 2：迭代次数方差 ----
const iterCounts = episodes.map((e) => e.searches.length);
const hist = {};
for (const n of iterCounts) hist[n >= 4 ? "≥4" : n] = (hist[n >= 4 ? "≥4" : n] ?? 0) + 1;
const mean = iterCounts.reduce((a, b) => a + b, 0) / (iterCounts.length || 1);
const variance = iterCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (iterCounts.length || 1);
console.log("\n=== 问题2：回忆 episode 的迭代次数（成本方差）===");
console.log(`共重建 ${episodes.length} 个 episode（同 agent、间隔 ≤${EPISODE_GAP_SEC / 60} 分钟归为一次回忆）`);
console.log(`每 episode 的 search 次数分布: ${JSON.stringify(hist)}`);
console.log(`均值 ${mean.toFixed(2)} / 方差 ${variance.toFixed(2)}`);
console.log(variance < 0.05 ? "  ⚠ 方差近 0：几乎都一击命中，成本信号无区分度 → No-go 倾向" : "  方差存在：有的一击命中、有的绕几轮，成本信号有区分度");

// ---- 问题 3：多迭代 + 人工点头的清单，交给人肉眼判断「是否真重要」 ----
console.log("\n=== 问题3：多迭代且人工点头的记忆（供你事后独立判断是否真重要）===");
const rich = episodes
	.filter((e) => (e.gets ?? []).some((g) => g.confirmed_by === "user") && e.searches.length >= 2)
	.map((e) => ({
		start: e.startTs,
		agent: e.agent,
		iterations: e.searches.length,
		queries: e.searches.map((s) => s.query),
		confirmed_fragments: (e.gets ?? []).filter((g) => g.confirmed_by === "user").map((g) => g.fragment_id),
	}));
if (rich.length === 0) {
	console.log("（暂无「≥2 轮检索 + 用户点头」的 episode）");
} else {
	for (const r of rich) {
		console.log(`\n• ${r.start} [${r.agent}]  迭代 ${r.iterations} 轮`);
		console.log(`  检索词: ${r.queries.join("  →  ")}`);
		console.log(`  确认采用: ${r.confirmed_fragments.join(", ")}`);
	}
}

console.log("\n提示：Go = 事件够多 + 迭代有方差 + 落在你回看也认为重要的记忆上。三者缺一则重想 Phase 1。");
