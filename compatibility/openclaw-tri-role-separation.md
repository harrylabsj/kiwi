# OpenClaw 三角色集成分离（战略 v2.5 §6.8）

当前实现存在三种不同 OpenClaw 调用方向，必须在命名空间、凭据、会话、状态目录
与工具所有权上彻底分离（§6.8 迁移规则：不同 package/plugin ID、工具前缀、
token scope、session key 与 state directory；旧工具至少经历"标记 deprecated →
提供迁移映射 → 遥测确认低使用 → 移除"，禁止静默改义）。OpenClaw 迁移是未来
重新启用 OpenClaw 产品化接入前的强制 gate，不阻塞 Hermes + DeepSeek Harness
首批 Pilot。

## 当前状态（shopping-cli OpenClaw 插件，2026-08-16）

`shopping-cli/plugins/shopping-plugin/`（openclaw.plugin.json）暴露 5 个工具，
三角色混在同一插件：

| 现有工具 | 实际角色 | 问题 |
|---|---|---|
| `shopping_create_merchant` | Merchant 运营 | 与 Buyer 混装 |
| `shopping_add_product` | Merchant 运营 | 与 Buyer 混装 |
| `shopping_buyer_ask` | Buyer 咨询 | 应迁入 `kiwi-buyer-openclaw` |
| `shopping_record_intent` | Buyer 咨询 | 应迁入 `kiwi-buyer-openclaw` |
| `shopping_run_merchant_agent` | Merchant 运营 | 应迁入 `kiwi-merchant-openclaw` |

## 目标三命名空间（§6.8）

| 目标组件 | 调用方向 | 允许职责 | 明确禁止/迁移 |
|---|---|---|---|
| `kiwi-buyer-openclaw`（工具 `kiwi_buyer_*`） | Host→Kiwi Buyer | 采购意图、Merchant discovery、RFQ/negotiation task、审批与结果呈现 | 不得管理商家本地运营 |
| `kiwi-merchant-openclaw`（现有 `shopping_*` merchant 工具迁移） | Host→Kiwi Merchant Runtime | 商品/库存/政策/人工审核/本地运营 | 逐步移出跨 Merchant Buyer 编排；`shopping_buyer_*` 设 deprecation window |
| `kiwi-reasoning-openclaw-acp` | Kiwi→Host/ACP | 只生成不可信 DecisionCandidate | 不得持有 Commerce token、最终写权限或绕过审批；独立 session/state |

## 迁移映射（当前 → 目标）

| 当前 | 目标 | 迁移 |
|---|---|---|
| `shopping_buyer_ask` | `kiwi-buyer-openclaw` → `kiwi_buyer_search` / `kiwi_buyer_request_quotes` | 复用 kiwi-buyer-mcp 同一 Buyer Core（§6.3 单核心多包装）；`shopping_buyer_*` 标记 deprecated |
| `shopping_record_intent` | `kiwi-buyer-openclaw` → `kiwi_buyer_request_quotes`（CommerceIntent） | 同上 |
| `shopping_create_merchant` / `shopping_add_product` / `shopping_run_merchant_agent` | `kiwi-merchant-openclaw`（`kiwi.merchant.*`） | 保留商家运营职责，迁出 Buyer 编排 |
| — | `kiwi-reasoning-openclaw-acp` | 只生成 DecisionCandidate（参考 DeepSeek Harness 受限 ReasoningBackend 模式） |

## 隔离纪律（§6.8 / §7.7）

- Buyer token 不得访问 Merchant Ops；Merchant Ops token 不得获得 Buyer Principal Memory。
- 三类集成使用不同 package/plugin ID、工具前缀、token scope、session key 与
  state directory。
- 旧工具禁止静默改义：deprecated → 迁移映射 → 遥测确认低使用 → 移除。
- OpenClaw 接入仅在 Hermes 产品证据门 + DeepSeek Harness contract gate 通过后
  按真实采用重新启用（§十一 Phase 2 / Phase 4）。
