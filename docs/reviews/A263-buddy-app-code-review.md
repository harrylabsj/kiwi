# A263：Buddy 应用代码审查（~/coding/kiwi @ 8a8e890 + ~/coding/kiwi-catalog @ 2252517）

- 执行者：ZCode（三路并行只读审查，承重断言经独立实读交叉核验）
- 日期：2026-10-07
- 审查范围：merge `45fbf556..8a8e890`（56 文件，+2543/−196）+ kiwi-catalog HEAD
- 聚焦：Buddy 应用 = connect-service（1056 行新文件）+ owner 模块（4 新文件）+ platform pack + sourcing connector + file-listing-publication + catalog 变更
- 性质：只读 code review，零改动

---

## 0. 核心结论

Buddy 应用合并 `8a8e890` 的**核心机制方向正确**：connect-service 的设备配对状态机（create→poll→bind→publish→activate）从 CLI 原样搬移且**只存在一份**；owner 模块自批路径经三路交叉验证**不存在**（WebAuthn 是唯一 approve）；platform pack 无 secrets 泄漏；file-listing 公开投影 whitelist 正确。但存在 **2 项 P1 跨 repo 部署耦合**（sourcing connector 无版本锁定 + catalog 确认页仅私有 extension 可达）和 **17 项 P2 改善**，其中 connect-service 的 public-path binding claim 未验签（P1 级安全纪律违反）与跨进程无锁竞态最值得优先修复。

---

## 1. P1 — 应修（2 项）

### P1-1 · Sourcing connector 无版本锁定

- **文件**：`integrations/hosts/workbuddy/kiwi-sourcing/mcp.json:6-9`
- **发现**：在商家机器 WorkBuddy-hosted Node 22 runtime 中执行 `npx -y --prefer-online @harrylabsj/kiwi@latest mcp serve`。任何未来 npm publish 静默改变所有商家执行的代码和 13 工具面。
- **验证**：`validate.mjs:79-88` 有 trade-off 文档，且已支持 pinned semver 变体——合并 diff 显示这是从 pinned `@0.8.0` 的有意回归（"to avoid re-review per tool addition"）。
- **建议**：改回 `@harrylabsj/kiwi@<semver>`。市场提交的 connector 这是真实供应链暴露。

### P1-2 · Catalog 确认页仅私有 extension 可达

- **文件**：`kiwi-catalog/src/services/enrollments.py:132`（`verification_uri` 生成）
- **发现**：catalog commit `641a418` 把 merchant portal pages 移入私有 `kiwi-catalog-admin` extension 后，device enrollment 的 `verification_uri`（`/portal/connect/{id}` + `login_url`/`authorization_url`）全部由该 extension 服务，非 extension 部署 fail-soft 404（commit `f89e922` `docs/extensions.md` 已文档化）。
- **Buddy 流耦合**：`build-platform-pack.mjs:259` 和 expert systemPrompt `:1171` 引导商家打开的正是这个页面。Device polling（`/v1/enrollments/device/token`）继续工作但 runtime 卡在 `awaiting_confirmation`——商家无法确认。无任何 preflight 检测此耦合。
- **建议**：生产 catalog 部署必须挂载 admin extension；或 build-platform-pack 加入 preflight HEAD 探测。

---

## 2. P2 — Connect Service（1056 行新文件 + catalog-client 重构）

| # | 发现 | 位置 |
|---|---|---|
| 2-1 | Published-session binding claims **未验签**：`fetchPublicBinding`/`parsePublicBinding` 只做 schema check；bind 路径有 `verifyCatalogBindingClaim`（JWKS + JWS verify）但 public path 没有。`assertPublicationActive` 消费未验签 claim、backfill `merchant_id` 到 0600 store、`getVerifiedBinding` 返回之 → bootstrap 盖戳商品表。违反模块 invariant（"merchantId 只能来自验真 claim"） | catalog-client.ts:779-795, connect-service.ts:905-944 |
| 2-2 | 跨进程 read-modify-write 无锁：in-process mutex 仅单实例；bootstrap 5s reconcile + CLI 1s + challenge responder 并发写同一 0600 JSON。可 resurrect 已取消 session、double bind | connect-service.ts:1033-1048 |
| 2-3 | `isPublicHostAllowed` IPv4 非规范写法绕过（`127.1`/`0177.0.0.1`/`localhost.localdomain`） | connect-service.ts:109-125 |
| 2-4 | RFC 8628 `access_denied`（商家拒绝）无映射 → `CONNECT_STEP_FAILED` 与 bug 不可区分 | catalog-client.ts:465-473 |
| 2-5 | Safe-code 注册表漂移：6+ 个 self-thrown code 未注册在 `CONNECTION_PAIRING_SAFE_CODES` | connect-service.ts:90-102 vs 917/926/301/315/533 |
| 2-6 | `beforePublish` 失败 owner 不可见（泛化 code）且每 5s tick 重跑 readiness probe | bootstrap.ts:590-595 |
| 2-7 | Origin 校验三处实现规则不一致（cloud config 无 allowlist） | config.ts:119-146 |
| 2-8 | 原子写无 fsync：断电 → 零长度 store → connect 面不可用；tmp 文件抛错不 unlink | atomic-write.ts:25-34 |
| 2-9 | `selectReusableEnrollment` 已弃用但仍导出，忽略 `catalog_origin`/`generation`——未来 caller 会选错 session | merchant-connect.ts:44-48 |

