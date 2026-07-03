# memory-mcp-server

一个给 LLM Agent(如 Claude Code)用的**分层长期记忆 MCP 服务器**。把对话沉淀成可语义检索的三层记忆,回答"我们上次聊到哪了"时能带出完整上下文。

- **本地优先**:embedding 用本地 `@xenova/transformers`(MiniLM,384 维),不依赖任何云 API。
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

```bash
npm install
npm run build      # tsc → dist/
```

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

---

## ⚠ Embedding 模型:首次运行需要它,离线环境要手动放

语义检索依赖 `Xenova/all-MiniLM-L6-v2`(quantized,约 23MB)。**联网**时 transformers.js 首次运行会自动下载到:

```
node_modules/@xenova/transformers/.cache/Xenova/all-MiniLM-L6-v2/
```

**如果网络访问 huggingface.co 受阻**(常见于国内/隔离网络),自动下载会以 `TypeError: fetch failed` 失败,服务器会退回关键词检索(召回质量明显下降)。此时**手动放置模型**即可,用镜像下载:

```bash
BASE="https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main"
DEST="node_modules/@xenova/transformers/.cache/Xenova/all-MiniLM-L6-v2"
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
const ex = await pipeline("feature-extraction","Xenova/all-MiniLM-L6-v2",{quantized:true});
const r = await ex("hello",{pooling:"mean",normalize:true});
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

如果某段时间跑在降级模式,那期间的片段没有向量(或为空)。修好模型后,一次性回填:

```bash
cd <记忆库所在的项目根>          # 必须,存储根相对 CWD
node <绝对路径>/backfill_embeddings.mjs
```

脚本会遍历所有片段、用真实模型重算并覆盖 `.embedding`,末尾打印成功/跳过数;若仍在降级模式会非零退出并提示。

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
