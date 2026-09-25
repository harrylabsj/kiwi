---
name: kiwi-buyer
description: Kiwi Sourcing & Negotiation Kit：当用户想采购一般商品、寻找供应商、询价、比价、议价或询问交期/MOQ 时使用。通过 kiwi-buyer-mcp 完成发现、询价、磋商、非绑定协议与交易 handoff。
version: 0.2.0
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
| 找商家或供应商（仅 Kiwi Network） | `kiwi_search` |
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

## 双来源搜索（网络内商家 + 互联网电商）

采购搜索默认覆盖两个来源，**分别展示、分别标注**，不混成一张看不出出处的列表：

| 来源 | 展示名称 | 谁提供 |
|---|---|---|
| Kiwi Network | Kiwi Network · 网络内商家 | `kiwi_search`（本工具只覆盖这一路） |
| 互联网电商 | 互联网电商 · 平台商品 | 宿主自己的检索/取页工具；本会话没有这类工具时如实说明未检索互联网，不得宣称已双来源 |

- 用户明确限定来源（如"只看 Kiwi Network"）时只搜该来源，不暗示另一路也搜过；两路可并行则并行，否则同轮依次完成。
- 默认每个来源先展示最多 3 条最相关结果，各自说明查询状态；某一路先完成可以先展示，另一路标"查询中"。
- 外部结果必须带平台名与原始链接，只保留能追溯到真实商品/店铺的信息；未读取原页面时不得标为已核实，也不得把外部候选当成 Kiwi Network 商家。

### 查询状态（`network_search`）

`kiwi_search` 返回的 `network_search` 描述 Network 一路的真实状态（`status`：`completed`/`partial`/`timeout`/`error`/`not_searched`；`result_state`：`has_candidates`/`no_match`/`undetermined`）：

- 只有 `completed` + `no_match` 才能说"本次没有匹配"；
- `timeout`/`error` 按故障说明（先展示另一路），不写成"没有供应商"；
- `partial`（含 `undetermined`）说明覆盖不完整，已取到的结果照常展示并标注差异；
- `not_searched` 说明该来源没有执行（用户限定或能力不可用），不得写成没有匹配；
- 旧运行时只返回 `merchants` + `note`：`note` 非空即覆盖不完整，按保守口径说明"查询未完整完成"。

### 价格与确认状态

价格类型不得混用：页面参考价（`page_reference`）、商家资料价（`merchant_listed_price`）、商家报价（`merchant_quoted`）、待询价（`to_be_quoted`）。商家资料价与页面信息都不是本次询价确认的结果；商家只确认了规格时，价格、库存和交期仍是待确认。币种、单位或数量条件不一致时不直接评选"最低价"；税费、运费未知时不生成到手价或采购总成本。

### 搜索与询价的边界

搜索本身不产生询价：外部电商商品没有 Kiwi 商家身份，不得放进 `kiwi_request_quotes` 的 `merchant_ids`，也不得套用 Kiwi 协议或交接状态；需要时只提供原始链接或拟好的询价内容。

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
- `merchant_inquiry_unavailable` 表示该商家仅有第 0 版公开资料、未开通实时询价；
  不要重试询价，改为展示其公开资料与店铺入口。
- `partial_success` 时保留成功报价，并单独提示失败项。
- 交易 handoff 只生成后续入口；在用户付款前应核验目标 URL，并明确说明 Kiwi 本身没有完成支付或下单。
