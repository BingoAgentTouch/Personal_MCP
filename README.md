# memory-mcp-server

一个给 LLM Agent(如 Claude Code)用的**分层长期记忆 MCP 服务器**。把对话沉淀成可语义检索的三层记忆,回答"我们上次聊到哪了"时能带出完整上下文。

- **本地优先**:embedding 用本地 `@xenova/transformers`(多语言 MiniLM,384 维),不依赖任何云 API。
- **分层回溯**:命中片段(L1)时自动回填当天总结(L2)和主题脉络(L3)。
- **优雅降级**:模型加载失败时退回关键词(Jaccard)检索,并在 stderr **明确告警**——不会假装正常。

---

## 记忆分层

```
memory/                     # 存储根,相对「服务器进程的工作目录(CWD)」
├── raw/<date>/turns.jsonl  # 原始对话,一字不改,全量保留
├── fragments/<date>/       # L1 任务→结果片段 (.md + .embedding 向量)
├── daily/<date>.md         # L2 每日总结
└── topics/<topic>.md       # L3 跨天主题索引
```

写入顺序:`store_turn`(逐轮) → `create_fragment`(打包几轮为一个片段,自动算 embedding) → `create_daily_summary` / `upsert_topic`(汇总)。

> **重要:存储根是相对 CWD 的**(`path.resolve("memory/...")`)。服务器进程以哪个目录为工作目录,记忆就写在那个目录的 `memory/` 下。让宿主(Claude Code 等)以「你想要记忆的项目根」为 CWD 启动本服务器。

---

## 安装 & 构建

下载安装到某个路径

```bash
npm install
npm run build      # tsc → dist/
```
（注意，CherryStudio用户可能由于该GUI的路径问题或管道问题无法直接使用，请谨慎安装）

要求 Node ≥ 20(开发用 22 验证)。

## 在 Claude Code 里注册

项目根的 `.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/绝对路径/memory-mcp-server/dist/index.js"]
    }
  }
}
```

或直接给Claude Code文件已安装的路径，让其智能注册，然后重启Claude Code。

---

## ⚠ Embedding 模型:首次运行需要它,离线环境要手动放

