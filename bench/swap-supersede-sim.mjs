// 取代检测模拟验证：剔除"被取代旧值"片段后，0.95 档 swap 是否消失
// 模拟"取代检测全部命中"：把 type=superseded 对的 distractor（旧值）从结果中剔除，重新判定 top-1/top-3
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
process.chdir("C:/Users/K4233/AppData/Local/Temp/mem_swap095");

const retriever = await import(pathToFileURL("D:/AgentStore/memory-mcp-server/src/search/retriever.ts").href);
const dataset = JSON.parse(
  fs.readFileSync("D:/AgentStore/memory-mcp-server/bench/datasets/interference-v1.json", "utf8"),
);
const cases = dataset.cases;

// superseded 型对的 distractor = 被取代旧值（模拟取代检测标记）
const supersededOld = new Set(
  cases.filter((c) => c.type === "superseded").map((c) => c.distractor_id),
);
console.log("模拟取代检测标记的旧值片段:", [...supersededOld].join(", "), "\n");

const judge = (topList, c) => {
  if (topList[0] === c.expected_top1) return "correct";
  if (topList[0] === c.distractor_id) return "swap";
  return "miss";
};

// 全量检索（topK=60 覆盖全库），配置 A：原样；配置 B：剔除 superseded 旧值后重取前 3
const rows = [];
for (const c of cases) {
  const res = await retriever.search(c.query, 60);
  const all = res.results.map((r) => r.fragment_id);
  const aTop3 = all.slice(0, 3);
  const bAll = all.filter((id) => !supersededOld.has(id));
  const bTop3 = bAll.slice(0, 3);
  rows.push({ c, aTop3, bTop3, aV: judge(aTop3, c), bV: judge(bTop3, c), aTop1: aTop3[0], bTop1: bTop3[0] });
}

function summarize(rows, key) {
  const byBin = {};
  let swap = 0, correct = 0, miss = 0;
  for (const r of rows) {
    const v = r[key];
    const bin = r.c.sim_bin;
    byBin[bin] ??= { total: 0, swap: 0, correct: 0 };
    byBin[bin].total++;
    if (v === "swap") { swap++; byBin[bin].swap++; }
    else if (v === "correct") { correct++; byBin[bin].correct++; }
    else miss++;
  }
  return { byBin, swap, correct, miss };
}

for (const [tag, key] of [["A 现状（top-3 原样）", "aV"], ["B +取代检测（剔除旧值后 top-3）", "bV"]]) {
  const s = summarize(rows, key);
  console.log("=== " + tag + " ===");
  console.log("  总: " + s.correct + " 正确 / " + s.swap + " swap / " + s.miss + " miss");
  for (const [bin, b] of Object.entries(s.byBin)) {
    console.log("  " + bin + ": swap=" + b.swap + "/" + b.total + (b.swap ? " ⚠" : " ✅"));
  }
  console.log("");
}

console.log("=== 0.95 档逐 case（A → B）===");
for (const r of rows.filter((r) => r.c.sim_bin === "0.95+")) {
  const tag = (v) => (v === "swap" ? "⚠SWAP" : v === "correct" ? "✅" : "❌miss");
  console.log(
    "  " + r.c.pair_id + " sim=" + (r.c.measured_sim ?? 0).toFixed(3) + " | A: " + tag(r.aV) + " top1=" + r.aTop1.split("/")[1] + " | B: " + tag(r.bV) + " top1=" + r.bTop1.split("/")[1],
  );
}
