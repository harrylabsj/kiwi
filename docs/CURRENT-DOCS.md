# CURRENT DOCS — Kiwi Commerce

## Released v1.0

These remain the released v1.0 authority and are NOT superseded by the v1.1 draft:

```text
docs/kiwi-a2a-architecture-baseline.md
docs/protocol/kiwi-negotiation-protocol-1.0.md
```

## Current v1.1 Draft

```text
docs/kiwi-commerce-v1.1-architecture-draft-rev1.5.md
docs/products/kiwi-catalog-product-architecture-v0.4.md
docs/products/shopping-cli-commerce-data-hub-v0.3.md
docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md
docs/protocol/kiwi-transaction-handoff-0.1-rev0.3.md
docs/testing/kiwi-commerce-v1.1-test-plan-v0.3.md
```

## Version identity

- File mtime is NOT a version authority.
- `status`, `doc_revision`, product version, Git commit/tag, and this manifest determine document identity.
- KNP wire protocol remains `1.0`; `rev1.4` is an editorial/errata revision.
- KTH protocol draft remains `0.1`; `rev0.3` is the current document revision.
- `selected_nonbinding` is OPTIONAL before Handoff.
- Candidate content is immutable; lifecycle is an event-sourced projection.
- kiwi-catalog state is three-dimensional: Verification / Freshness / Administrative.

## Implementation status (2026-08-07)

- v1.1 completion definition: **CD #1–21 evidenced** (rev1.4.1 baseline,
  readiness audit: `docs/reviews/kiwi-commerce-v1.1-readiness-audit-2026-08-07.md`)
  + **CD #22–28 evidenced** (rev1.5 Product-first Discovery, readiness audit:
  `docs/reviews/kiwi-commerce-v1.1-product-first-readiness-audit-2026-08-07.md`).
  28/28 全部有直接实证；v1.1 仍未宣布发布。
- New CLI: `kiwi catalog serve` (standalone kiwi-catalog service),
  `kiwi metrics --dir <agent-dir>` (KTH metrics).
- New chat TUI commands: `/handoff`, `/handoff-launch <handoff_id> <negotiation_id>`,
  `/handoff-open <handoff_id> <negotiation_id>`.
- v1.1 remains a **Draft**; the audit does not announce a release.
