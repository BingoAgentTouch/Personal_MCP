// 回填脚本：为已有片段用真实 MiniLM 重算 embedding，覆盖此前降级模式写下的 []。
// 必须从「记忆库所在的项目根目录」运行，因为存储层用 path.resolve("memory/...") 相对 cwd 定位。
//   用法： cd <项目根> && node D:/AgentStore/memory-mcp-server/backfill_embeddings.mjs
import * as fs from "node:fs";
import { listAllFragmentIds, getFragment, embeddingPath } from "./dist/storage/fragments.js";
import { encode, isFallbackMode } from "./dist/embedding/provider.js";

const ids = listAllFragmentIds();
console.log(`发现 ${ids.length} 个片段，开始回填...`);

let ok = 0;
let skipped = 0;
for (const fragId of ids) {
	const frag = getFragment(fragId);
	if (!frag) {
		console.error(`  ✗ ${fragId} 读取失败，跳过`);
		skipped++;
		continue;
	}
	// 与 handler 保持完全一致的编码文本公式
	const text = `${frag.task_desc}\n${frag.result_desc}\n${frag.turns_text}`;
	const vec = await encode(text);
	if (vec.length === 0) {
		console.error(`  ✗ ${fragId} 编码为空（降级模式？），跳过。请先确认模型已缓存。`);
		skipped++;
		continue;
	}
	const [date, id] = fragId.split("/");
	fs.writeFileSync(embeddingPath(date, id), JSON.stringify(vec), "utf-8");
	console.log(`  ✓ ${fragId}  dim=${vec.length}`);
	ok++;
}

if (isFallbackMode()) {
	console.error("\n⚠ 当前处于降级模式，未写入任何真实向量。检查上面的 [embedding] 报错。");
	process.exit(1);
}
console.log(`\n完成：${ok} 个回填成功，${skipped} 个跳过。`);
