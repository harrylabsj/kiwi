# Kiwi Buyer Core（战略 v2.5 §6.3 / Appendix A）

"单核心、多包装"：所有商业判断（intent、policy、merchant-routing、rfq、
negotiation、agreement、ucp-handoff、persistent task/approval）都在 Buyer Core。

```
src/buyer-core/          ← 单核心（本目录）
├── service.ts             KiwiBuyerService：确定性状态机 + 五层授权 + 幂等
├── store.ts               TaskApprovalStore（node:sqlite 持久 task/approval/agreement）
├── errors.ts              McpError 类型化错误（跨宿主语义不变量）
├── merchant-index.ts      KiwiCatalogMerchantIndex（listings 感知发现）/
│                          MarketplaceMerchantIndex（marketplace 商品 FTS 路由）
├── quote-fetcher.ts       MarketplaceQuoteFetcher（shopping-cli 真实 RFQ fan-out）
├── negotiator.ts          MarketplaceNegotiator（shopping-cli 真实磋商 counter）
├── a2a-quote-fetcher.ts   A2AQuoteFetcher（catalog 发现 → A2A 直连 merchant RFQ）
├── a2a-negotiator.ts      A2ANegotiator（A2A 直连 merchant CounterOffer）
├── a2a-knp.ts             A2A KNP 信封构造/提取助手（fetcher/negotiator 共用）
└── build-service.ts       buildBuyerService（包装注入统一入口）

src/mcp/   ← MCP adapter（薄：server/tools/cli，只做 manifest/tool/transport）
src/http/  ← HTTP adapter（薄：server/cli，同一核心）
```

包装层只负责 manifest、tool description、路由与传输；任何业务判断都回到
buyer-core。未来新宿主接入 = 写一个薄适配器（§6.3）。
