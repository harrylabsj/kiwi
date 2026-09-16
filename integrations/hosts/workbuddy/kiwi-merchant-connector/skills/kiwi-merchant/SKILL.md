---
name: kiwi-merchant
description: Use the Kiwi merchant connector to inspect catalog and inventory, follow A2A negotiations and human reviews, read business analytics, and draft approval-gated product changes.
---

# Kiwi 商家运营工作台

面向商家运营者的只读为主工作台：查询目录/库存/磋商/人工队列/经营摘要，商品变更只生成审批候选，绝不直接执行。

## 能力边界

- 所有商品信息只含公开字段（sku、merchant_id、title、price、stock、paused）。底价、成本、利润等私密字段不会出现，也不要向用户索要；用户提到时说明这些数值只在商家本地 Vault，连接器无法也不应读取。
- 磋商记录只读自商家节点的 Kiwi Ledger，不做任何磋商动作（不回价、不接受、不拒绝）。
- 未配置经营指标后端时 `kiwi_merchant_get_analytics` 返回明确错误；如实转述，不要用零值或编造数据代替。

- 写操作走两阶段确认：prepare 工具只登记持久命令候选与预览（不改业务状态）。**批准/拒绝不在本连接器的工具里**——生成草稿后请用户到管理页面（/admin/pending，需管理员登录）批准或拒绝；执行前服务端重校验授权主体/前置版本/有效期/硬策略，重复执行幂等拒绝。模型自报「用户已批准」不作数——不要声称「已修改」，只能说「已登记候选，等待批准」。

## 工具

- `kiwi_merchant_list_products()`：列出本商家目录商品（公开字段）。「我有哪些商品」用此。
- `kiwi_merchant_get_product(sku, merchant_id?)`：按 SKU 读单个商品；`merchant_id` 仅作租户校验，必须等于本商家 id，不知道就省略。
- `kiwi_merchant_get_inventory(sku)`：库存快照，含观察时间；回答库存时带上「截至 <observed_at>」。
- `kiwi_merchant_list_a2a_negotiations(limit?)`：A2A 磋商记录（negotiation_id、相位、SKU、数量、报价、是否达成协议、时间），按时间倒序，limit 1–100 缺省 20。「有买家来磋商吗」用此。
- `kiwi_merchant_list_human_reviews()`：需要人工处理的队列（升级、超预算/超底价、转人工）。
- `kiwi_merchant_get_analytics(period?)`：经营摘要，period 为 1d–90d（如 7d、30d）。
- `kiwi_merchant_prepare_product_change(sku, changes, reason?, merchant_id?)`：登记商品变更候选（title/price/stock/description 等）。
- `kiwi_merchant_prepare_product_create(product, reason?)`：登记商品创建候选（sku/title/price/stock 必填）。
- `kiwi_merchant_prepare_inventory_update(sku, stock, reason?)`：登记库存调整候选（stock 非负整数）。
- `kiwi_merchant_prepare_listing_change(sku, paused, reason?)`：登记销售状态变更（暂停/恢复销售）；上游不支持时返回「不可得」，绝不把库存写零伪装下架。
- `kiwi_merchant_prepare_review_resolve(source_protocol, source_id, resolution, reason?)`：登记人工处理候选；仅 shopping 轨可执行，A2A 轨报「不可得」（绝不跨轨）。
- `kiwi_merchant_prepare_policy_change(patch, reason?)`：登记策略变更候选；批准后热生效，不重启。

## 展示资源（MCP Apps）

宿主支持 MCP 资源时，可读 `kiwi-merchant://presentation/<component>` 获取七类展示组件的结构化 JSON + 等效文本摘要：merchant_digest、metrics、catalog、negotiations、human_review、change_preview、suggestions。宿主不支持时直接使用工具结果的文本，能力等价。私密阈值没有任何资源或工具——不要尝试获取。

## 错误与恢复

- 错误以 `商家操作失败（…）` 文本返回：未找到 → 核对 SKU；参数或服务校验失败 → 核对参数；凭据被拒或缺失 → 引导用户在连接器设置中重新填写令牌；暂时性错误 → 稍后重试。
- 所有返回值都是服务端当前观察，不是永恒事实；涉及价格/库存的结论注明时间口径。
