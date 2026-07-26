// 回填脚本：为没有 frag_NNN.meta.json 的历史片段补写默认权重 meta。
// 老片段缺 meta 时检索会走缺失兼容（默认 importance=0.5，中性无害），
// 所以本脚本不是必须；跑一遍只是让磁盘状态显式化、便于后续手动调 importance。
//
// 必须从「记忆库所在的项目根目录」运行，存储层用 path.resolve("memory/...") 相对 cwd 定位。
//   用法： cd <项目根> && node D:/AgentStore/memory-mcp-server/backfill_meta.mjs
//
// 幂等：已存在 meta.json 的片段跳过，不覆盖已有 importance。
import * as fs from "node:fs";
import { listAllFragmentIds, metaPath, writeMeta, DEFAULT_META } from "./dist/storage/fragments.js";

const ids = listAllFragmentIds();
console.log(`发现 ${ids.length} 个片段，检查 meta...`);

let written = 0;
let skipped = 0;
for (const fragId of ids) {
	const [date, id] = fragId.split("/");
	if (fs.existsSync(metaPath(date, id))) {
		skipped++;
		continue;
	}
	writeMeta(date, id, { ...DEFAULT_META });
	console.log(`  ✓ ${fragId}  写入默认 meta（importance=${DEFAULT_META.importance}）`);
	written++;
}

console.log(`\n完成：${written} 个补写，${skipped} 个已存在跳过。`);
