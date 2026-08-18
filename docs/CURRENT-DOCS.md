# CURRENT DOCS — Kiwi Commerce

## Current source of truth（2026-08-17）

当前产品方向由 v2.5 战略基线决定，当前实现状态由代码、测试和实现对齐页决定：

```text
docs/Kiwi_Product_Strategy_Upgrade_Baseline_v2.5_2026-08-15.docx
docs/kiwi-product-strategy-implementation-alignment-2026-08-17.md
```

v1/v2.1 基线与 v2.0/v2.1 评审稿已移入本目录，保留为历史决策依据：

```text
docs/Kiwi_Product_Strategy_Upgrade_Baseline_2026-08-14.docx
docs/Kiwi_Product_Strategy_Upgrade_Baseline_v2.1_2026-08-14.docx
docs/Kiwi_Product_Strategy_Upgrade_Review_v2.0_v2.1_2026-08-15.docx
```

v2.5 的现行执行顺序是：Hermes + `kiwi-buyer-mcp` 双突破口 → 真实 B2B 试点 → Merchant Independence / DeepSeek Harness 双证据门 → 再决定深度重构与其他 Host 扩张。旧 v2.1 的 OpenClaw-first 顺序不再是当前执行顺序。

## Release identity

### Released v0.6.0

这些文件仍是 v0.6.0 已发布协议的权威版本，不被后续 Draft 文档直接覆盖：

```text
docs/kiwi-a2a-architecture-baseline.md
docs/protocol/kiwi-negotiation-protocol-1.0.md
```

### Protected portfolio release（2026-08-18）

- Kiwi：`@harrylabsj/kiwi@0.7.18`（npm）。
- `kiwi-catalog==0.2.4`（PyPI）。
- `shopping-cli==3.2.3`（PyPI；包含 `SHOPPING_MERCHANT_ID` /
  `KIWI_MERCHANT_ID` 与数据库环境变量支持）。
- 受保护组合发布、keyless 签名/attestation、三注册表发布及下载后 manifest 校验全部通过：
  `https://github.com/harrylabsj/kiwi/actions/runs/32086213727`。
- 当前 `main` 在发布运行时之后继续增加商家公网向导和对外采用材料；不改变上述已发布
  package version，后续运行时代码变更仍需新版本和同一受保护流程。

### 0.7.19（Draft，待发布）

- `@harrylabsj/kiwi@0.7.19`：`kiwi mcp serve` 默认持久 store 支持 `KIWI_MCP_DB`
  env / `~/.kiwi/mcp/dsh.sqlite`；`kiwi_request_quotes` schema 暴露 items 结构
  （ff4e077 修复 contract_violation）。
- 新增 `@harrylabsj/kiwi-dsh-plugin`（npm）：DeepSeek Harness 一键安装插件
  （`dsh plugin --profile web add @harrylabsj/kiwi-dsh-plugin`），`portfolio-release.yml`
  新增 `publish-dsh-plugin` job + verify-registry/rollback 覆盖。

## Current protocol / architecture drafts

```text
docs/kiwi-commerce-v0.7.0-architecture-draft-rev1.5.md
docs/products/kiwi-catalog-product-architecture-v0.4.md
docs/products/shopping-cli-commerce-data-hub-v0.3.md
docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md
docs/protocol/kiwi-transaction-handoff-0.1-rev0.3.md
docs/testing/kiwi-commerce-v0.7.0-test-plan-v0.3.md
```

这些文件描述 v0.7.x 的协议与产品契约；版本身份仍以本清单、代码、Git commit/tag 和发布证据共同判定。

## Product strategy / upgrade docs

```text
docs/Kiwi_Product_Strategy_Upgrade_Baseline_v2.5_2026-08-15.docx
docs/kiwi-product-strategy-implementation-alignment-2026-08-17.md
docs/kiwi-agent-commerce-strategy-upgrade-2026-08-13.md  # v1.0 早期 Markdown 基线
docs/kiwi-product-layer-refactor-rev1.2.md
```

## Northbound（PILOT DRAFT，v0.1）

```text
docs/kiwi-buyer-mcp-facade-v0.1.md
```

当前 Buyer Core / MCP / HTTP 实现：

```text
src/buyer-core/
src/mcp/
src/http/
integrations/hosts/hermes/
integrations/hosts/deepseek-harness/   # dsh Host 接入（kiwi-buyer-mcp 作为 MCP 插件）
integrations/plugins/kiwi-dsh-plugin/  # dsh 一键安装插件（bundle + skill，portfolio 发布）
integrations/harnesses/deepseek-harness/   # dsh 受限 ReasoningBackend（contract gate）
```

