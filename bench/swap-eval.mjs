// SwapError 干扰评估 v1：生产形态（retriever.search）vs 纯 cosine 基线
// 指标：swap_rate(sim_bin) 曲线、误取类型分解、top-3 命中、平均召回对照
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
process.chdir("C:/Users/K4233/AppData/Local/Temp/mem_swap095");

const retriever = await import(pathToFileURL("D:/AgentStore/memory-mcp-server/src/search/retriever.ts").href);
const generation = await import(pathToFileURL("D:/AgentStore/memory-mcp-server/src/embedding/generation.ts").href);
const builder = await import(pathToFileURL("D:/AgentStore/memory-mcp-server/src/embedding/builder.ts").href);
const provider = await import(pathToFileURL("D:/AgentStore/memory-mcp-server/src/embedding/provider.ts").href);

const dataset = JSON.parse(
  fs.readFileSync("D:/AgentStore/memory-mcp-server/bench/datasets/interference-v1.json", "utf8"),
);
const cases = dataset.cases;
console.log("干扰集:", dataset.dataset_id, "|", cases.length, "对\n");

// 全库 summary 向量（纯 cosine 基线用）
const active = generation.getActiveGeneration();
const index = generation.readGenerationIndex(active.generation_id);
const libVecs = new Map();
for (const [fid, rec] of Object.entries(index)) {
  const views = generation.readGenerationMultiviewViews(active.generation_id, fid, rec, active.dimension, "light");
  if (!views) continue;
  const s = views.find((v) => v.kind === "summary");
  if (s) libVecs.set(fid, s.vector);
}
const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

function classify(top1, c) {
  if (top1 === c.expected_top1) return "correct";
  if (top1 === c.distractor_id) return "swap";
  return "miss";
}

// 合成对实测 sim（target vs distractor summary 余弦）
for (const c of cases) {
  if (c.synthetic && libVecs.has(c.target_id) && libVecs.has(c.distractor_id)) {
    c.measured_sim = cos(libVecs.get(c.target_id), libVecs.get(c.distractor_id));
  }
}

// ---- 生产形态 ----
const prodRows = [];
for (const c of cases) {
  const res = await retriever.search(c.query, 3);
  const top1 = res.results[0]?.fragment_id ?? null;
  const top3 = res.results.slice(0, 3).map((r) => r.fragment_id);
  const verdict = classify(top1, c);
  prodRows.push({ c, verdict, top1, top3, top1Score: res.results[0]?.raw_similarity ?? null });
}

// ---- 纯 cosine 基线 ----
const cosRows = [];
for (const c of cases) {
  const built = await builder.buildQueryInput(c.query, active ?? undefined);
  const qv = Array.from(await provider.encode(built.text));
  let best = null, bestScore = -Infinity;
  for (const [fid, vec] of libVecs) {
    const s = cos(qv, vec);
    if (s > bestScore) { bestScore = s; best = fid; }
  }
  const verdict = classify(best, c);
  cosRows.push({ c, verdict, top1: best, top1Score: bestScore });
}

// ---- 聚合 ----
function aggregate(rows) {
  const byBin = {};
  const byType = {};
  let correct = 0, swap = 0, miss = 0;
  const top3Hit = { hit: 0, total: 0 };
  for (const r of rows) {
    const bin = r.c.sim_bin, type = r.c.type;
    byBin[bin] ??= { total: 0, correct: 0, swap: 0, miss: 0 };
    byBin[bin].total++;
    byType[type] ??= { total: 0, swap: 0 };
    byType[type].total++;
    if (r.verdict === "correct") { correct++; byBin[bin].correct++; }
    else if (r.verdict === "swap") { swap++; byBin[bin].swap++; byType[type].swap++; }
    else { miss++; byBin[bin].miss++; }
    if (r.top3) {
      top3Hit.total++;
      if (r.top3.includes(r.c.expected_top1)) top3Hit.hit++;
    }
  }
  return { byBin, byType, correct, swap, miss, top3Hit };
}

