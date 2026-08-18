---
name: kiwi-buyer
description: Kiwi Sourcing & Negotiation Kit —— 采购/购买/购物一般商品（非餐饮、非外卖、非生鲜）时使用：用户想"买 X"（如买保温杯、充电器、办公用品、工业品，含预算/数量/交期要求），找商家/供应商、询价、比价、还价、问交期/MOQ。经 kiwi-buyer-mcp 的 9 个工具完成跨商家发现 → 询价 → 磋商 → 非绑定协议 → handoff。餐饮/食品/外卖/生鲜请用 eleme-ordering；本 skill 覆盖一般商品采购。
version: 0.1.0
author: harrylabsj
license: Apache-2.0
metadata:
  hermes:
    tags: [commerce, sourcing, procurement, rfq, negotiation, mcp, kiwi, 购买, 采购, 购物, buy, shopping, 找商家]
    category: commerce
---

# Kiwi Buyer（Sourcing & Negotiation Kit）

Kiwi 是"任何 AI Agent 都可调用的开放询价、采购与商业磋商层"。本 skill 教 Hermes
何时以及如何使用 `kiwi-buyer-mcp` 提供的 7 个高层工具。**Host Agent owns
conversation；UCP owns standard commerce primitives；Kiwi owns cross-merchant
sourcing and commercial negotiation。**

## 职责边界（设计理念）

```
本地宿主（Hermes/OpenClaw，无 marketplace 服务）            公网                  阿里云服务器
  hermes ─▶ kiwi buyer ──catalog.kiwi.harrylabsj.com──▶ kiwi-catalog（发现）
             │  A2A/KNP 直连                              │
             └──────────────────────────────────────────▶ kiwi merchant
                                                          │ 唯一可直接调用
                                                          ▼
                                                     shopping-cli（真实商品/库存）
```

- **buyer 在本地、宿主无关**：kiwi-buyer-mcp 跑在 Hermes / OpenClaw / 其他通用
  Agent 侧；只经 `catalog.kiwi.harrylabsj.com` 发现商家，然后 **A2A 直连 merchant**
  磋商。buyer **不直连 shopping-cli**。
- **merchant + shopping-cli 在服务器**：kiwi merchant 是 shopping-cli 的唯一消费者；
  只有 kiwi merchant 可直接调用 shopping-cli。shopping-cli 绑 127.0.0.1 对外不可达。
- 完整部署见 `docs/deploy/local-buyer-aliyun-merchant.md`。

**不要做的（常见误解）**：
- **不要检查/等待任何本地 marketplace / shopping-cli / 127.0.0.1 服务** —— 本地宿主没有
  marketplace 服务；buyer **不直连 shopping-cli**（那是服务器上 merchant 才碰的）。
- **不要"先加载工具 schema / 先探测环境 / 先查目录之外"之类的额外步骤** —— 直接调
  `kiwi_search`（内部已走 catalog 发现），发现后按工具链 A2A 磋商即可。

## 何时触发（Trigger）

当用户意图是以下任意一种时调用 Kiwi，而不是自己发明流程：

- 采购 / 找供应商 / 找商家：`kiwi_search`
- 询价 / 要报价：`kiwi_request_quotes`
- 比价 / 多商家比较：`kiwi_search` → `kiwi_request_quotes` → `kiwi_get_task`
- 还价 / 磋商 / 议价：`kiwi_negotiate`
- 交期 / MOQ / 售后服务条款：约束进 CommerceIntent 的 `constraints` / `preferences`
- 形成协议 / 下单意向：`kiwi_accept_agreement` → `kiwi_handoff`

## 9 个高层工具（含审批面）

| Tool | 作用 | 写/读 |
|---|---|---|
| `kiwi_search` | 发现候选供应商 | 读 |
| `kiwi_request_quotes` | 发起询价，返回稳定 `task_id` | 写（幂等） |
| `kiwi_get_task` | 任务状态 / 报价 / 部分失败 / 待审批 / 过期 | 读 |
| `kiwi_negotiate` | CounterOffer / Clarification（受委托轮次限制） | 写 |
| `kiwi_accept_agreement` | 接受非绑定协议（ASK 时返回 `approval_required`） | 写 |
| `kiwi_get_agreement` | 读取协议 + digest + 审计 | 读 |
| `kiwi_handoff` | 生成 UCP Checkout / PO / 联系路径 | 写 |
| `kiwi_approve` | 批准持久审批（用户确认后调用） | 写 |
| `kiwi_reject` | 拒绝持久审批（deny 优先路径） | 写 |

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

`accept_nonbinding` 与 `handoff` 默认 **ASK**。宿主流程：

1. `kiwi_accept_agreement`（无 approval_id）→ **结构化返回** `{ approval_required:
   { approval_id } }`（不是 isError；approval_id 是 first-class 值）。
2. 向用户呈现将形成的非绑定协议摘要（接受哪个候选、条款、金额）。
3. 用户确认后，调 `kiwi_approve(approval_id, note?)` 记录持久审批；用户拒绝则
   `kiwi_reject(approval_id, reason?)`（deny 优先，拒绝后不可再批准）。
4. 携带 `approval_id` 重试 `kiwi_accept_agreement` / `kiwi_handoff`（handoff 需
   独立的 action=handoff 审批）。

**不要**：把 host 侧的"允许"当作最终权限；不要绕过 approval；不要让 LLM 未经
用户确认就自动 `kiwi_approve`（必须先在对话里呈现协议摘要并获确认）；不要让 Kiwi
处理支付（payment 恒 NEVER）。`kiwi_approve`/`kiwi_reject` 是写操作，受宿主审批
系统二次拦截。

## 错误处理

- `error task_not_found / task_expired`：任务不存在或过期，用 `kiwi_get_task` 或重新
  `kiwi_request_quotes`。
- `error contract_violation`：CommerceIntent 不符合契约，修正 intent 后重试。
- `error authorization_denied / approval_denied`：硬拒绝，不可重试；向用户说明。
- 部分失败（`partial_success`）：保留已成功候选的报价，单独提示失败项可重试。
- `merchant has no agent card URL` 误报（观察到的坑，2026-08）：当 `kiwi_request_quotes` 显式传
  `merchant_ids` 时，Kiwi 内部仍会用 intent 的商品 query 重新搜索商家来解析 id；query 带规格词
  （如"保温杯 316不锈钢 500ml"）时目录 LIKE 匹配不到，回退成缺 `agent_card_url` 的对象，误报该
  错误且重试无效。规避：把 intent 的商品 query 写成短词（如"保温杯"），或先用 `kiwi_search`
  短词发现商家再定向询价。根因是"按 id 定向解析"缺失（service.ts:287-297），catalog 侧数据完好。
- 交接前验证 checkout URL：演示商家（如 Veyquo）的 `kiwi_handoff` 链接可能返回 404（checkout
  端点未实现），付款前用 `curl -sS -o /dev/null -w "%{http_code}" <url>` 验证，404 时如实告知
  用户该链接可能无法真实下单，再决定是否继续。

## 演示

完整链路：`kiwi_search("USB-C 扩展坞")` → `kiwi_request_quotes(intent, merchant_ids)`
→ `kiwi_get_task(task_id)` 等报价 → 选候选 `kiwi_negotiate` 还价 →
用户确认后 `kiwi_accept_agreement` → `kiwi_get_agreement` 审计 →
`kiwi_handoff(agreement_id, approval_id, "external_checkout_url")`。