## Compatibility（v2.5 语义不变量）

```text
compatibility/ucp-knp-boundary.md
compatibility/host-harness-matrix.md
compatibility/merchant-three-plane.md
compatibility/openclaw-tri-role-separation.md
compatibility/knp-ucp-capability.md
```

- UCP/KNP 边界：商品 truth 留在 Merchant/UCP；Kiwi 负责发现、路由、RFQ、Negotiation 和 handoff，不承担支付、订单或库存预留。
- Host/Harness Matrix：Hermes 是当前首个真实 Host reference；DeepSeek Harness 有**双角色**——(1) 受限 ReasoningBackend（contract gate，`integrations/harnesses/deepseek-harness/`）验证 DecisionCandidate 契约，(2) 作为 Host Agent 平台让 kiwi-buyer-mcp 以 MCP 插件进入（`integrations/hosts/deepseek-harness/`，2026-08-18 已实测：dsh web 拉起 kiwi mcp serve、工具 mcp__kiwi__* 注册、子进程断连自动重连）；OpenClaw/Kimi/Codex/WorkBuddy 保持 AFTER GATE。
- Merchant 三 Plane：Commerce Plane + Merchant Core 必须在 Intelligence/Ops 离线时继续工作，低于底价等异常进入 `human_required`。
- OpenClaw 三角色分离：Buyer、Merchant Ops、ReasoningBackend 使用不同命名空间、凭据和状态目录；旧角色迁移不是当前试点前置条件。

## Current implementation evidence

- 当前 Kiwi `npm run verify`：141 个测试文件、1998 个测试通过；官方 A2A SDK 往返通过；三向 Independent↔Kiwi↔Independent 互操作 21/21 通过。
- 当前本地试点证据：26/26 Qualified RFQ、5 家 seeded merchants、merchant response rate 97.2%、median latency 2072ms；这不是第三方采用证据，也不是 30–45 天持续复用证据。
- 当前 pilot sourcing index 中商家 freshness 为 stale、verification 为 discovered；外部试点前必须刷新 listing、验证和 endpoint。
- 当前 handoff 证据包含 `purchase_order_draft` 演示；仍需至少一个真实 UCP Checkout、PO/CRM 或 Merchant transaction endpoint 的权威回执。

## Version identity rules

- File mtime is NOT a version authority.
- `status`、`doc_revision`、产品版本、Git commit/tag、本清单和发布证据共同决定文档/产品身份。
- KNP wire protocol remains `1.0`；`rev1.4` 是当前编辑/勘误版本。
- KTH protocol remains `0.1`；`rev0.3` 是当前文档修订版本。
- `selected_nonbinding` 在 Handoff 前为 OPTIONAL。
- Candidate content is immutable；lifecycle is an event-sourced projection。
- `kiwi-catalog` 状态保持三维：Verification / Freshness / Administrative。

## Current next gate

1. 更新组合文档与版本身份，完成固定 SHA 组合门禁和 protected release dry-run。
2. 用 Hermes + `kiwi-buyer-mcp` 接入 3–5 家真实外部 Merchant，运行 30–45 天 B2B 试点并记录至少 20 个 Qualified RFQ。
3. 固化 Merchant Independence、DeepSeek Harness contract 和真实 Agreement-to-Handoff 证据。
4. 三个证据门全部通过后，才决定 Buyer Core 深度拆包、Merchant UCP/Connector 产品化和下一个 Host。

## Related docs

- `docs/releasing.md`
- `docs/kiwi-protected-release-runbook-2026-08-09.md`
- `docs/kiwi-buyer-mcp-facade-v0.1.md`
- `docs/protocol/knp-spec-convergence-2026-08-13.md`

## Public adoption assets

```text
docs/demos/hermes-buyer-demo.md       # 可重复执行的 Hermes Buyer 三分钟演示与实际复验边界
docs/website/merchants.html           # 商家四步安装、完成判定和公开案例入口
docs/website/case-template.html       # 面向外部商家的公开案例说明页
docs/website/case-template.md         # 可下载、可复制的案例证据模板
```

公开案例必须先区分第一方流程演示、外部商家接入和持续业务使用；没有外部参与方和
真实调用记录时，不称为第三方采用或多商家互操作。
