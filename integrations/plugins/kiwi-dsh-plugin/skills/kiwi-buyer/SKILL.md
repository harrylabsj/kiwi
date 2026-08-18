---
name: kiwi-buyer
description: Kiwi Sourcing & Negotiation Kit（DeepSeek Harness 版）—— 采购/购买/购物一般商品（非餐饮、非外卖、非生鲜）时使用。
when_to_use: 用户表达采购意图（买/找供应商/询价/比价/还价/交期/MOQ）时
user-invocable: true
metadata:
  category: commerce
  tags: [commerce, sourcing, procurement, rfq, negotiation, mcp, kiwi, 购买, 采购, 购物]
---

# Kiwi Buyer（Sourcing & Negotiation Kit）· DeepSeek Harness 版

Kiwi 是"任何 AI Agent 都可调用的开放询价、采购与商业磋商层"。本 skill 教 DSH
何时以及如何使用 `mcp__kiwi__*` 工具。**Host Agent（DSH）owns conversation；
Kiwi owns cross-merchant sourcing and commercial negotiation。**

## 职责边界

- **buyer 在本地、宿主无关**：`kiwi mcp serve` 跑在 DSH 侧，只经
  `catalog.kiwi.harrylabsj.com` 发现商家，然后 **A2A 直连 merchant** 磋商。
- **merchant + shopping-cli 在服务器**：只有 kiwi merchant 可直接调用 shopping-cli
  （真实商品/库存）；buyer 不直连 shopping-cli。

**不要做的**：
- **不要检查/等待任何本地 marketplace / shopping-cli / 127.0.0.1 服务**。
- **不要"先加载工具 schema / 先探测环境"之类的额外步骤** —— 直接调
  `mcp__kiwi__kiwi_search`。

## 9 个工具（DSH 前缀 `mcp__kiwi__`）

| DSH 工具名 | 作用 | 写/读 |
|---|---|---|
| `mcp__kiwi__kiwi_search` | 发现候选供应商 | 读 |
| `mcp__kiwi__kiwi_request_quotes` | 发起询价，返回稳定 `task_id` | 写（幂等） |
| `mcp__kiwi__kiwi_get_task` | 任务状态 / 报价 / 待审批 / 过期 | 读 |
| `mcp__kiwi__kiwi_negotiate` | CounterOffer / Clarification | 写 |
| `mcp__kiwi__kiwi_accept_agreement` | 接受非绑定协议（ASK 时返回 approval_required） | 写 |
| `mcp__kiwi__kiwi_get_agreement` | 读协议 + digest + 审计 | 读 |
| `mcp__kiwi__kiwi_handoff` | 生成成交入口（checkout/PO/联系路径） | 写 |
| `mcp__kiwi__kiwi_approve` | 批准持久审批 | 写 |
| `mcp__kiwi__kiwi_reject` | 拒绝持久审批（deny 优先） | 写 |

## 触发链

- 采购/找供应商 → `mcp__kiwi__kiwi_search`
- 询价/要报价 → `mcp__kiwi__kiwi_request_quotes`
- 比价 → `search` → `request_quotes` → `get_task`
- 还价/议价 → `mcp__kiwi__kiwi_negotiate`
- 交期/MOQ → 约束进 CommerceIntent 的 `constraints` / `preferences`
- 协议/下单意向 → `accept_agreement` → `handoff`

## CommerceIntent 构造（最小披露）

`mcp__kiwi__kiwi_request_quotes` 的 intent 必须满足冻结契约：**intent.items 每项
必须有 `query`（商品短词）与 `quantity`（`{value, unit}` 对象）**。缺字段或
quantity 不是对象会返回 `contract_violation`。

```json
{
  "intent_id": "dsh-<短唯一id>",
  "intent_type": "purchase",
  "items": [{ "query": "<短商品词，如 保温杯>", "quantity": { "value": 2, "unit": "台" } }],
  "constraints": {
    "currency": "CNY",
    "budget": { "currency": "CNY", "amount_minor": 200000 },
    "delivery_location": "<地址>",
    "deadline": "<RFC3339>"
  },
  "context_projection": {
    "disclosure_boundary": "commerce_required",
    "projected_fields": ["items", "constraints"]
  }
}
```

只投影完成交易必需的字段。用户的邮箱、地址、聊天、Host Memory 一律不得进入
`intent` 或任何工具参数。**商品 query 写短词**（如"保温杯"而非"保温杯 316不锈钢
500ml"）——长规格词会命中不到 catalog 的 title/category LIKE，导致商家丢
agent_card_url 误报 `merchant has no agent card URL`。

## 授权（DelegationPolicy = ask）

1. `mcp__kiwi__kiwi_accept_agreement`（无 approval_id）→ 返回 `{ approval_required:
   { approval_id } }`（不是 isError）。
2. 向用户呈现协议摘要（候选/条款/金额）。
3. 用户确认后 `mcp__kiwi__kiwi_approve(approval_id, note?)`；拒绝则
   `mcp__kiwi__kiwi_reject(approval_id, reason?)`（deny 优先）。
4. 携带 `approval_id` 重试 `accept_agreement` / `handoff`。

**不要**绕过 approval；不要未经用户确认自动 `kiwi_approve`；Kiwi 不处理支付
（payment 恒 NEVER）。

## 错误处理

- `task_not_found / task_expired`：重查或重新询价。
- `contract_violation`：修正 intent（补 query、quantity 改 `{value,unit}` 对象）后重试。
- `authorization_denied / approval_denied`：硬拒绝，不可重试。
- `partial_success`：保留成功报价，失败项单独重试。
- `merchant has no agent card URL`：把商品 query 改短词后重试。
- 交接前验证 checkout URL：`kiwi_handoff` 链接可能 404（演示商家 checkout 未实现），
  `curl -sS -o /dev/null -w "%{http_code}" <url>` 验证，404 时如实告知用户。

## 演示

`mcp__kiwi__kiwi_search("USB-C 扩展坞")` → `kiwi_request_quotes` → `kiwi_get_task`
等报价 → 选候选 `kiwi_negotiate` 还价 → 用户确认后 `kiwi_accept_agreement` →
`kiwi_get_agreement` 审计 → `kiwi_handoff`。
