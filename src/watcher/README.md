# watcher — 内嵌负反馈观测层

## 用途

**watcher 是 memory-mcp-server 进程内嵌的负反馈观测层。** 它被动旁观系统的检索行为与原始对话，自动采集「检索失败 / 读错 / 用户表达不满」三类负反馈信号，写入 `memory/signals/behavior.jsonl`。

它的存在是为了补一个结构性缺口：现有 signals 只有**正信号**（谁被 surface、谁被读、谁被确认），没有**负信号**——「检索没中 / 读错了」不可观测，检索质量的降误召闭环缺了燃料。watcher 采集的负反馈，正是 P3 方案（花费驱动的检索优化）缺失的失败信号源。

**核心定位：只观测、不干预。** 信号一律标 `suspect`，只留证据，不做任何自动惩罚；等数据攒够、经人工审阅后再谈检索重排。

## 它解决什么问题

- 原 watcher（Cherry Studio 版）绑定外部 `agents.db`、且内存快照永不刷新，只抓启动瞬间数据即空转——已弃用；
- 现 watcher 改为**随 server 进程内嵌**（随会话拉起、进程退出即结束），观测源与 CLI 客户端完全解耦，换任何 CLI 都用不着改它。

## 职责边界

| 做 | 不做 |
|:--|:--|
| 观测本进程 MCP 请求流（search / get_fragment） | 不写 `memory/raw`（真实记忆归 `memory_store_turn`） |
| 观测 `memory/raw/{date}/turns.jsonl` 逐轮原文 | 不新增任何 MCP 工具 |
| 写 `signals/behavior.jsonl` + `logs/watcher.log` | 不改 tools / handlers / storage / search / embedding |
| 随 server 进程初始化启动、退出即结束 | 不依赖 LLM 主动传参 / 不读任何 CLI 会话文件 |

## 双通道架构

```
CLI agent（任意 MCP 客户端）经 stdio 拉起 memory-mcp-server 进程
   ▼
server 进程内嵌 watcher
   ├─ 通道①（请求流）：observe(name, args) → reformulate / read_then_research
   └─ 通道②（raw 原文）：每 3s 轮询 memory/raw/{date}/turns.jsonl → implicit_reject
   ▼
输出：memory/signals/behavior.jsonl + logs/watcher.log
```

- **通道①**：事件驱动。`index.ts` 的 `CallToolRequestSchema` 处理器里，`handler(args)` 之前一行 `watcher.observe(name, args)`（独立 try-catch）。每次 search / get_fragment 调用同步跑一次。
- **通道②**：定时轮询。每 3s 增量扫描 `memory/raw/` 各日期目录的新增 turn（游标 = 各文件已处理的最大 turn 序号）。

## 信号定义

| 信号 | 通道 | 触发条件 | 含义 |
|:--|:--|:--|:--|
| `reformulate` | ① | 同一会话内连续两次 `search`，query **jaccard 相似度 < 0.5**（间隔 < 10min） | 第一次没中，改了问法 |
| `read_then_research` | ① | `get_fragment` 后 30s 内又发起 `search` | 读到的不是想要的 |
| `implicit_reject` | ② | user 消息命中纠错词表；或 assistant 消息含「用户反馈：」等转述前缀、前缀后文本命中词表 | 用户明确表达不满 |

## 关键设计决策

1. **`suspect` 标记**：所有信号 `confidence: "suspect"`——推断信号可能有误（如用户对产出不满 ≠ 检索不满），只留证据，不自动惩罚；
2. **双层检测**：user 消息全文匹配词表；assistant 消息**必须先命中转述前缀**再匹配——过滤「混响不对」这类中性技术描述（AI 描述配置错误，非用户不满）；
3. **转述前缀分隔符放宽**：冒号（全/半角）、引号（双/单/全角）、或无分隔符直接接文字，三种都识别——真实数据里三种格式都存在；
4. **初始游标不回填历史**：启动时各文件游标 = 当前最大 turn 序号，只处理启动后新写入；历史回填靠独立 `--backfill` 命令；
5. **`turn_timestamp`**：implicit_reject 记录用户实际说话时间（`TurnRecord.timestamp`），离线配对以它为准，而非检测时点；
6. **去重**：连续 reformulate 只记首条；每个 get 事件只产生一次 read_then_research；
7. **异常隔离**：`observe` 同步执行、内部 try-catch 吞所有异常，任何失败不影响工具响应；
8. **best-effort + 日志轮转**：`behavior.jsonl` / `watcher.log` 写入失败不阻塞任何逻辑；日志超 1MB 自动重命名为 `.old`。

## 文件结构

| 文件 | 职责 |
|:--|:--|
| `index.ts` | 内嵌观测模块：`observe`（通道①）+ `flushChannel2`（通道②）+ 游标 + 生命周期（`startWatcher` / `stopWatcher` / `backfill` / `resetWatcherState`） |
| `words.ts` | 纠错词表（三组 23 词）+ 转述前缀（7 个）+ `detectTurn` 双层检测 |
| `cli.ts` | `--backfill` 独立入口（历史回填） |
| `README.md` | 本文档 |

## 接入与运行

- **接入**：`src/index.ts` 在 `main()` 里调用 `startWatcher()`（随进程启动）；`CallToolRequestSchema` 处理器里 `handler(args)` 前加 `watcherObserve(name, args)`（独立 try-catch）。
- **常规运行**：随 server 进程自动启动，无需独立进程。
- **历史回填**：`npm run backfill`（`tsx src/watcher/cli.ts`）——重置所有游标为 0，全量扫描已有历史 turn。

## 输出

`memory/signals/behavior.jsonl`（每条一个信号事件）：

```json
{ "ts": "...", "source": "watcher", "type": "implicit_reject",
  "agent_id": null, "date": "2026-08-05", "turn_id": "turn_0009",
  "turn_timestamp": "2026-08-05T09:40:37.143Z", "from": "user",
  "user_text": "你的理解有误，两段独白并不在同一个场景",
  "signal_word": "有误", "confidence": "suspect" }
```

离线使用时：`reformulate` / `read_then_research` 表达「检索失败」，`implicit_reject` 表达「用户语言证据」；三者按时间与 `search.jsonl` / `get_fragment.jsonl` / raw turns 配对（配对键见方案 v8 §10）。

> 完整设计见：`D:\AgentStore\基于agent的工具设计文档资料\agent记忆系统\项目开发\memory-mcp-server_观测层与负反馈信号采集方案(draft).md`（v8）。
