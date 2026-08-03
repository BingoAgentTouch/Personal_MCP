// 回填脚本：用共享 tokenizer-aware builder 和真实 MiniLM 重算 embedding。
// 必须从记忆库所在项目根目录运行，因为存储层用 path.resolve("memory/...") 相对 cwd 定位。
//   用法： cd <项目根> && node D:/AgentStore/memory-mcp-server/backfill_embeddings.mjs
import * as fs from "node:fs";
import { listAllFragmentIds, getFragment, embeddingPath } from "./dist/storage/fragments.js";
import { encodeStrict } from "./dist/embedding/provider.js";
import { buildDocumentInput, sourceContentHash } from "./dist/embedding/builder.js";
import { getActiveGeneration, writeGenerationVector } from "./dist/embedding/generation.js";

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
	try {
		const built = await buildDocumentInput({
			task_desc: frag.task_desc,
			result_desc: frag.result_desc,
			tags: frag.tags,
			topic_name: frag.topic_name,
			turns_text: frag.turns_text,
		});
		const vec = await encodeStrict(built.text);
		const active = getActiveGeneration();
		if (active) {
			writeGenerationVector(active, fragId, vec, {
				source_content_hash: sourceContentHash({
				task_desc: frag.task_desc,
				result_desc: frag.result_desc,
				tags: frag.tags,
				topic_name: frag.topic_name,
				turns_text: frag.turns_text,
			}),
				input_hash: built.input_hash,
				tokens: built.tokens,
			});
		} else {
			const [date, id] = fragId.split("/");
			fs.writeFileSync(embeddingPath(date, id), JSON.stringify(vec), "utf-8");
		}
		console.log(`  ✓ ${fragId}  dim=${vec.length}`);
		ok++;
	} catch (error) {
		console.error(`  ✗ ${fragId} 编码失败：${error instanceof Error ? error.message : String(error)}`);
		skipped++;
	}
}

console.log(`\n完成：${ok} 个回填成功，${skipped} 个跳过。`);
if (skipped > 0) process.exitCode = 1;
