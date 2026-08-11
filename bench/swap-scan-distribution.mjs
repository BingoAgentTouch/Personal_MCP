import { pathToFileURL } from "node:url";
process.chdir("D:/ProjectGame/避难末日demo");
const generation = await import(pathToFileURL("D:/AgentStore/memory-mcp-server/src/embedding/generation.ts").href);
const fragments = await import(pathToFileURL("D:/AgentStore/memory-mcp-server/src/storage/fragments.ts").href);

const active = generation.getActiveGeneration();
console.log("active:", active.generation_id, "| dim:", active.dimension);
const index = generation.readGenerationIndex(active.generation_id);
const fragIds = Object.keys(index);
console.log("fragments:", fragIds.length);

const vecs = new Map();
const topics = new Map();
for (const fid of fragIds) {
  const views = generation.readGenerationMultiviewViews(active.generation_id, fid, index[fid], active.dimension, "light");
  if (!views) { console.log("  ! read fail:", fid); continue; }
  const summary = views.find((v) => v.kind === "summary");
  if (!summary) { console.log("  ! no summary:", fid); continue; }
  const f = fragments.getFragment(fid);
  vecs.set(fid, summary.vector);
  topics.set(fid, f ? (f.topic_name ?? "(none)") : "(none)");
}
const ids = [...vecs.keys()];
console.log("with vector:", ids.length);

const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};
const binOf = (s) => s < 0.5 ? "lt0.5" : s < 0.7 ? "0.5-0.7" : s < 0.85 ? "0.7-0.85" : s < 0.95 ? "0.85-0.95" : "ge0.95";
const bins = { "lt0.5": 0, "0.5-0.7": 0, "0.7-0.85": 0, "0.85-0.95": 0, "ge0.95": 0 };
const sameTopic = { "lt0.5": 0, "0.5-0.7": 0, "0.7-0.85": 0, "0.85-0.95": 0, "ge0.95": 0 };
const crossTopic = { "lt0.5": 0, "0.5-0.7": 0, "0.7-0.85": 0, "0.85-0.95": 0, "ge0.95": 0 };
const hotPairs = [];
let total = 0;
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const s = cos(vecs.get(ids[i]), vecs.get(ids[j]));
    const b = binOf(s);
    bins[b]++; total++;
    if (topics.get(ids[i]) === topics.get(ids[j])) sameTopic[b]++;
    else crossTopic[b]++;
    if (s >= 0.7) hotPairs.push({ a: ids[i], b: ids[j], sim: s, sameTopic: topics.get(ids[i]) === topics.get(ids[j]), topic: topics.get(ids[i]) });
  }
}
console.log("\n=== all pairs distribution (" + total + " pairs) ===");
for (const [k, v] of Object.entries(bins)) console.log("  " + k + ": " + v + " (" + (v / total * 100).toFixed(1) + "%)");
const stTotal = Object.values(sameTopic).reduce((a, b) => a + b, 0);
const ctTotal = Object.values(crossTopic).reduce((a, b) => a + b, 0);
console.log("\n=== same-topic pairs (" + stTotal + ") ===");
for (const [k, v] of Object.entries(sameTopic)) console.log("  " + k + ": " + v);
console.log("\n=== cross-topic pairs (" + ctTotal + ") ===");
for (const [k, v] of Object.entries(crossTopic)) console.log("  " + k + ": " + v);
console.log("\n=== hot pairs sim>=0.7 (" + hotPairs.length + ") ===");
hotPairs.sort((x, y) => y.sim - x.sim);
for (const p of hotPairs.slice(0, 15)) console.log("  " + p.sim.toFixed(3) + " [" + (p.sameTopic ? "same" : "cross") + "] " + p.a.split("/")[1] + " ~ " + p.b.split("/")[1] + " (topic: " + p.topic + ")");
console.log("\n=== topic distribution ===");
const tcount = {};
for (const t of topics.values()) tcount[t] = (tcount[t] ?? 0) + 1;
for (const [t, c] of Object.entries(tcount).sort((a, b) => b[1] - a[1])) console.log("  " + t + ": " + c);
