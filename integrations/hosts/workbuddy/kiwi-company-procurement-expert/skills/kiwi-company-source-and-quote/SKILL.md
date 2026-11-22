---
name: kiwi-company-source-and-quote
description: Create a company procurement case, discover Kiwi and accessible e-commerce products, attach evidence and prepare a single-merchant RFQ.
---

# 需求与寻源询价

1. 用 `kiwi_prepare_procurement` 的 create 保存单行原始需求。多行先 register_group，每行以原始行 ID 单独 create，使用 `kiwi_get_procurement` get_group 恢复和汇总。指定型号用 exact_item，按规格用 spec_based。采用正整数和用户给出的单位、到货日期及地区。为每条公司条件保留用户依据、硬软属性和披露权限。
2. 单独记录 Kiwi Network 网络内商家和互联网电商的覆盖。`kiwi_search` 的 `network_search` 只有 `completed` 且 `no_match` 才代表本次无匹配。区分 `merchant_listed_price`、`page_reference`、`merchant_quoted`、`to_be_quoted`。用于电商搜寻的宿主工具缺席、访问失败或需登录时，列出缺失状态，可邀请用户交来链接、报价或材料。
3. attach_sources 登记真实 Kiwi merchant_id、对应候选的 SKU 和搜索词，或记录电商平台变体与原件依据。公开页面填写采集时间和原件定位，只有搜索摘要时标成线索。访问账号、验证码与专享价格由宿主实际能力决定。
4. `kiwi_request_quotes` 只向一个已登记、可实时询价的商家发送，带当前 case_id、revision、source_binding_id、稳定 idempotency_key。拿到 approval_required 后检查预览，并在用户要求继续时调用 `kiwi_approve` 触发宿主确认，拒绝时用 `kiwi_reject`。批准后以同一输入和 approval_id 重试。用 `kiwi_get_task` 和事项状态恢复结果。一个商家失败时保留其他渠道。

字段与示例见 `references/sourcing.md`。
