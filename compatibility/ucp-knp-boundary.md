# UCP / KNP 边界（§2.4 / §6.1 / §十一 Phase 3）

战略 v2.5 的边界纪律：**UCP-first**——凡是 UCP 已有稳定语义的商品目录、购物车、
结算、订单、身份连接，Kiwi 原则上不另建平行标准；Kiwi 只在多商家 sourcing、
商业询报价与协议形成存在清晰缺口时定义自己的 contract（KNP）。

## 能力层归属

| 能力层 | 首选标准/归属 | Kiwi 策略 | Kiwi 侧验证 |
|---|---|---|---|
| 商品搜索与商品事实 | UCP Catalog + Merchant source of truth | 调用/索引，不重定义商品 truth model | `MarketplaceMerchantIndex` 只做路由，商品 truth 留在 marketplace/merchant |
| Cart / Checkout / Order | UCP | 直接复用；Agreement 后 handoff 到 UCP/商家交易系统 | `kiwi_handoff` 只产出 handoff_ref，不实现 checkout |
| 跨 Merchant 发现与路由 | Kiwi Sourcing Index | 验证、freshness、ranking、供应商筛选 | `kiwi_search` + catalog 注册 |
| RFQ / Offer / CounterOffer | KNP | Kiwi 核心差异化；pre-transaction negotiation | `kiwi_request_quotes` / `kiwi_negotiate` |
| Agent-to-Agent 通信 | A2A / UCP bindings | 兼容现有标准，transport 不作专有层 | marketplace conversations + negotiation API |
| Host Agent 集成 | MCP + Plugin/SDK | 统一 Buyer Kit 北向 | `kiwi-buyer-mcp` 7 工具 |

## 不变量（machine-checkable，见 `tests/mcp-facade.test.ts` "UCP/KNP boundary"）

1. **MCP 工具词表固定为 7 个高层 Sourcing Tools**（`KIWI_SOURCING_TOOLS`）；
   不暴露 KNP 底层消息（send_offer/evaluate_condition/resolve_capabilities 等），
   不复制 UCP primitives（catalog/cart/checkout/order）。
2. **三副作用恒 false**：Agreement 的 `creates_order` / `authorizes_payment` /
   `reserves_inventory` 恒为 false（KNP/1.0 §16；v2.5 延续）。
3. **payment 恒 never**：DelegationPolicy 的 payment 动作恒 never（KNP 不进入支付）。
4. **商品 truth 不落 Kiwi**：candidate 只携带 merchant 回复引用 + reply_text，
   Kiwi 不持有/不编造价格库存。
5. **协议 transport 可组合**：KNP 经 marketplace negotiation API 运行，保持
   transport-composable（§4.2）。

## KNP 范围（§4.2 / §7.1）

KNP 专注 Inquiry、RFQ、Offer、CounterOffer、ConditionalOffer、Clarification、
AcceptNonbinding 与 Agreement；**不重新定义** UCP 的 Catalog、Cart、Checkout、
Order。评估以 UCP-compatible vendor root capability / extension 形式对外声明
（§十一 Phase 3，TO VALIDATE）。
