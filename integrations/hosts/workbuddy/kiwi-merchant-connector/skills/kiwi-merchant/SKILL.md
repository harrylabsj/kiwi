---
name: kiwi-merchant
description: Use the Kiwi merchant connector to inspect catalog and inventory, follow A2A negotiations and human reviews, read business analytics, and draft approval-gated product changes.
---

# Kiwi 商家运营工作台

面向商家运营者的只读为主工作台：查询目录/库存/磋商/人工队列/经营摘要，商品变更只生成审批候选，绝不直接执行。

## 能力边界

- 所有商品信息只含公开字段（sku、merchant_id、title、price、stock、paused）。底价、成本、利润等私密字段不会出现，也不要向用户索要；用户提到时说明这些数值只在商家本地 Vault，连接器无法也不应读取。
- 磋商记录只读自商家节点的 Kiwi Ledger，不做任何磋商动作（不回价、不接受、不拒绝）。
- 写操作只有 `merchant_draft_product_change`：返回审批候选元数据（candidate_id、status、risk、expires_at）和当前商品快照。候选生成后必须由操作者在 Kiwi 侧批准才执行；不要声称「已修改」，只能说「已生成草稿候选，等待批准」。
- 未配置经营指标后端时 `merchant_get_analytics` 返回明确错误；如实转述，不要用零值或编造数据代替。

## 工具

- `merchant_list_products()`：列出本商家目录商品（公开字段）。「我有哪些商品」用此。
- `merchant_get_product(sku, merchant_id?)`：按 SKU 读单个商品；`merchant_id` 仅作租户校验，必须等于本商家 id，不知道就省略。
- `merchant_get_inventory(sku)`：库存快照，含观察时间；回答库存时带上「截至 <observed_at>」。
- `merchant_list_a2a_negotiations(limit?)`：A2A 磋商记录（negotiation_id、相位、SKU、数量、报价、是否达成协议、时间），按时间倒序，limit 1–100 缺省 20。「有买家来磋商吗」用此。
- `merchant_list_human_reviews()`：需要人工处理的队列（升级、超预算/超底价、转人工）。
- `merchant_get_analytics(period?)`：经营摘要，period 为 1d–90d（如 7d、30d）。
- `merchant_draft_product_change(sku, changes, reason?, merchant_id?)`：生成商品变更草稿候选；changes 只放计划修改的字段（title/price/stock/description 等）。

## 错误与恢复

- 错误以 `商家操作失败（…）` 文本返回：未找到 → 核对 SKU；参数或服务校验失败 → 核对参数；凭据被拒或缺失 → 引导用户在连接器设置中重新填写令牌；暂时性错误 → 稍后重试。
- 所有返回值都是服务端当前观察，不是永恒事实；涉及价格/库存的结论注明时间口径。
