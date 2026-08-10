// memory-mcp-server 真实库检索采样（只读）
// 用法: node --import tsx bench/perf-real-lib.mjs
// 注意: 进程启动即 chdir 到真实库根；只调用 retriever.search（不写 signals，只读）
import { performance } from "node:perf_hooks";

const LIB = "D:/ProjectGame/避难末日demo";
process.chdir(LIB);

const retriever = await import("../src/search/retriever.ts");
const provider = await import("../src/embedding/provider.ts");

const queries = [
  "门系统 Toggle 改造 开关门",
  "电梯 状态机 报错 修复",
  "粒子系统 性能优化",
  "Skeleton 缩放污染 子节点",
  "脚本职责分离 NodePath 边界",
  "陷阱门 设计 电力",
  "按钮电梯 楼层选择 实现",
  "StateMachine on_completion 回调",
];

const t0 = performance.now();
await provider.encode("预热"); // 加载模型
const coldMs = performance.now() - t0;

const rows = [];
for (const q of queries) {
  const samples = [];
  for (let r = 0; r < 3; r++) {
    const s0 = performance.now();
    const res = await retriever.search(q, 5);
    samples.push(performance.now() - s0);
    if (r === 2) rows.push({ query: q, n_fragments: res.health?.fragment_count ?? res.results?.length ?? "?", avg_ms: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2), top1: res.results?.[0]?.fragment_id });
  }
}

const all = rows.map((r) => r.avg_ms);
const sorted = [...all].sort((a, b) => a - b);
const avg = all.reduce((a, b) => a + b, 0) / all.length;
console.log(JSON.stringify({
  lib: "避难末日demo",
  cold_start_ms: +coldMs.toFixed(2),
  queries: rows,
  aggregate: { avg_ms: +avg.toFixed(2), min_ms: +sorted[0].toFixed(2), max_ms: +sorted.at(-1).toFixed(2), p95_ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2) },
}, null, 2));
