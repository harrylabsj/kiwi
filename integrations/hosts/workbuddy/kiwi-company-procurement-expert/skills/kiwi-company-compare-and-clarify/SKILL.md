---
name: kiwi-company-compare-and-clarify
description: Compare authoritative quotes and reference prices, identify missing facts, and clarify or re-quote the exact merchant and active offer.
---

# 比选、澄清与报价更新

调用 `kiwi_compare_quotes` 保存快照，用 `kiwi_get_comparison` 读历史及当前时效。财务金额以核心返回的分值为准；完整金额为空时写待核对。严格区分正式报价、平台结算快照、页面参考和导入材料。先看物料、数量、交付、含税金额和企业硬约束，再看价格。限购、未核实优惠以及整箱超购情景不可直接进入正式推荐。供货主体关系不明时说明未知，不能把两个店铺直接作两家。

用报价快照中的定向问题。Kiwi 来源才可用 `kiwi_negotiate`，必带 candidate_id、expected_offer_digest、comparison_ref 和稳定 request_id；澄清只选该报价的真实缺项。还价必须给出独立授权的 CNY 目标单价、整数分和 net／gross 口径。出现 approval_required 后由宿主确认，带原 approval_id 重试。同一 logical request 的超时不换 request_id。普通回复可以归档，但“收到”和未回答字段应保留为缺项。

商业条款需要新报价时，向同一已绑定商家用 `kiwi_request_quotes` 定向重询，带 replaces_source_id 及新逻辑幂等键。保留历史。礼貌联系电商商家时使用草稿和用户回传路径。比较过期或事实变化时按当前 case revision 刷新。

金额和追问处理见 `references/comparison.md`。
