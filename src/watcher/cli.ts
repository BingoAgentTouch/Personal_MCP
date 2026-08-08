// ============================================================
// watcher/cli.ts — 历史回填独立入口
//
// 用法：
//   npx tsx src/watcher/cli.ts            # 等同 --backfill
//   npx tsx src/watcher/cli.ts --backfill
//
// 回填历史 raw turns 的 implicit_reject 信号。
// 不启动轮询定时器，执行完即退出。
// ============================================================

import { backfill } from "./index.js";

backfill();
console.error("[watcher] backfill 完成");
