// memory-mcp-server 扩展性跑分（单规模子进程）
// 用法: node --import tsx bench/perf-scalability-one.mjs --n 200 --root <temp-root>
// 注意: 必须在 --root 目录下启动本进程（存储路径是模块加载时固定的）
import { performance } from "node:perf_hooks";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const N = parseInt(arg("n") ?? "50", 10);
const ROOT = arg("root") ?? fs.mkdtempSync(path.join(os.tmpdir(), "memory-perf-scale-"));
fs.mkdirSync(ROOT, { recursive: true });
process.chdir(ROOT);
const log = (...a) => console.error("[scale]", ...a);

const generation = await import("../src/embedding/generation.ts");
const delta = await import("../src/embedding/delta.ts");
const handlers = await import("../src/mcp/handlers.ts");
const { validEvidencePolicy } = await import("../test/evidence-policy-fixture.ts");

function fakeVector(seed, dim = 384) {
  const v = new Array(dim);
  for (let k = 0; k < dim; k++) v[k] = Math.sin(seed * 131.7 + k * 0.37) * 0.5;
  return v;
}
const disclosure = (level, snippet) => ({
  disclosure_level: level, snippet, snippet_token_count: Math.max(1, snippet.length), snippet_anchor: "view_fallback",
});

const gid = `gen_scale_${N}`;
log("creating generation...");
const manifest = await generation.createGeneration(gid, "sha256:perf-inventory", 384, "multiview", await validEvidencePolicy());
const t0 = performance.now();
log("writing views...");
for (let i = 0; i < N; i++) {
  const fragId = `2026-08-01/frag_${String(i + 1).padStart(3, "0")}`;
  const views = [
    { view_id: `v${i}_summary`, kind: "summary", input_hash: `sha256:s${i}`, vector: fakeVector(i), tokens: { used: 40 }, source_spans: [], disclosure: disclosure("T1", `摘要片段 ${i}`) },
    { view_id: `v${i}_evidence1`, kind: "evidence", input_hash: `sha256:e${i}`, vector: fakeVector(i + 1000), tokens: { used: 120 }, source_spans: [{ start: 0, end: 60 }], disclosure: disclosure("T2", `证据片段 ${i} 中间细节`) },
  ];
  generation.writeGenerationViews(manifest, fragId, `sha256:scale${i}`, views);
  if (i % 50 === 0) log(`  wrote ${i}/${N}`);
}
const writeMs = performance.now() - t0;
log("finalize + activate...");
generation.finalizeGeneration(gid);
generation.activateGeneration(gid);
delta.resetDeltaForActiveGeneration();

log("warmup search...");
await handlers.handleSearch({ query: "电梯 状态机", top_k: 5 });
log("measuring searches...");
const samples = [];
for (let r = 0; r < 5; r++) {
  const s0 = performance.now();
  await handlers.handleSearch({ query: `查询 ${r}：电梯状态机交互与门系统`, top_k: 5 });
  samples.push(performance.now() - s0);
}
log("done, samples:", samples.map((v) => v.toFixed(1)).join(","));
samples.sort((a, b) => a - b);
const pct = (f) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * f))];
const sum = samples.reduce((a, b) => a + b, 0);

const genDir = path.join(ROOT, "memory", "embedding_generations", gid);
let bytes = 0;
if (fs.existsSync(genDir)) {
  for (const f of fs.readdirSync(genDir)) bytes += fs.statSync(path.join(genDir, f)).size;
}

console.log(JSON.stringify({
  fragments: N,
  search_avg_ms: +(sum / samples.length).toFixed(2),
  search_p50_ms: +pct(0.5).toFixed(2),
  search_p95_ms: +pct(0.95).toFixed(2),
  search_min_ms: +samples[0].toFixed(2),
  search_max_ms: +samples.at(-1).toFixed(2),
  generation_write_ms: +writeMs.toFixed(1),
  generation_bytes_kb: +(bytes / 1024).toFixed(1),
}));
