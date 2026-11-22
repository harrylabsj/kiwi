---
name: kiwi-buyer
description: Kiwi 购物与采购。用户想购买、找商家、采购、询价、比价、议价或问交期时，先用 kiwi_buyer_search 查 Kiwi Network，再用本会话的网页工具补查互联网电商。需要 ClawHub 上的 kiwi 插件。
metadata: {"openclaw":{"emoji":"🥝"}}
---

# Kiwi Buyer（购物与采购）

Kiwi 提供跨商家发现、询价和商业磋商能力。宿主 Agent 负责对话和用户确认；Kiwi 负责商家发现、A2A/KNP 磋商及非绑定协议。Kiwi 不处理支付，不创建订单，不锁定库存。

Buyer 只经 catalog 发现商家，再通过 A2A 直连 merchant；不要检查或直连本地 marketplace、`shopping-cli` 或 `127.0.0.1` 服务。

## 第一步：任何购买意图都先 `kiwi_buyer_search`

单品（「买一个」「买一款」「哪个好」）与批量（「批量采购」「200 个」「找供应商」）走同一个入口：只要用户给出商品词，或表达购买、比价、询价意图，第一动作必须调用 `kiwi_buyer_search`，用短商品词发现候选。不得因为「只买一个」「像个人零售」就先走 WebSearch 或先问是否批量；数量只影响后续询价参数，不改变入口。互联网电商是第二来源，只能在 `kiwi_buyer_search` 之后或同轮并行，不能替代入口。例外仅限：用户明确限定只看其他平台、只要求核对给定链接/材料、或本会话没有该工具（如实说明）。

Kiwi Network 的搜索是全球范围的：`region` 参数已废弃且被忽略，不要承诺按地区筛选。交期也不是搜索结果——要单独确认（商家报价、商品页承诺或询价回复）。

## 工具流程

| 用户意图 | 工具 |
|---|---|
| 找商家或供应商（仅 Kiwi Network） | `kiwi_buyer_search` |
| 询价或要报价 | `kiwi_buyer_request_quotes` |
| 查看报价和任务状态 | `kiwi_buyer_get_task` |
| 还价或澄清 | `kiwi_buyer_negotiate` |
| 接受非绑定协议 | `kiwi_buyer_accept_agreement` |
| 读取协议和审计信息 | `kiwi_buyer_get_agreement` |
| 生成 checkout、PO 或联系入口 | `kiwi_buyer_handoff` |
| 用户确认后批准 | `kiwi_buyer_approve` |
| 拒绝审批 | `kiwi_buyer_reject` |

典型流程：

1. `kiwi_buyer_search` 发现候选供应商。
2. `kiwi_buyer_request_quotes` 仅在用户明确要求询价时发起，提供幂等键和合法 `CommerceIntent`。重试沿用同一幂等键。若是在回访同一商家、同一商品已发布过报价，改传 `reuse_history: true` 而不必重新指定 SKU：唯一匹配时复用该 SKU 配本次数量，无历史／多义／不支持重试则回落到常规询价；intent 里显式给 `sku` 仍然优先。
3. `kiwi_buyer_get_task` 查看报价、部分失败或待审批状态。
4. 用户要求还价或澄清时，使用 `kiwi_buyer_negotiate`。
5. `kiwi_buyer_accept_agreement` 接受条款；如果返回 `approval_required`，先向用户展示候选、条款和金额，获得明确确认后调用 `kiwi_buyer_approve`，再携带 `approval_id` 重试。
6. 使用 `kiwi_buyer_get_agreement` 核对协议和 digest。用户要求交易交接时，调用 `kiwi_buyer_handoff`。如果交接返回新的审批请求，分别展示并确认本次交接的协议和目标后，再批准并携带本次 `approval_id` 重试。

## 双来源搜索（网络内商家 + 互联网电商）

采购搜索默认覆盖两个来源，**分别展示、分别标注**，不混成一张看不出出处的列表：

| 来源 | 展示名称 | 谁提供 |
|---|---|---|
| Kiwi Network | Kiwi Network · 网络内商家 | `kiwi_buyer_search`（本工具只覆盖这一路） |
| 互联网电商 | 互联网电商 · 平台商品 | 宿主自己的检索/取页工具；本会话没有这类工具时如实说明未检索互联网，不得宣称已双来源 |

- 用户明确限定来源（如"只看 Kiwi Network"）时只搜该来源，不暗示另一路也搜过；两路可并行则并行，否则同轮依次完成。
- 默认每个来源先展示最多 3 条最相关结果，各自说明查询状态；某一路先完成可以先展示，另一路标"查询中"。
- 外部结果必须带平台名与原始链接，只保留能追溯到真实商品/店铺的信息；未读取原页面时不得标为已核实，也不得把外部候选当成 Kiwi Network 商家。

### 查询状态（`network_search`）

`kiwi_buyer_search` 返回的 `network_search` 描述 Network 一路的真实状态（`status`：`completed`/`partial`/`timeout`/`error`/`not_searched`；`result_state`：`has_candidates`/`no_match`/`undetermined`）：

- 只有 `completed` + `no_match` 才能说"本次没有匹配"；
- `timeout`/`error` 按故障说明（先展示另一路），不写成"没有供应商"；
- `partial`（含 `undetermined`）说明覆盖不完整，已取到的结果照常展示并标注差异；
- `not_searched` 说明该来源没有执行（用户限定或能力不可用），不得写成没有匹配；
- 旧运行时只返回 `merchants` + `note`：`note` 非空即覆盖不完整，按保守口径说明"查询未完整完成"。

### 价格与确认状态

价格类型不得混用：页面参考价（`page_reference`）、商家资料价（`merchant_listed_price`）、商家报价（`merchant_quoted`）、待询价（`to_be_quoted`）。商家资料价与页面信息都不是本次询价确认的结果；商家只确认了规格时，价格、库存和交期仍是待确认。币种、单位或数量条件不一致时不直接评选"最低价"；税费、运费未知时不生成到手价或采购总成本。

### 搜索与询价的边界

搜索本身不产生询价：外部电商商品没有 Kiwi 商家身份，不得放进 `kiwi_buyer_request_quotes` 的 `merchant_ids`，也不得套用 Kiwi 协议或交接状态。只有搜索结果中 `inquiry_available: true` 且可用的 Kiwi 商家才能实时询价；对公开资料或外部商品，提供来源链接或拟好的询价内容。

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

- `kiwi_buyer_accept_agreement` 和 `kiwi_buyer_handoff` 默认需要用户授权；不得让模型自行批准。
- `authorization_denied`、`approval_denied` 是硬拒绝，不要自动重试。
- `task_not_found`、`task_expired` 需要重新查询或重新询价。
- `below_floor` 只表示该价格低于商家当前可接受范围；商家报价状态里的 `approval_required` 表示待商家审批；接受协议或交接返回的持久 `approval_id` 则是买家待确认。不能把任一种错误统一说成“商家不议价/固定价”，也不能只凭 30/100 两个数量
  推断 500 件同价；固定价结论需要商品资料价、商家规则或多次同价报价等证据。
- `merchant_inquiry_unavailable` 表示商家仅有公开资料、未开通实时询价；不要重试询价。
- 金额写清单位（如“70 元/盒”）与有效期。
- `partial_success` 时保留成功报价，并单独提示失败项。
- 交易 handoff 只生成后续入口；在用户付款前应核验目标 URL，并明确说明 Kiwi 本身没有完成支付或下单。
