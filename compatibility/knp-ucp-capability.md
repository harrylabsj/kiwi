# KNP 作为 UCP capability / extension（战略 v2.5 §十一 Phase 3，TO VALIDATE）

结论：KNP 宜作为 **UCP vendor-root capability**（`com.harrylabsj.kiwi.
shopping.negotiation`），不做 `extends`（vendor root 不带 extends，§25.2）。

## 评估

| 问题 | 判定 |
|---|---|
| KNP 是否复用 UCP 已有能力？ | 否——UCP 的 negotiation 主要是 capability intersection；KNP 的 RFQ/Offer/CounterOffer/Non-binding Agreement 是 Kiwi 差异化（§2.3/§4.2） |
| KNP 是否实现 UCP 的 Catalog/Cart/Checkout/Order？ | 否——Kiwi 不重定义这些（§2.4 UCP-first） |
| Vendor root 还是 extension？ | **Vendor root capability**（不 extends，因不基于某个现有 UCP capability） |
| transport 组合？ | KNP 保持 transport-composable（§4.2）：经 A2A / marketplace negotiation API 运行均可 |

## 声明（已在 Merchant UCP Profile 落地）

`buildMerchantUcpProfile`（`src/merchant/ucp-profile.ts`）声明：

```json
"capabilities": {
  "com.harrylabsj.kiwi.shopping.negotiation": [{
    "version": "1.0",
    "spec": "https://kiwi.harrylabsj.com/spec/negotiation/1.0",
    "schema": "https://kiwi.harrylabsj.com/schemas/negotiation/1.0/schema.json"
  }]
}
```

- 命名空间 authority = `kiwi.harrylabsj.com`（com.harrylabsj.kiwi 反转，§8.3）；
- spec/schema origin 与 authority 一致；
- 无 `extends`（vendor root）。

## 验证

- `tests/merchant-ucp-profile.test.ts` 断言 §8.3 命名不变量（spec/schema origin）。
- KNP 能力与 UCP Catalog 服务在 profile 中并列声明，Buyer 按需解析。

## 边界

KNP 不定义 UCP 的 Catalog/Cart/Checkout/Order；Agreement 后 handoff 到 UCP/商家
交易系统（§2.4/§5.3）。
