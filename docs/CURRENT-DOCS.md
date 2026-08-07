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
docs/kiwi-product-layer-refactor-rev1.1.md
```

- rev1.1 完成定义 D0–D4（统一 CLI / merchant init / publish 编排 /
  doctor 聚合 / buyer 命令面），实施顺序与"明确不做"见 §19。
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
