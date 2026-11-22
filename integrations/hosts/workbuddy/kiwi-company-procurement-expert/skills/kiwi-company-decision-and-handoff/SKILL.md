---
name: kiwi-company-decision-and-handoff
description: Deliver the procurement decision brief, record a sourced external decision, and handle separately authorized Kiwi follow-up.
---

# 采购建议与交接

用当前比选生成采购建议、CSV 与 Markdown。写明需求基准、两路覆盖、候选与证据、金额及有效期、推荐或不推荐原因、待澄清项和下一步。缺足够信息时报告缺项及负责人。预计差额与成交节省分开。历史快照可读，发现过期仅提示复核。多行逐项汇报，整单运费或折扣未确定时保持总额未知。

用户回传领导意见、邮件或审批单时，用 `kiwi_prepare_procurement` 的 record_external_decision，带原件位置、比选版本、选定来源与事项版本。标明外部决定及其出处。通过 `kiwi_get_procurement` 检查复核提示。事项在用户明确结束后 set_state，关闭需交付引用及结果类型；取消停止新外发，继续归档已发请求的真实回执。

只有用户明确要求时才按原生 Kiwi 授权使用 `kiwi_accept_agreement`、`kiwi_get_agreement`、`kiwi_handoff`。外部决定不能用于协议审批。区分非约束协议、后续交接、订单和支付。电商入口为可供用户办理的来源或链接。订阅只在用户明确要求时使用 `kiwi_follow_merchant`、`kiwi_unfollow_merchant`、`kiwi_list_follows` 或 `kiwi_get_follow_updates`。

导出与办结见 `references/delivery.md`。
