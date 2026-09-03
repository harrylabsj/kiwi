---
name: kiwi-buyer
description: Kiwi Sourcing & Negotiation Kit：当用户想采购一般商品、寻找供应商、询价、比价、议价或询问交期/MOQ 时使用。通过 kiwi-buyer-mcp 完成发现、询价、磋商、非绑定协议与交易 handoff。
version: 0.1.0
author: harrylabsj
license: Apache-2.0
metadata:
  hermes:
    tags: [commerce, sourcing, procurement, rfq, negotiation, mcp, kiwi, 购买, 采购, 购物, buy, shopping]
    category: commerce
---

# Kiwi Buyer（Sourcing & Negotiation Kit）

Kiwi 提供跨商家发现、询价和商业磋商能力。宿主 Agent 负责对话和用户确认；Kiwi 负责商家发现、A2A/KNP 磋商及非绑定协议。Kiwi 不处理支付，不创建订单，不锁定库存。

Buyer 只经 catalog 发现商家，再通过 A2A 直连 merchant；不要检查或直连本地 marketplace、`shopping-cli` 或 `127.0.0.1` 服务。

## 工具流程

| 用户意图 | 工具 |
|---|---|
| 找商家或供应商 | `kiwi_search` |
| 询价或要报价 | `kiwi_request_quotes` |
| 查看报价和任务状态 | `kiwi_get_task` |
| 还价或澄清 | `kiwi_negotiate` |
| 接受非绑定协议 | `kiwi_accept_agreement` |
| 读取协议和审计信息 | `kiwi_get_agreement` |
| 生成 checkout、PO 或联系入口 | `kiwi_handoff` |
| 用户确认后批准 | `kiwi_approve` |
| 拒绝审批 | `kiwi_reject` |

典型流程：

1. `kiwi_search` 发现候选供应商。
2. `kiwi_request_quotes` 发起询价，必须提供幂等键和合法 `CommerceIntent`。
3. `kiwi_get_task` 查看报价、部分失败或待审批状态。
4. 必要时使用 `kiwi_negotiate` 进行还价或澄清。
5. `kiwi_accept_agreement` 接受条款；如果返回 `approval_required`，先向用户展示候选、条款和金额，获得明确确认后调用 `kiwi_approve`，再携带 `approval_id` 重试。
6. 使用 `kiwi_get_agreement` 核对协议和 digest，再调用 `kiwi_handoff`。

## CommerceIntent 规则

只传递完成采购所必需的字段，不要把聊天历史、Host Memory、邮箱或无关个人资料放入 intent。每个商品必须有短商品词和对象形式的数量：

```json
{
  "intent_type": "purchase",
  "items": [{ "query": "保温杯", "quantity": { "value": 2, "unit": "个" } }],
  "constraints": { "currency": "CNY", "deadline": "<RFC3339>" },
  "context_projection": {
    "disclosure_boundary": "commerce_required",
    "projected_fields": ["items", "constraints"]
  }
}
```

商品 `query` 优先使用短词，规格放入 `constraints` 或 `preferences`，避免目录匹配失败。

## 授权与错误处理

- `kiwi_accept_agreement` 和 `kiwi_handoff` 默认需要用户授权；不得让模型自行批准。
- `authorization_denied`、`approval_denied` 是硬拒绝，不要自动重试。
- `task_not_found`、`task_expired` 需要重新查询或重新询价。
- `partial_success` 时保留成功报价，并单独提示失败项。
- 交易 handoff 只生成后续入口；在用户付款前应核验目标 URL，并明确说明 Kiwi 本身没有完成支付或下单。
