---
name: kiwi-sourcing
display_name: Kiwi 采购询价
display_name_en: Kiwi Sourcing & Negotiation
description: Source products, request quotes, compare offers, and negotiate non-binding terms with suppliers.
description_zh: 查找供应商、跨商家询价、比价并协商非绑定采购条款。
description_en: Source products, request quotes, compare offers, and negotiate non-binding supplier terms.
allowed-tools: kiwi_search, kiwi_request_quotes, kiwi_get_task, kiwi_negotiate, kiwi_accept_agreement, kiwi_get_agreement, kiwi_handoff, kiwi_approve, kiwi_reject, kiwi_follow_merchant, kiwi_unfollow_merchant, kiwi_list_follows, kiwi_get_follow_updates
version: 1.0.3
author: HarryLabs
user-invocable: true
---

> 本地待审候选，不代表发布或真实商家链路已验收。连接器透传全部 13 个工具，不负责用户授权、业务审批、预算或采购范围校验；这些由上层专家和 Kiwi 后端承担。连接器不证明宿主返回代表真人同意，也不自动调用 `kiwi_approve`。工具清单没有支付工具。

# Kiwi 采购询价

当用户要找供应商、询价、比价、议价，或询问交期、起订量和售后时使用本技能。Kiwi 形成的
是非绑定商业协议：不创建订单、不支付、不锁库存，也不代表用户签署具有法律约束力的合同。

## 标准流程

1. 用 `kiwi_search` 发现候选供应商。把商品名称保持为短词，规格、预算、地区和时间要求另行整理。
2. 默认最多选择 3 家相关商家，调用 `kiwi_request_quotes`。每次写调用使用新的稳定幂等键。
3. 用 `kiwi_get_task` 查看结果。收到 `partial_success` 时保留成功报价，并明确列出失败商家。
4. 按总价、交期、MOQ、售后、币种和证据完整性比较，不只按单价排序。
5. 用户要求还价或澄清时调用 `kiwi_negotiate`，不要擅自改变预算、数量或交付底线。
6. 是否接受协议由上层专家根据任务授权和用户决策处理。只有上层专家确定已获具体协议授权后才调用 `kiwi_accept_agreement`。若 Kiwi 后端返回 `approval_required`，原样呈现其摘要/状态并按后端流程等待上层决定；不得把该返回解释为已经获批，也不得自动调用 `kiwi_approve`。只有上层专家主动发出明确的 `kiwi_approve` 工具调用时才透传该调用。
7. 用 `kiwi_get_agreement` 核对协议、摘要和 digest。
8. 只有上层专家依其授权决定需要后续入口时才调用 `kiwi_handoff`；按后端返回报告结果。连接器不会为它附加或复用审批。

参数与隐私规则见 @references/commerce-intent.md，审批规则见 @references/approval-flow.md，
异常处理见 @references/error-recovery.md。

## 工具选择

| 工具                    | 用途                         | 约束                                |
| ----------------------- | ---------------------------- | ----------------------------------- |
| `kiwi_search`           | 发现供应商                   | 只读；先于询价                      |
| `kiwi_request_quotes`   | 向候选商家询价               | 最多 3 家；提供合法 intent 和幂等键 |
| `kiwi_get_task`         | 查看任务、报价与部分结果     | 超时后优先查询，不无限重试          |
| `kiwi_negotiate`        | 还价、澄清条款               | 不越过用户明确底线                  |
| `kiwi_accept_agreement` | 接受非绑定协议               | 上层专家授权；后端返回状态           |
| `kiwi_get_agreement`    | 读取协议与审计摘要           | handoff 前核对                      |
| `kiwi_handoff`          | 生成 checkout、PO 或联系入口 | 按上层授权与后端返回处理             |
| `kiwi_approve`          | 批准待审批 action            | 仅上层专家主动调用；不得自动补调     |
| `kiwi_reject`           | 拒绝待审批 action            | 用户拒绝或条款不清时调用            |
| `kiwi_follow_merchant`  | 按买家明确要求关注供应商      | 搜索、浏览或询价不代表同意关注       |
| `kiwi_unfollow_merchant`| 取消关注供应商                | 仅在买家明确要求时调用               |
| `kiwi_list_follows`     | 列出当前关注的供应商          | 只读；需要目录登录态                 |
| `kiwi_get_follow_updates`| 查看关注商家的公开动态       | 只响应买家主动询问；拉取式，无推送   |

## 必须向用户呈现的信息

上层专家在做接受/批准决定前，应呈现商家、商品与数量、总价及币种、交期、MOQ、售后/退换条件、报价有效期、缺失信息和风险。连接器不实施此呈现规则，也不代表用户已确认。完成后准确说明后端返回的结果；handoff 不等于已下单或已付款。

## 禁止事项

- 不把 `approval_required` 当作批准，不自动调用 `kiwi_approve`；
- 不声称连接器验证了真人确认、预算、商品范围或商家范围；
- 不把同一 `approval_id` 用于不同 action、不同报价或已变化的条款；
- 不把聊天记录、联系人、地址、组织目录或 WorkBuddy 记忆整体放进采购意图；
- 不承诺 Kiwi 已下单、已付款、已锁库存或已签署合同；
- 不因某一家超时而丢弃其他商家的有效报价；
- 不自动无限重试写操作。