function print(tag, agg) {
  console.log("=== " + tag + " ===");
  console.log("总: " + agg.correct + " 正确 / " + agg.swap + " 取错(swap) / " + agg.miss + " 未召回 (n=" + (agg.correct + agg.swap + agg.miss) + ")");
  console.log("target top-1 命中(平均召回): " + (agg.correct / (agg.correct + agg.swap + agg.miss) * 100).toFixed(0) + "% | top-3 含 target: " + agg.top3Hit.hit + "/" + agg.top3Hit.total);
  console.log("\n按 sim_bin（交换率曲线）:");
  for (const [bin, b] of Object.entries(agg.byBin)) {
    const swapRate = b.swap / b.total;
    console.log("  " + bin + ": swap_rate=" + (swapRate * 100).toFixed(0) + "% (" + b.swap + "/" + b.total + ") correct=" + b.correct + " miss=" + b.miss);
  }
  console.log("\n按误取类型（swap 数/总数）:");
  for (const [t, b] of Object.entries(agg.byType)) {
    console.log("  " + t + ": " + b.swap + "/" + b.total + (b.swap ? "  ⚠" : ""));
  }
  console.log("");
}

print("生产形态（竞争门 0.81 + 披露门 + 权重）", aggregate(prodRows));
print("纯 cosine 基线（无权重无 gate）", aggregate(cosRows));

// 结构化报告
const prodAgg = aggregate(prodRows);
const cosAgg = aggregate(cosRows);
const report = {
  report_schema_version: 1,
  report_type: "swap-error-eval-v1",
  date: new Date().toISOString(),
  dataset_id: dataset.dataset_id,
  case_count: cases.length,
  configs: {
    production: { description: "retriever.search（竞争门 0.81 + 披露门 + decay_floor 权重）" },
    pure_cosine: { description: "query 编码后与全库 summary 向量余弦 top-1（无权重无 gate）" },
  },
  production: {
    correct: prodAgg.correct, swap: prodAgg.swap, miss: prodAgg.miss,
    recall_at_1: prodAgg.correct / cases.length,
    swap_rate_total: prodAgg.swap / cases.length,
    top3_target_hit: prodAgg.top3Hit,
    by_sim_bin: prodAgg.byBin,
    by_type: prodAgg.byType,
    cases: prodRows.map((r) => ({ pair_id: r.c.pair_id, type: r.c.type, measured_sim: r.c.measured_sim, verdict: r.verdict, top1: r.top1, top3: r.top3 })),
  },
  pure_cosine: {
    correct: cosAgg.correct, swap: cosAgg.swap, miss: cosAgg.miss,
    recall_at_1: cosAgg.correct / cases.length,
    swap_rate_total: cosAgg.swap / cases.length,
    by_sim_bin: cosAgg.byBin,
    by_type: cosAgg.byType,
    cases: cosRows.map((r) => ({ pair_id: r.c.pair_id, type: r.c.type, measured_sim: r.c.measured_sim, verdict: r.verdict, top1: r.top1 })),
  },
  note: "swap = top-1 取到配对的 distractor。miss = top-1 是无关片段（多为聚合型片段截胡：07-27 设计稿/08-04 教训总结/07-28 活动日志）。0.95 档未覆盖（需合成片段临时库，下一步）。",
};
fs.writeFileSync("D:/AgentStore/memory-mcp-server/bench/reports/swap-eval-v1-report.json", JSON.stringify(report, null, 2));
console.log("\n报告已写: bench/reports/swap-eval-v1-report.json");

// 逐 case 明细（生产形态）
console.log("=== 逐 case 明细（生产 vs 纯cosine，含 top-3 位置）===");
for (let i = 0; i < cases.length; i++) {
  const p = prodRows[i], c2 = cosRows[i];
  const tag = (v) => v === "correct" ? "✅" : v === "swap" ? "⚠SWAP" : "❌miss";
  const tPos = p.top3 ? p.top3.indexOf(p.c.target_id) : -1;
  const dPos = p.top3 ? p.top3.indexOf(p.c.distractor_id) : -1;
  const posStr = " target@" + (tPos === -1 ? "-" : tPos + 1) + " dist@" + (dPos === -1 ? "-" : dPos + 1);
  console.log("  " + c2.c.measured_sim.toFixed(3) + " [" + c2.c.type + "] " + c2.c.pair_id + posStr + " Q:\"" + c2.c.query.slice(0, 26) + "...\"");
  console.log("    生产: " + tag(p.verdict) + " top1=" + (p.top1 ?? "null") + " | top3=" + (p.top3 ?? []).map((x) => x.split("/")[1]).join(","));
  console.log("    cosine: " + tag(c2.verdict) + " top1=" + (c2.top1 ?? "null"));
}
