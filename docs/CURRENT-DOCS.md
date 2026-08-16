# CURRENT DOCS — Kiwi Commerce

## Released v0.6.0

These remain the released v0.6.0 authority and are NOT superseded by the v0.7.0 draft:

```text
docs/kiwi-a2a-architecture-baseline.md
docs/protocol/kiwi-negotiation-protocol-1.0.md
```

## Current v0.7.0 Draft

```text
docs/kiwi-commerce-v0.7.0-architecture-draft-rev1.5.md
docs/products/kiwi-catalog-product-architecture-v0.4.md
docs/products/shopping-cli-commerce-data-hub-v0.3.md
docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md
docs/protocol/kiwi-transaction-handoff-0.1-rev0.3.md
docs/testing/kiwi-commerce-v0.7.0-test-plan-v0.3.md
```

## Product Strategy（非协议，独立版本）

```text
docs/kiwi-agent-commerce-strategy-upgrade-2026-08-13.md
docs/kiwi-product-layer-refactor-rev1.2.md
```

## Northbound（PILOT DRAFT，v0.1）

```text
docs/kiwi-buyer-mcp-facade-v0.1.md
```

## Compatibility（Phase 3 语义不变量）

```text
compatibility/ucp-knp-boundary.md
compatibility/host-harness-matrix.md
compatibility/merchant-three-plane.md
compatibility/openclaw-tri-role-separation.md
compatibility/knp-ucp-capability.md
```

- UCP/KNP 边界：能力层归属 + machine-checkable 不变量（工具词表、三副作用 false、
  payment never、商品 truth 不落 Kiwi、transport 可组合）。
- Host/Harness Matrix：跨宿主语义不变量（schema/授权门/脱敏/幂等/恢复/错误分类/
  协议摘要/版本兼容）+ 接入方向矩阵（Hermes/DeepSeek Harness/resident daemon/
  kiwi runtime 当前状态）。
- Merchant 三 Plane：shopping-cli 的 Commerce / Merchant Core / Intelligence&Ops
  映射（§7.5），Failure rule 验证（`scripts/pilot/merchant-three-plane-check.sh`：
  Intelligence 离线时 RFQ 报价 / human_required 升级 / 运营 resolve 均工作）。
- OpenClaw 三角色分离（§6.8）：当前 shopping-plugin 混装 buyer/merchant 工具 →
  `kiwi-buyer-openclaw` / `kiwi-merchant-openclaw` / `kiwi-reasoning-openclaw-acp`
  目标映射 + 迁移规则（future OpenClaw gate）。
- KNP 作为 UCP capability（Phase 3 TO VALIDATE）：vendor-root capability 判定 +
  §8.3 命名不变量。

- `docs/kiwi-buyer-mcp-facade-v0.1.md`：战略 v2.5 北向面薄 facade —— 四份冻结
  Northbound 契约（CommerceIntent/DelegationPolicy/EffectiveAuthorization/
  PersistentTask）、7 个高层 Sourcing Tools、持久 Task/Approval 存储、五层授权
  deny 优先、MCP stdio server（`kiwi mcp serve`）。契约 schema 单一来源在
  `contracts/`，运行时校验 `src/contracts/northbound-schema.ts`。
- 与 `kiwi-agent-commerce-strategy-upgrade-2026-08-13.md`：已批准的三产品战略升级与执行基线；
  统一产品定位、协议分层、P0/P1/P2 顺序、阶段门、验收标准和对外声明纪律。
- rev1.2：D0–D4 全部实现（readiness audit 见
  `docs/reviews/kiwi-product-layer-readiness-audit-2026-08-07.md`）；
  实施顺序与"明确不做"见 §19。
- 文档版本独立于产品版本（v0.6.0 released / v0.7.0 draft）。

## Version identity

- File mtime is NOT a version authority.
- `status`, `doc_revision`, product version, Git commit/tag, and this manifest determine document identity.
- **2026-08-07 版本回退**：产品版本由 v1.0.0 回退为 v0.6.0（git tag v0.6.0）；
  v1.1 Draft 随之更名为 v0.7.0 Draft。KNP/1.0、kiwi-catalog/1.0 等协议与契约
  身份不变；历史 rev 归档文档保留当时命名，身份以本清单与 git tag 为准。
- KNP wire protocol remains `1.0`; `rev1.4` is an editorial/errata revision.
- KTH protocol draft remains `0.1`; `rev0.3` is the current document revision.
- `selected_nonbinding` is OPTIONAL before Handoff.
- Candidate content is immutable; lifecycle is an event-sourced projection.
- kiwi-catalog state is three-dimensional: Verification / Freshness / Administrative.

## Implementation status (2026-08-07)

- v0.7.0 completion definition: **CD #1–21 evidenced** (rev1.4.1 baseline,
  readiness audit: `docs/reviews/kiwi-commerce-v0.7.0-readiness-audit-2026-08-07.md`)
  + **CD #22–28 evidenced** (rev1.5 Product-first Discovery, readiness audit:
  `docs/reviews/kiwi-commerce-v1.1-product-first-readiness-audit-2026-08-07.md`).
  28/28 全部有直接实证；v0.7.0 仍未宣布发布。
- New CLI: `kiwi catalog serve` (standalone kiwi-catalog service),
  `kiwi metrics --dir <agent-dir>` (KTH metrics).
- New chat TUI commands: `/handoff`, `/handoff-launch <handoff_id> <negotiation_id>`,
  `/handoff-open <handoff_id> <negotiation_id>`.
- v0.7.0 remains a **Draft**; the audit does not announce a release.
