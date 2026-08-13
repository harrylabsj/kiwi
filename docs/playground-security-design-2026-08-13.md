# Live Playground 安全设计 + 受控预览（Issue 16 #4 / §7.2）

> 状态：**Design**。Playground 必须晚于确定性本地 Demo（`kiwi demo`，Issue 13 已交付）。
> 本文把 §7.2 的每项要求映射到具体机制（尽量复用既有原语），作为受控预览的实现蓝本。
> **不直接开放生产写入**。

## 目标

让外部 Agent 开发者在隔离、限流、无真实写入的环境里体验 KNP 磋商闭环
（RFQ → Agreement → Handoff），产出可观测的互操作证据，同时把滥用/越权/成本
风险压到可接受下限。

## 安全要求 → 机制映射

| §7.2 要求 | 机制 |
| --- | --- |
| 每会话隔离 | 每 Playground 会话独立临时目录（`mkdtemp`）+ 独立 SQLite/ledger + 独立 A2A 端口；会话结束时整体删除（复用 `kiwi demo` 的隔离模式）。 |
| 身份与租户隔离 | 入站认证默认 loopback-only + 可选 bearer；merchant 归属以 `allowed_merchant_id` 为租户边界（Adapter SDK 跨租户防护同款）；每个会话一个 buyer/merchant 身份。 |
| 速率限制和成本上限 | 复用 `A2AServerThrottle`（identity/domain 窗口 + malformed budget）；会话级成本上限（请求数 / 轮次 / LLM 代币——Playground 默认确定性协议演示，**无 LLM 调用**，成本≈0）。 |
| 请求体、轮次、并发、transcript 上限 | `maxPayloadBytes`（默认 1 MiB）；每会话协商轮次上限（如 64）；并发协商上限；transcript 事件数上限（哈希链超限拒写）。 |
| 无真实支付/checkout/ERP 写权限 | 三副作用恒 false（agreement + HandoffCandidate）；`import-csv-excel` / ERP 同步在 Playground 只读预演或禁用；外部写默认审批，不执行。 |
| 滥用检测、审计、日志脱敏、自动过期 | 审计事件（audit_events 模式）落盘；日志经 secret 扫描器脱敏（复用 `assertNoForbiddenContent` 思路）；会话 TTL（如 24h）后自动过期清理。 |
| 可重复的固定演示场景 | 复用 `DEMO_SCENARIOS`（a/b）固定价格/交期/审批，输出可复现 transcript（确定性 JCS 哈希链）。 |
| 明确标识 participant | 会话元数据标注 `mock`（内置 demo 商家）/ `self-operated`（Veyquo 托管）/ `external`（第三方 Agent）；UI/API 输出显式暴露该标注。 |

## 部署形态（受控预览）

1. **本地**：`kiwi demo`（已交付）——确定性、零成本、无公网。
2. **受控托管（beta）**：单一实例，每会话隔离 + 限流 + TTL；仅对邀请的外部
   Agent 开发者开放；不做生产数据接入。
3. **不开放**：无公开注册、无生产写入、无真实支付/ERP 连接。

## 攻击面清单（验收对应）

| 攻击 | 防护 | 验证 |
| --- | --- | --- |
| 越权读他人会话 | 每会话临时目录 + 独立端口；身份 bearer 绑定 | 会话 A token 访问会话 B → 拒绝 |
| 限流绕过 | identity/domain 窗口 + malformed budget | 高频请求 → rate_limited |
| 成本轰炸 | 无 LLM 调用（确定性协议）；请求/轮次/并发上限 | 超限 → 拒绝 |
| 隐私泄露 | 日志脱敏（secret 不入 transcript/日志） | transcript 无 api_key/password/CoT |
| 残留 | 会话 TTL 自动过期 + 清理 | TTL 后目录删除 |

## 与 Issue 13（Demo）的关系

- Demo = 确定性本地闭环（已交付，`kiwi demo`）。
- Playground = Demo 的**受控托管超集**：加会话隔离 + 限流 + TTL + 审计 + participant
  标注。Playground 之前，先用 Demo 验证 Time-to-Wow 与流程正确性。

## 未决（需产品决策）

- 托管实例的部署位置（Veyquo 商业层 or 独立测试实例）；
- external participant 的凭证模型（静态 bearer vs 可验证身份）；
- 是否开放只读 catalog（mock 商品 vs 商家真实 listing 只读镜像）。
