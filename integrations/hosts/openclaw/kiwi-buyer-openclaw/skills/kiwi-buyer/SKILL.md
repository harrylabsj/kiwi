---
name: kiwi-buyer
description: Kiwi 采购/询价/磋商。当用户想买一般商品、采购、找商家/供应商、询价、比价、还价、问交期/MOQ 时使用 kiwi_buyer_* 工具跨商家发现→询价→磋商→非绑定协议→handoff。需配合 ClawHub 上的 kiwi 插件使用（openclaw plugins install clawhub:kiwi，提供 kiwi_buyer_* 工具）。
metadata: {"openclaw":{"emoji":"🥝"}}
---

# Kiwi Buyer（采购 & 磋商）

用 `kiwi_buyer_*` 工具完成跨商家发现、询价、比价、磋商、非绑定协议与交易 handoff。
buyer 只经 catalog 发现、A2A 直连 merchant；**不直连 shopping-cli**（那是服务器上
merchant 才碰的）。

## 意图 → 工具映射

| 用户意图 | 工具 |
|---|---|
| 找商家 / 供应商 / 搜索商品 | `kiwi_buyer_search` |
| 发起询价 / 要报价 | `kiwi_buyer_request_quotes` |
| 看报价 / 任务状态 / 部分失败 | `kiwi_buyer_get_task` |
| 还价 / 议价 / 澄清 | `kiwi_buyer_negotiate` |
| 接受报价（形成协议）| `kiwi_buyer_accept_agreement` |
| 读协议 / 审计 | `kiwi_buyer_get_agreement` |
| 生成 checkout / PO 链接 | `kiwi_buyer_handoff` |
| 用户确认后批准审批 | `kiwi_buyer_approve` |
| 拒绝审批 | `kiwi_buyer_reject` |

## 采购流

1. `kiwi_buyer_search("商品词")` → 发现候选商家（含 matching_skus）。
2. `kiwi_buyer_request_quotes(intent, merchant_ids)` → 真实询价（含
   `idempotency_key`；CommerceIntent 的 items[].query 用商品词，不带规格噪音）。
3. `kiwi_buyer_get_task(task_id)` → 看真实报价 / 部分失败 / 待审批。
4. 需要比价/还价 → `kiwi_buyer_negotiate(task_id, action:"counter_offer", summary)`。
5. 接受 → `kiwi_buyer_accept_agreement(task_id, candidate_id)`；ASK 门返回
   `approval_required`（含 approval_id）→ **向用户呈现协议摘要，获确认后**
   `kiwi_buyer_approve(approval_id)` → 携 approval_id 重试 accept。
6. `kiwi_buyer_handoff(agreement_id, approval_id, destination_type, url)` → checkout 链接。

## 不要做

- **不要检查/等待本地 marketplace / shopping-cli / 127.0.0.1 服务**（本地宿主没有；
  buyer 不直连 shopping-cli）。
- 不要"先加载 schema / 探测环境"之类的额外步骤 —— 直接 `kiwi_buyer_search`。
- 不要让 LLM 未经用户确认就自动 `kiwi_buyer_approve`。
- Kiwi 不处理支付（payment 恒 NEVER）；不创建订单/不占库存（非绑定协议）。
- 部分失败（`partial_success`）：保留已成功候选，单独提示失败项可重试。