语义检索默认用 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`(quantized,约 118MB,多语言，中文检索排序正确)。**联网**时 transformers.js 首次运行会自动下载到:

```
node_modules/@xenova/transformers/.cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2/
```

> 想换模型：设环境变量 `MEMORY_EMBED_MODEL=<repo/model>` 即可覆盖默认（见 `src/embedding/provider.ts` 的 `MODEL_ID`）。若换成非 384 维的模型，务必回填历史片段（见下文），新旧维度/模型的向量不可混用。
>
> 早期版本用的是 `Xenova/all-MiniLM-L6-v2`(英文模型,约 23MB)——它对中文语义排序会**倒挂**(无关闲聊的 cosine 会压过正确答案),已弃用。

**如果网络访问 huggingface.co 受阻**(常见于国内/隔离网络),自动下载会以 `TypeError: fetch failed` 失败,服务器会退回关键词检索(召回质量明显下降)。此时**手动放置模型**即可,用镜像下载:

```bash
BASE="https://hf-mirror.com/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main"
DEST="node_modules/@xenova/transformers/.cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2"
mkdir -p "$DEST/onnx"
curl -sL "$BASE/config.json"           -o "$DEST/config.json"
curl -sL "$BASE/tokenizer.json"        -o "$DEST/tokenizer.json"
curl -sL "$BASE/tokenizer_config.json" -o "$DEST/tokenizer_config.json"
curl -sL "$BASE/onnx/model_quantized.onnx" -o "$DEST/onnx/model_quantized.onnx"
```

验证离线可加载:

```bash
node --input-type=module -e '
import { pipeline, env } from "@xenova/transformers";
env.allowRemoteModels = false;   // 强制只用本地缓存
const ex = await pipeline("feature-extraction","Xenova/paraphrase-multilingual-MiniLM-L12-v2",{quantized:true});
const r = await ex("你好",{pooling:"mean",normalize:true});
console.log("OK dim=", r.data.length);   // 期望 384
'
```

放好后**重启 MCP 服务器**(常驻进程,不热更新;在 Claude Code 里即重启客户端)。

### 怎么判断当前跑在哪种模式

看服务器 **stderr**:

- 看到 `[embedding] ⚠ 运行在降级模式` → 模型没加载,在用关键词检索,按上面步骤修。
- 看不到该行,`memory_search` 返回分数普遍在 **0.2+**(且同义改写也能命中)→ 语义模式正常。
- 若还在降级模式,`create_fragment` 的返回里 `embedding_mode` 会是 `"fallback"`。

---

## 回填历史片段

如果某段时间跑在降级模式,那期间的片段没有向量(或为空),且**当前存在 active embedding generation 时不能直接运行旧回填脚本**。D0 会保护性拒绝对 active generation 的写入，避免把不可变快照当作可写目录。

```bash
cd <记忆库所在的项目根>          # 必须,存储根相对 CWD
node <绝对路径>/backfill_embeddings.mjs
```

脚本仅在没有 active generation 时回填 legacy `.embedding`；如果检测到 active generation，会以非零状态退出并提示使用：

```bash
node <绝对路径>/migrate_embeddings.mjs build --generation gen_YYYYMMDD_xxx
node <绝对路径>/migrate_embeddings.mjs validate --generation gen_YYYYMMDD_xxx
node <绝对路径>/migrate_embeddings.mjs switch --generation gen_YYYYMMDD_xxx
```

当前简化模型下，服务器启动不会自动做 orphan reconcile 或后台修复；如果你怀疑 delta/base 状态不一致，直接走手动 rebuild + switch。

## Compaction archive recovery（维护者手动流程）

此流程只用于恢复一个 **C3-3B v2 compaction archive**：把 archive 中的 sealed delta 和记录的 base active pointer 原样恢复。它不是通用 JSON 修复、`migrate_embeddings.mjs` 的 rollback、orphan reconcile，也不是面向日常用户的操作。

当前没有公开的 restore CLI 或 MCP tool；仅维护者可在受控环境中调用内部 API：`verifyArchivedDelta(archivePath)`、`restoreArchivedDelta(archivePath)`、`recoverDeltaRestoreTransaction()`。**不要**手动复制 archive 文件、改写 `embedding_active.json`、删除 transaction，或把 `compact_embeddings.mjs unlock` 当作通用恢复手段。

恢复前按顺序完成：

1. 停止 MCP server 和全部写入方，记录绝对 memory root、候选 archive 路径、当前 active pointer、delta manifest/index 摘要、compaction lock，以及 `memory/embedding_delta/transactions/restore-*` 目录。
2. 对整个 memory root 做独立的字节级备份；恢复流程不会替代这一份操作前备份。
3. 只选择 `memory/embedding_delta/archive/<delta-id>-into-<target-generation-id>/` 下的 archive。它必须包含 `merge_receipt.json`、`merge_contract.json`、`manifest.json`、`delta_index.json`；有 materialized record 时还必须有对应 `vectors/` payload。
4. 先执行 `verifyArchivedDelta(archivePath)`，只有返回 `valid: true` 才能继续。v1 receipt、任意 payload/receipt/contract/pointer 校验失败都必须停止，不能尝试“修好” archive 后继续。
5. `restoreArchivedDelta(archivePath)` 会再次拒绝 source inventory 漂移、active pointer 不等于 receipt target pointer、非空的 post-compaction target delta、或已有未完成 restore transaction。满足条件后它才会恢复 archive 的 sealed delta，并最后写入 receipt base pointer。
6. 成功后确认：active pointer 等于 `receipt.pointer_snapshots.base`；live delta 的 ID/payload 等于 archive、状态为 `sealed`、兼容性正常；target generation 与 archive 均仍存在；没有遗留 `restore-*` transaction。

正常调用返回 `{ restored: true, idempotent: false }`；若已经完全处于 archive 记录的 base+sealed-delta 状态，会返回 `{ restored: false, idempotent: true }`。若出现 `recovery_failed: true`，保留其 `transaction_path`、archive、pointer/manifest 快照和错误输出，**不要重跑 restore 或手动清理**；由维护者先调用一次 `recoverDeltaRestoreTransaction()`。多个 restore transaction、未知 transaction schema、archive 验证失败或 recovery 再次失败都属于停止并人工检查的条件，不能 force-unlock。

当没有有效 archive、source 已变化或 pointer 状态不满足恢复前提时，走受控 rebuild：

```bash
node <绝对路径>/migrate_embeddings.mjs build --generation gen_YYYYMMDD_xxx
node <绝对路径>/migrate_embeddings.mjs validate --generation gen_YYYYMMDD_xxx
node <绝对路径>/migrate_embeddings.mjs switch --generation gen_YYYYMMDD_xxx
```

对真实 memory root 的复制副本演练、自动启动恢复、公开 restore CLI 和 MCP restore tool 都是后续独立授权事项；本文档不启用它们。

---

## MCP 工具一览

| 工具 | 作用 |
|---|---|
| `memory_store_turn` | 追加一轮对话到 raw(全量原文) |
| `memory_create_fragment` | 把若干轮打包成 L1 片段,自动算 embedding |
| `memory_create_daily_summary` | 写 L2 每日总结 |
| `memory_upsert_topic` | 创建/更新 L3 跨天主题索引 |
| `memory_search` | 语义检索 → 命中 L1 并回填 L2/L3 上下文 |
| `memory_get_fragment` / `memory_get_daily` / `memory_get_topic` | 按 ID 读取完整内容 |
| `memory_list_dates` | 列出所有有记录的日期 |
| `memory_get_raw_turns` | 按 exact/range/recent/all 四种互斥模式读取 L0 逐轮原文，可先按 `agent_id` 过滤 |
| `memory_consolidate_topics` | 检测中文相似 Topic；经审阅后支持 dry-run、整批预检、执行合并与 fragment 回指修复 |

### Topic 合并说明

`memory_consolidate_topics(action="execute")` 会先做整批校验。任一 active 合并组存在 source/target 冲突、非法 fragment ID、路径越界、fragment 缺失或旧 Topic 回指不唯一时，整批返回 `validated: false` 和 MCP `isError: true`，不会改写 live 文件。

`dry_run: true` 使用与正式执行相同的计划和预检，只返回 `changes`，不写文件。正式执行会更新 target、改写 fragment 回指，并把 source 主题备份到 `.trash` 后删除。

这是面向个人项目的简化维护模型：优先保证行为直白、出问题后可人工检查；不承诺工业级自动恢复或复杂维护编排。

---

## 和宿主自带记忆的分工(避免双写)

很多 Agent 宿主(如 Claude Code)自身已有一套"始终加载进上下文"的轻量记忆。本 MCP 与它**职责不同,不要重复存**:

- **宿主自带记忆** = 蒸馏后的常驻规则/偏好,需要**每个会话都在上下文里**、无需检索。少而精,一条一行。
- **本 MCP** = 可检索的**情节档案**:完整对话、任务片段、每日/主题脉络。**按需 `memory_search` 取用**,不常驻。

一条经验值得记时问自己:*它需要每个会话都在场,还是只在我去翻的时候才要?* 前者进宿主记忆(一行),后者进本 MCP(带证据的片段)。宿主里的那一行可以引用 MCP 的主题名做下钻,但不要复制正文。

---

## 仓库卫生

`memory/` 里是**原始对话逐字记录**。若把本服务器的记忆库放在某个 git 项目内,记得在该项目 `.gitignore` 忽略它,别把对话原文和向量提交进版本库:

```gitignore
/memory/
```

---

## 记忆重要性评分

新建 fragment 时请保守填写 `importance`，不要把普通记忆默认评为 0.7 以上：

- `0.35~0.4`：临时、局部、低复用信息
- `0.5`：普通可复用记忆
- `0.6~0.7`：持续有帮助或明确重要
- `0.8`：关键架构、重要约束
- `0.9~1.0`：核心事实，错误代价高，应该很少使用

历史 fragment 的 importance 不因这次规则调整而批量改写。P3 Phase 1c 检索时使用 `max(importance, earned_importance)`，earned 只提升有效重要性，不会降低已有权重。

## 已知取舍

- MiniLM 的相似度整体偏低,**0.2–0.35 就是可靠命中**,不要按 0.8 的直觉设阈值。
- 检索质量高度依赖**写入方**给的 `task_desc`/`result_desc`/片段浓缩质量——工具负责结构与召回,浓缩得好不好看用的人。
- embedding 文本 = `task_desc + result_desc + turns_text`(查询多针对结论,纳入后召回更准)。

## 开发

```bash
npm run dev      # tsx 直跑 src/index.ts
npm run check    # tsc --noEmit 类型检查
npm run watch    # 文件监听(如启用 watcher)
```