---

## 3. P2 — Owner 模块（4 新文件 + observer 修改）

| # | 发现 | 位置 |
|---|---|---|
| 3-1 | 双开关是惯例非机制——进程内 caller 可传 `switches` 绕过 env（CLI 层已强制，embedding 层未强制） | owner-session.ts:483 |
| 3-2 | 两种 grant-file 实现漂移（`checkFileGrant` vs `readStrong`：principal 折叠/无 digest/空白 ID） | owner-session.ts:140-166 vs owner-file-grant.ts:103-141 |
| 3-3 | SQLite `-wal`/`-shm` 边车 umask 权限未检查（目录 0700 缓解） | owner-session.ts:516-520 |
| 3-4 | `budget.settle()` 在 finally 抛错会遮蔽 turn 结果（应 swallow-and-log） | owner-session.ts:911-914, 1190-1193 |
| 3-5 | Committed business path 是 dead code——`OwnerCommittedProofAuthority`/`OwnerBusinessHost` 零非测试 call site | grep 证实 |

---

## 4. P2 — Platform Pack / Listing / Catalog

| # | 发现 | 位置 |
|---|---|---|
| 4-1 | ZIP icon 排序 `localeCompare`（ICU 依赖）——byte 输出可跨 Node/locale 不同；改 codepoint sort | build-platform-pack.mjs:1629 |
| 4-2 | `market.json` 载 `pending:<skill>` 占位 asset ID——平台 importer 严格校验时 zip import 失败（generator 只 warn） | build-platform-pack.mjs:1482,1519-1524 |
| 4-3 | `source_revision` 把商家内部商品行更新时间发布为公开 catalog metadata——可用序列号替代 | file-listing-publication.ts:354 |
| 4-4 | Listing draft/receipt 文件无 GC 无限累积；draft mutex 仅进程内（跨进程重复 commit safe 但卫生问题） | file-listing-publication.ts:372,390,579-593 |
| 4-5 | Catalog 本地 checkout 落后 origin 6 commits（0.5.3 vs pinned 0.5.5）——Buddy connect 流依赖的 403 修复/deploy preflight 不在本地 | kiwi-catalog |

---

## 5. 正面确认（审查中验证安全）

| 项 | 验证 |
|---|---|
| 配对码/授权链接不泄露 | `getSummary()` 永无 user_code/device_code/grant；仅 `getPairing()` owner-only |
| Bind-path 盖戳正确 | `merchant_id` 仅来自签名验证后的 bind claim（JWKS + JWS verify） |
| 出站重定向 | 全部 `redirect: "manual"` + 显式拒绝 |
| 自批不可能 | WebAuthn-committed 是唯一 approve 路径；非 WebAuthn `markApproved` 操作不同 store |
| Committed proof 不可伪造 | DB 行交叉验证 + contentHash 相等 + 未撤销 credential；同 uid DB 写入是假设已破边界 |
| Reconciliation verifier sound | legacy boolean 忽略 + 全绑定匹配 + receiptRef 必填 + receipt version pin |
| Gate 集成 additive | owner 走 `createOwnerBudgetGate` + 独立 provider guard；SDK loop 无 grant 不达模型 |
| Observer KNP 修复正确 | flat discriminated union 确认；A40-1 根因 = 旧嵌套 shape |
| Platform pack 无 secrets | 仅 prompt text/SVG/platform asset IDs；connector withdrawn hard-banned |
| Listing 公开投影 | whitelist 正确（无 price/stock/floor/contact/owner token） |
| Catalog enrollment security 补偿 | 2252517 恢复 API 安全断言 + no /portal route shadow |
| Connect tests 覆盖好 | 1134 行测 begin 幂等/节流/验签 claim/排序/失败 resume/重启/漂移/revoke/TTL/secure projection |

---

## 6. 测试覆盖评估

connect-service.test.ts（1134 行）覆盖 begin 幂等/interval+slow_down 节流/merchant_id 验签/beforePublish 排序与失败 resume/重启 resume/跨 Catalog 漂移/revoke fail-closed/credential-free projection/claim TTL/stage-coded 失败。缺口：`slow_down` backoff 未测；invalid-signature 路径未测（stub 总是重签）；无并发 reconcile 测试。

---

## 7. 建议修复优先级

| 级 | 项 | 建议工单 |
|---|---|---|
| **P1** | sourcing connector pin semver | 1 行 mcp.json + validate.mjs 参数 |
| **P1** | catalog 确认页 extension 耦合 | 部署侧挂 extension 或 build-platform-pack preflight |
| **P2** | connect-service public binding claim 验签 | catalog-client.ts + connect-service.ts |
| **P2** | connect-service 跨进程锁 | lockfile/flock 或 per-session revision |
| **P2** | owner 双 grant 实现合并 | 统一 checkFileGrant 或 delegate |
| **P2** | 其余 12 项 P2 | 按主题分批 |

---

## 8. 审查方法

三路并行 Explore agent（connect-service 12 tool calls / owner module 51 calls / platform pack 29 calls），承重断言由 ZCode 本会话独立实读交叉核验。只读，零改动。
