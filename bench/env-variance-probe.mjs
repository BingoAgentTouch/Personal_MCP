// 环境波动探针：同机同脚本连续多轮，测 search / 写入 / 纯CPU / 纯磁盘 / encode 的波动
// 运行: node --import tsx bench/env-variance-probe.mjs
import { performance } from "node:perf_hooks";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-envprobe-"));
process.chdir(ROOT);
const provider = await import("../src/embedding/provider.ts");

// 系统快照
function sysSnap() {
  const la = os.loadavg()[0];
  const cpus = os.cpus();
  const speed = cpus.reduce((a, c) => a + c.speed, 0) / cpus.length; // MHz
  const freeMem = os.freemem() / 1e9;
  const mu = process.memoryUsage();
  return { load1: +la.toFixed(2), cpuMHz: Math.round(speed), freeGB: +freeMem.toFixed(1), rssMB: +(mu.rss / 1e6).toFixed(0) };
}

// 纯 CPU 基准（无 IO、无模型）：固定迭代数学运算
function cpuBench() {
  const t0 = performance.now();
  let x = 0;
  for (let i = 0; i < 5e6; i++) x += Math.sin(i * 0.37) * Math.cos(i * 0.11);
  return performance.now() - t0;
}

// 纯磁盘写基准：连续写 50 个小文件（模拟 writeGenerationViews 的原子写模式）
function diskBench(n = 50) {
  const dir = path.join(ROOT, "diskprobe");
  fs.mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const fp = path.join(dir, `f${i}.json`);
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ i, data: "x".repeat(2000) }));
    fs.renameSync(tmp, fp); // 与 generation.ts atomicWrite 同模式
  }
  return performance.now() - t0;
}

async function encodeBench() {
  const t0 = performance.now();
  await provider.encode("电梯 状态机 交互 门系统 性能测试"); // 固定中文 query
  return performance.now() - t0;
}

await provider.encode("预热");
console.error("[probe] model warmed, root=", ROOT);

const ROUNDS = 8;
const rows = [];
for (let r = 0; r < ROUNDS; r++) {
  const cpu = cpuBench();
  const disk = diskBench(50);
  const enc = await encodeBench();
  const snap = sysSnap();
  rows.push({ round: r, cpu_ms: +cpu.toFixed(1), disk50_ms: +disk.toFixed(1), encode_ms: +enc.toFixed(1), ...snap });
  // 每轮间隔 2s，观察是否有后台周期性干扰
  await new Promise((res) => setTimeout(res, 2000));
}

console.log(JSON.stringify(rows, null, 2));

// 波动统计
function stats(key) {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  return { min: v[0], max: v.at(-1), ratio: +(v.at(-1) / v[0]).toFixed(2) };
}
console.log("=== 波动比(max/min) ===");
console.log("CPU  :", JSON.stringify(stats("cpu_ms")));
console.log("DISK :", JSON.stringify(stats("disk50_ms")));
console.log("ENC  :", JSON.stringify(stats("encode_ms")));
console.log("CPU MHz 轨迹:", rows.map((r) => r.cpuMHz).join(","));
console.log("load1 轨迹:", rows.map((r) => r.load1).join(","));
console.log("freeGB 轨迹:", rows.map((r) => r.freeGB).join(","));

fs.rmSync(ROOT, { recursive: true, force: true });
