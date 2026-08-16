---
name: kiwi-buyer
description: Kiwi Sourcing & Negotiation Kit —— 当用户出现采购、找商家、询价、比价、还价、交期/MOQ 等商业意图时，使用 kiwi-buyer-mcp 的 7 个高层工具完成跨商家发现、询价、磋商、非绑定协议与交易 handoff。UCP 处理标准商品/交易原语，Kiwi 只负责 sourcing 与商业磋商。
version: 0.1.0
author: harrylabsj
license: Apache-2.0
metadata:
  hermes:
    tags: [commerce, sourcing, procurement, rfq, negotiation, mcp, kiwi]
    category: commerce
---

# Kiwi Buyer（Sourcing & Negotiation Kit）

Kiwi 是"任何 AI Agent 都可调用的开放询价、采购与商业磋商层"。本 skill 教 Hermes
何时以及如何使用 `kiwi-buyer-mcp` 提供的 7 个高层工具。**Host Agent owns
conversation；UCP owns standard commerce primitives；Kiwi owns cross-merchant
sourcing and commercial negotiation。**

## 何时触发（Trigger）

当用户意图是以下任意一种时调用 Kiwi，而不是自己发明流程：

- 采购 / 找供应商 / 找商家：`kiwi_search`
- 询价 / 要报价：`kiwi_request_quotes`
- 比价 / 多商家比较：`kiwi_search` → `kiwi_request_quotes` → `kiwi_get_task`
- 还价 / 磋商 / 议价：`kiwi_negotiate`
- 交期 / MOQ / 售后服务条款：约束进 CommerceIntent 的 `constraints` / `preferences`
- 形成协议 / 下单意向：`kiwi_accept_agreement` → `kiwi_handoff`

## 7 个高层工具

| Tool | 作用 | 写/读 |
|---|---|---|
| `kiwi_search` | 发现候选供应商 | 读 |
| `kiwi_request_quotes` | 发起询价，返回稳定 `task_id` | 写（幂等） |
| `kiwi_get_task` | 任务状态 / 报价 / 部分失败 / 待审批 / 过期 | 读 |
| `kiwi_negotiate` | CounterOffer / Clarification（受委托轮次限制） | 写 |
| `kiwi_accept_agreement` | 接受非绑定协议（需 approval） | 写 |
| `kiwi_get_agreement` | 读取协议 + digest + 审计 | 读 |
| `kiwi_handoff` | 生成 UCP Checkout / PO / 联系路径 | 写 |

## CommerceIntent 构造

把用户自然语言映射为冻结契约（不要把对话历史/记忆塞进去）：

```json
{
  "intent_id": "hermes-<短唯一id>",
  "intent_type": "purchase",
  "items": [{ "query": "<商品描述>", "quantity": { "value": 2, "unit": "台" } }],
  "constraints": {
    "currency": "CNY",
    "budget": { "currency": "CNY", "amount_minor": 200000 },
    "delivery_location": "<地址>",
    "deadline": "<RFC3339>",
    "mandatory_requirements": ["正品", "增值税专用发票"]
  },
  "context_projection": {
    "disclosure_boundary": "commerce_required",
    "projected_fields": ["items", "constraints"]
  }
}
```

**最小披露（§5.4）**：只投影完成交易必需的字段。用户的邮箱、地址、日历、聊天、
公司文件、健康信息、Host Memory 一律不得进入 `intent` 或任何 Kiwi 工具参数。

## 授权（DelegationPolicy = ask）

`accept_nonbinding` 与 `handoff` 默认 **ASK**。当工具返回 `error approval_required:
<approval_id>` 时：

1. 向用户呈现将形成的非绑定协议摘要（接受哪个候选、条款、金额）。
2. 用户确认后，通过 Kiwi 宿主适配面的 `approveApproval(approval_id)` 记录持久审批
   （本 skill 不暴露该操作时，将 approval_id 交回 Kiwi Ops/宿主审批流）。
3. 携带 `approval_id` 重试 `kiwi_accept_agreement` / `kiwi_handoff`。

**不要**：把 host 侧的"允许"当作最终权限；不要绕过 approval；不要让 Kiwi 处理支付
（payment 恒 NEVER）。

## 错误处理

- `error task_not_found / task_expired`：任务不存在或过期，用 `kiwi_get_task` 或重新
  `kiwi_request_quotes`。
- `error contract_violation`：CommerceIntent 不符合契约，修正 intent 后重试。
- `error authorization_denied / approval_denied`：硬拒绝，不可重试；向用户说明。
- 部分失败（`partial_success`）：保留已成功候选的报价，单独提示失败项可重试。

## 演示

完整链路：`kiwi_search("USB-C 扩展坞")` → `kiwi_request_quotes(intent, merchant_ids)`
→ `kiwi_get_task(task_id)` 等报价 → 选候选 `kiwi_negotiate` 还价 →
用户确认后 `kiwi_accept_agreement` → `kiwi_get_agreement` 审计 →
`kiwi_handoff(agreement_id, approval_id, "external_checkout_url")`。
