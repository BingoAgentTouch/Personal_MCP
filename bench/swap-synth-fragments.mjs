// 生成 6 对 0.95 档合成片段（几乎同义、细节不同）到临时评估库 fragments/2026-08-11/
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = "C:/Users/K4233/AppData/Local/Temp/mem_swap095/memory/fragments/2026-08-11";
fs.mkdirSync(BASE, { recursive: true });

// [id, 任务, 主题, 结论, 原文]
const pairs = [
  // swap013 superseded：服务器 IP 新旧版本
  ["frag_001", "生产服务器地址更新", "服务器配置", "生产服务器地址已更新：当前 IP 192.168.1.50，端口 8080，SSH 用户 admin，2026 年 8 月起生效，旧地址作废。", "用户确认新服务器地址，8 月起使用。"],
  ["frag_002", "生产服务器地址更新", "服务器配置", "生产服务器地址：当前 IP 192.168.1.40，端口 8080，SSH 用户 admin，2026 年 3 月起生效，旧地址作废。", "用户确认新服务器地址，3 月起使用。"],
  // swap014 superseded：项目预算新旧版本
  ["frag_003", "项目A 预算审批", "项目管理", "项目A 预算（2026-08 执行版）：开发 30 万、美术 15 万、预留 5 万，总额 50 万。", "8 月执行批预算审批通过。"],
  ["frag_004", "项目A 预算审批", "项目管理", "项目A 预算（2026-03 计划版）：开发 50 万、美术 25 万、预留 5 万，总额 80 万。", "3 月计划版预算提出。"],
  // swap015 superseded：生图模型切换
  ["frag_005", "生图主力模型确定", "工具链", "生图主力模型 gpt-image-2，编辑走 edits 端点；gpt-image-1 保留备用。", "模型切换为 gpt-image-2。"],
  ["frag_006", "生图主力模型确定", "工具链", "生图主力模型 gpt-image-1，编辑走 edits 端点；pollinations 保留备用。", "模型确认为 gpt-image-1。"],
  // swap016 superseded：Hera 连接配置变更
  ["frag_007", "Hera 连接配置更新", "自动化测试", "Hera 连接 ws://localhost:8765，token hera-2026，超时 30 秒。", "连接地址更新。"],
  ["frag_008", "Hera 连接配置更新", "自动化测试", "Hera 连接 ws://localhost:8080，token hera-2025，超时 30 秒。", "连接地址确认。"],
  // swap017 entity-aliasing：HomeDoor 交互属性
  ["frag_009", "building_floor 模板 HomeDoor 定位", "场景继承", "building_floor 模板的 HomeDoor：玩家家门入口，带 InteractionArea 双保险。", "确认 HomeDoor 是家门入口。"],
  ["frag_010", "building_floor 模板 HomeDoor 定位", "场景继承", "building_floor 模板的 HomeDoor：普通装饰门，无交互仅视觉。", "确认 HomeDoor 是装饰门。"],
  // swap018 entity-aliasing：特殊楼层标记
  ["frag_011", "特殊楼层功能标记", "楼层设计", "特殊楼层：1F 有保安室、B1 有钥匙、20F 禁上行。", "确认特殊楼层功能。"],
  ["frag_012", "特殊楼层功能标记", "楼层设计", "特殊楼层：1F 无保安室、B1 无钥匙、20F 禁上行。", "确认特殊楼层功能。"],
];

for (const [id, task, topic, conclusion, raw] of pairs) {
  const md = `# 任务：${task}

**日期**：2026-08-11
**轮次**：turn_0001 ~ turn_0002
**标签**：\`合成\`
**主题**：${topic}

## 摘要

${conclusion}

## 结论

${conclusion}

## 原文

[用户]：记录一下。

[AI]：${raw}
`;
  fs.writeFileSync(path.join(BASE, `${id}.md`), md, "utf8");
  fs.writeFileSync(path.join(BASE, `${id}.meta.json`), JSON.stringify({ importance: 0.5, ease: 2.5, interval: 1, repetition: 0, last_hit_at: null }, null, 2), "utf8");
}
console.log("合成片段写入:", fs.readdirSync(BASE).filter((f) => f.endsWith(".md")).length, "个 md");
