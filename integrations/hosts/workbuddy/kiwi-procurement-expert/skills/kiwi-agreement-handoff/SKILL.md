---
name: kiwi-agreement-handoff
description: Confirm selected Kiwi nonbinding terms with the buyer, handle persistent approvals and provide a verified handoff without placing orders or paying.
---

# 协议确认与交接

仅适用于真实的 Kiwi 任务与协议。互联网电商商品没有 Kiwi 商家身份，不能进入本流程：既不能说「已达成协议」，也不能为它生成 checkout/PO/联系入口——只提供原始商品链接或拟好的询价内容。

用户选定商家后，以 `kiwi_get_task` 的最新候选为依据，展示商家、商品规格、数量、币种/金额、交期、未决条款及“非约束性协议”性质。只有用户明确确认这些条款后才请求接受；“推荐哪家”不代表接受。

## 接受协议

1. 调用 `kiwi_accept_agreement(task_id, candidate_id, approval_id?)`，candidate_id 必须来自当前任务。
2. 若返回结构化 `{ "approval_required": { "approval_id": "..." } }`，保留真实 approval_id，核对对应动作和候选。用户已明确确认同一条款时可直接将该授权落实到 `kiwi_approve(approval_id, note?)`；未确认、条款已变化或审批指向不同动作时先询问。不得从错误文本拼接 ID，不把系统返回审批请求当成用户同意。
3. 批准后携该 `approval_id` 重试接受。用户拒绝对应待审批请求时调用 `kiwi_reject(approval_id, reason?)`，不重新申请来绕过拒绝。
4. 接受会向商家发送 `accept_nonbinding`；只有商家返回与本次报价/条款摘要一致的 agreement artifact 才算双方达成。商家拒绝（如报价过期、条款不匹配）时停止并如实说明，不生成“已达成”结论。
5. 成功后用 `kiwi_get_agreement(agreement_id)` 核对条款、来源和 digest。未成功返回协议 ID 就不能宣称已达成。

## 交接入口

用户要求生成后续办理入口时调用 `kiwi_handoff(agreement_id, destination_type, url?, approval_id?)`。合法 `destination_type`：`ucp_checkout | ucp_order | external_checkout_url | merchant_checkout_session | platform_deep_link | buyer_erp_request | procurement_request | purchase_order_draft | quote_document | merchant_contact | sales_handoff`。商家店铺结算页用 `external_checkout_url` 并带商家 handoff URL（缺省时后端会回落到条款里的 `handoff_destination`）；`ucp_checkout` 等会话类是 opaque ref，不得带 url。destination_type 和 URL 从真实协议、商家公开资料或工具结果中确认，不能猜测 checkout 路径。没有可核验目的地时说明缺失信息并停在协议摘要。

交接有独立审批，不能复用接受协议的 approval_id。出现 `approval_required` 时按上述流程处理用户对本次交接的授权；对同一未变动作的已有明确授权不重复确认。`authorization_denied` / `approval_denied` 是硬拒绝，停止该动作。

核对入口是否与选定商家一致、是否为合理的 HTTPS 地址；若无法验证可用性或返回 404，说明“入口未验证/不可用”，不诱导用户付款。若工具只返回 opaque ref 而没有可打开 URL（如 `ucp_checkout`），如实说明“无可用结算入口”，并改用商家条款里的 `handoff_destination` 以 `external_checkout_url` 生成入口。交接只提供入口或记录，不能表述为订单已创建、付款完成、库存已预留，也不能代用户提交支付表单。

最终结果中把 `agreement_id`/`handoff_id` 放到次要位置（详情或可复制行），主表突出商品、协商价、交期、是否超出用户预算；超出预算时明确标注“已由用户确认放宽”，不要只放在脚注。
