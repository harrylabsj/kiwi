---
title: Kiwi Commerce v1.1 Test Plan
version: "0.2"
date: 2026-08-07
status: Draft Test Plan
---

# Kiwi Commerce v1.1 Test Plan

## 1. Scope

Covers only v1.1 additions:

```text
kiwi-catalog product split
shopping-cli CommerceDataSource / authority model
Transaction Handoff
integration with already released KNP/1.0
```

## 2. kiwi-catalog

- registration and domain/profile validation;
- Agent Card/UCP capability indexing;
- VerificationLevel transitions;
- FreshnessState transitions (FRESH/STALE/UNREACHABLE);
- AdministrativeState transitions (ACTIVE/SUSPENDED/REJECTED);
- orthogonal combined-state rendering;
- scheduled and explicit refresh;
- stale search labeling/filtering;
- `COMMERCE_VERIFIED` never rendered as reputation/quality endorsement;
- Handoff search uses exact KTH `destination_type` vocabulary;
- Direct A2A remains usable without kiwi-catalog.

> 实现状态（2026-08-07）：✅ 已覆盖——`tests/kiwi-catalog-source.test.ts`（TS 消费端，
> 词表单一性契约、三态域折叠、resolveViaCatalog 集成）+ kiwi-catalog 仓
> `test_kiwi_catalog_v1_api.py`/`test_state_domains.py`（服务端三态域/新 API/
> handoff 搜索/legacy 兼容）。

## 3. shopping-cli

- per-field authority/provenance;
- LOCAL_AUTHORITATIVE writes;
- UPSTREAM_PROXY_WRITE success/failure/idempotency/precondition;
- READ_ONLY mutation rejection;
- conflicting source authority → fail closed;
- ERP/local DB freshness;
- public/private boundary.

> 实现状态（2026-08-07）：✅ 已覆盖——`tests/commerce-data-source.test.ts`
> （20 例：本地库/ERP/shopping-cli adapter、权威标注、冲突 fail-closed、
> product-source 适配）。

## 4. KTH/0.1

### Candidate

- Candidate JSON remains byte/content immutable after creation;
- lifecycle projection: PROPOSED → READY;
- lifecycle projection: PROPOSED/READY → STALE;
- rejected/expired;
- stale candidate cannot revive;
- replacement candidate links `supersedes_candidate_id`;
- lifecycle projection can be reconstructed from Ledger events.

### Candidate → Handoff

- same candidate/digest retry does not duplicate effect;
- same candidate/different digest fails closed;
- source candidate → CONSUMED only after successful delivery.

### Delivery state

- DELIVERED → LAUNCHED on local launch success;
- DELIVERED/LAUNCHED → OPENED_CONFIRMED only with explicit verifiable evidence;
- launch success without evidence never becomes OPENED_CONFIRMED;
- DELIVERED/LAUNCHED → EXPIRED;
- supported revocation → REVOKED;
- DELIVERED/LAUNCHED/OPENED_CONFIRMED never maps to order/payment success.

### Security

- unsafe scheme rejected;
- redirect destination revalidated;
- phishing/destination display policy;
- no secrets/private budget/merchant floor leakage.

> 实现状态（2026-08-07）：✅ 已覆盖——`tests/handoff-{candidate,lifecycle,ledger,
> delivery,url-safety,idempotency,stale-revalidation}.test.ts`（完成标准 1-13
> 逐条映射见 KTH/0.1 rev0.3 §18 Implementation status）。

## 5. E2E

```text
Buyer Kiwi
→ kiwi-catalog discovery
→ Direct A2A / KNP
→ AcceptedNonbindingAgreement
→ [selected_nonbinding OPTIONAL]
→ HandoffCandidate
→ approval
→ external checkout / PO / contact
```

At least one E2E must use shopping-cli-backed Merchant data and at least one must use an external-authority adapter.

> 实现状态（2026-08-07）：✅ 已覆盖——`tests/handoff-e2e.test.ts`（4 类目的地全链路：
> external checkout URL / quote / PO draft / merchant contact）+ `tests/handoff-tui.test.ts`
> （/handoff 用户可见性）。

> 实现状态（2026-08-07）：✅ 已覆盖——`src/handoff/metrics.ts` +
> `tests/handoff-metrics.test.ts`（率/时长/external conversion null）+
> `kiwi metrics --dir <agent-dir>` 命令。

## 6. Metrics

Verify emission of:

```text
agreement_to_handoff
handoff_launch_rate
opened_confirmed_rate
Negotiation-to-Handoff Rate
reported_external_conversion (explicitly non-authoritative unless integrated)
```
