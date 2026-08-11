# Kiwi 生态重构代码审查报告（2026-08-11）

## 审查对象

`kiwi` 0.6.2、`kiwi-catalog` 0.1.1、`shopping-cli` 3.0.2 之后的「重大架构重构」——本轮审查聚焦以下重构主线：

- **方案A（Scheme A）统一令牌体系**：catalog 做身份权威、商家 token 跨服务校验、注册即分配正式 `merchant_id`、无令牌商家免费上架通道（10 件配额）。
- **方案A 拆除与完全解耦**：shopping-cli 在实现方案A 后（`dc01eb3`/`687cab9`/`100eb70`/`ba7233e`）又整体拆除（`5ad9ec8`，回归纯本地令牌鉴权）；catalog 转向本地 listings + discovery entries（`70a671e`「与 shopping-cli 完全解耦」）。
- **kiwi 公网认证边界**（`KIWI_A2A_AUTH`，`6c90780`）+ 上一轮审查（2026-08-10）16 项 P1 / 7 项 P2 修复的落地核验。
- **跨仓契约锁** `portfolio.lock.json` 与各仓 `kiwi-contracts.lock.json` 的同步状态。

**审查快照**：2026-08-11。三个仓库工作树均干净（仅有未跟踪的审查 DOCX）。

| 仓库 | 当前 HEAD | 语言/规模 |
|---|---|---|
| `kiwi` | `5d7590d` | TS，src 5.4 万行 + tests 4.1 万行 |
| `kiwi-catalog` | `70a671e` | Python FastAPI，3.6 万行（含 tests） |
| `shopping-cli` | `5ad9ec8` | Python，1.7 万行（含 tests） |

## 执行摘要

三仓在「方案A 引入 → 方案A 拆除」的循环中完成了一次实质性的架构收敛：**当前三个仓库零运行时依赖，各自自洽**。上一轮审查的 16 项 P1 / 7 项 P2 修复已全部提交且基本正确落地（详见 §四）。

本轮审查新发现：

- **跨仓 P1**：`portfolio.lock.json` 全面过期，锁定的组合仍描述「方案A 在两端启用」的旧架构，与任一仓库当前 main 都不一致；发布流程读取该锁钉 consumer，会发布错误架构。
- **跨仓 P1**：catalog 的 `/v1/merchants/{id}/token/validate` 跨服务校验端点在方案A 拆除后已无任何调用方，仍是**未认证、未限流的令牌有效性预言机**，且被 FastAPI 与 fallback 双栈同时暴露。
- **kiwi P1**：merchant-handler 的 accept 分支忽略 `advancePhase` 返回值——相位机（BUG-10/P1-07 的权威终态守卫）拒绝登记 `AGREEMENT_REACHED` 时，协议仍被创建并返回给买家；重启恢复后同一磋商可二次 accept 产生重复协议。
- **P2**：kiwi 公网认证边界 `StaticBearerAuthVerifier` 的令牌比较非常量时间（`presented !== this.token`），与代码库内 `memory/vault.ts` 已使用的 `timingSafeEqual` 不一致。
- **P2**：`KIWI_A2A_AUTH=loopback` 模式下节点只绑定 `127.0.0.1`（`node.ts:310`），经反代转发的全部公网流量在应用层都呈现为 loopback 而被放行——功能上等价于 `none`，是最危险的部署脚枪。
- **P2**：跨仓 `handoff_destination` 契约缺口——shopping-cli 存未校验自由文本，kiwi 无条件按 `external_checkout_url` 发布，且该字段未在 `public_product_summary` 剥离，重新打开上轮 P1-02 的私有字段泄露边界。
- **P2/P3**：catalog token 存储实际为「SHA-256 摘要 + Fernet 可逆加密」双轨（为门户回显明文令牌），与 CLAUDE.md 记录的「SHA-256 落库、明文仅签发时响应一次」策略漂移；`/v1/accounts/me` 每次会话加载都回显明文令牌。

重构叙事见 §一；跨仓发现见 §三；上轮修复核验见 §四；逐仓深度发现见 §五；验证方法见 §六；发布前验收清单见 §八。

## 一、重构叙事（发生了什么）

1. **方案A（catalog 做身份权威）**：shopping-cli 侧 `KIWI_CATALOG_AUTH_URL` 跨服务 owner token 校验 + `KIWI_CATALOG_PROXY_TOKEN` 门户代理凭据 + `SHOPPING_FREE_PRODUCT_QUOTA` 免费档 10 件配额 + catalog 背书商家自动补建商家行；catalog 侧统一令牌、`/v1/merchants/{id}/token/validate` 校验端点、注册即分配 `merchant_id`、门户免费上架通道。
2. **拆除**：shopping-cli `5ad9ec8` 删除 352 行跨服务代码 + 200 行配额测试，`require_merchant_token` 回归本地 `api_tokens` 单一来源；catalog 转向本地 listings + discovery entries（`70a671e`），门户「我的商品」改为上传**商品名称到发现目录**（需令牌 + 已注册 Agent），不再代理写回 shopping-cli。
3. **净状态**：catalog = 发现目录 + 本地 listings 索引 + 令牌分发/门户；shopping-cli = 纯本地商务运行时；kiwi = 协议/agent 层，消费 catalog 的 `/v1/agents`（HTTP）。

## 二、严重性定义

- **P0**：可直接被利用/造成系统接管。
- **P1**：发布或合并阻断项。信任提升、敏感信息泄露、跨仓协议不可互操作、发布完整性破坏。
- **P2**：重要可靠性/规范一致性/运维风险，建议下个发布周期前关闭。
- **P3**：文档漂移或代码卫生。

## 三、跨仓发现

> 编号说明：本节为跨仓/全局发现，用字母编号（P1-A…P2-E）；§五 逐仓发现用数字编号（P3-01…）并沿用全局 P1/P2 字母，避免跨节冲突。

### P1-A：`portfolio.lock.json` 过期，锁定的是已被拆除的「方案A」架构

**位置**：`kiwi/portfolio.lock.json`（commit 字段）。

**证据**：锁文件引用 `kiwi-catalog@50f4649`（方案A 引入后）、`shopping-cli@13bc178`（方案A 拆除前）。当前 HEAD 分别为 `70a671e`（解耦 + 本地发现）与 `5ad9ec8`（拆除方案A）。锁定组合「catalog 与 shopping-cli 双方启用方案A」与两个仓库当前 main 的架构都不相符。kiwi 侧同样落后（锁定 `7c63aa4`，当前 `5d7590d`）。`scripts/verify-portfolio-lock-candidate.mjs` 的 `verifyConsumerHead` 要求 consumer checkout 的 `git rev-parse HEAD` 与锁 commit 精确一致——以当前 main 组合校验必然失败。

**影响**：`portfolio-release.yml:142,180` 在发布流程中读取该锁文件并按其 commit 钉 consumer checkout——**用当前锁发布，产出的就是「方案A 双方启用」的旧架构组合**，而不是当前 main 的解耦架构。上一轮审查（2026-08-10 §二）已明确要求「portfolio lock 必须随最终选定提交一起更新，不能把未锁定的工作树直接发布」，此条至今未执行。

**建议**：以当前三仓 main（或选定发布提交）重新锚定 `portfolio.lock.json` 与 `kiwi-contracts.lock.json`，更新 `contract_bundle_sha256`，再执行组合 contract / 签名 / build / registry preflight 演练。

### P1-B：catalog `/v1/merchants/{id}/token/validate` 成为无调用方的未认证令牌预言机

**位置**：`kiwi-catalog/kiwi_catalog/api/route_table.py:287`、`kiwi_catalog/api/fastapi_routes.py:514`、`kiwi_catalog/api/handlers/merchants.py:196-211`。

**证据**：
- 该端点本为方案A 设计（docstring：`shopping-cli 等信任方校验商家 owner token`，注释「同机服务调用，无需调用方凭据」）。
- shopping-cli `5ad9ec8` 已删除唯一调用方（`KIWI_CATALOG_AUTH_URL` 分支）；kiwi TS 侧从未调用（grep `token/validate` 无命中）。
- 端点在 FastAPI 与 fallback ASGI 双栈同时注册，**无认证、无 per-handler 限流**（全局限流中间件不存在，限流是 per-handler 的；该 handler 未接限流）。
- 实现：`POST` 出示 `merchant_id + token`，返回 `{ok:true, valid:bool}`。

**影响**：dead code 残留在公网暴露面上；对任一 `merchant_id` 提供未限流的令牌有效性查询。令牌为 `mkt_` + 32B urlsafe（2^256 空间），直接暴力不可行，但可确认泄露/猜测令牌归属，且与「完全解耦」的架构声明相矛盾。在公开部署形态下这是多余攻击面。

**建议**：删除该路由（唯一消费者已不存在），或保留则必须加共享密钥认证 + 限流。至少补充「无调用方」的标注与移除测试。

### P2-C：catalog 令牌存储双轨与文档策略漂移 + 门户回显明文令牌

**位置**：`kiwi-catalog/kiwi_catalog/services/merchant_tokens.py:22,152-160`、`kiwi_catalog/services/accounts.py:24-27,97-105`、`kiwi_catalog/api/handlers/accounts.py:221-230`。

**证据**：`merchant_tokens` 同时存 `token_hash`（SHA-256，校验用）与 `token_encrypted`（Fernet 加密明文，可逆）；Fernet key 由 `KIWI_CATALOG_OWNER_TOKEN_SECRET` HKDF 派生。`/v1/accounts/me` 每次返回 `token.token` 明文（session cookie `HttpOnly + Secure + SameSite=Lax`，输出经 `escHtml` 转义，令牌查看有 `_audit_token_view` 审计）。CLAUDE.md 记录「SHA-256 落库 merchant_tokens，明文仅签发/轮换时响应一次」——与实现不符。

**影响**：这不是直接漏洞（cookie 有 HttpOnly/Secure，页面转义正确），但存在两点：① 文档与实现的信任模型漂移；② 可逆存储意味着「DB 文件 + owner secret」双泄露即可解密全部商家令牌——与「SHA-256 不可逆」策略相比，牺牲了落库安全换取门户可回显。属设计取舍，但应显式记录在文档中（accounts.py 模块 docstring 已说明，CLAUDE.md 未更新）。

**建议**：更新 CLAUDE.md 的令牌存储描述；明确 Fernet 可逆存储的威胁模型（DB 泄露 + secret 泄露 → 全量令牌解密）；评估是否对「我的」页面仅展示前几位 + 尾号。

### P2-D：kiwi 公网认证边界 Bearer 比较非常量时间

**位置**：`kiwi/src/a2a/server/auth.ts:83`（`presented !== this.token`）；对照 `kiwi/src/agent/memory/vault.ts:154`（已用 `timingSafeEqual`）。

**证据**：`StaticBearerAuthVerifier` 是 `KIWI_A2A_AUTH=bearer:<token>` 模式下的公网认证边界。JS 字符串 `!==` 不保证常量时间，长度与内容提前退出存在可测时序差异。代码库内 master-key 比较已正确使用 `crypto.timingSafeEqual`。

**影响**：对静态高熵令牌的时序侧信道在真实网络上难利用，但这是**对外认证边界**，修复成本极低（长度校验 + `timingSafeEqual`），且与仓内既有实践不一致。

**建议**：`verify` 中改为长度恒等预检 + `crypto.timingSafeEqual`。

### P2-E：`KIWI_A2A_AUTH=loopback` 对经反代转发的公网流量等价于 `none`（部署脚枪）

**位置**：`kiwi/src/a2a/server/auth.ts:94-115`、`kiwi/src/a2a/node.ts:220-229,310`。

**证据（agent 独立复核 + 主审查核实）**：`LoopbackOnlyAuthVerifier` 只校验 socket 来源；`startA2aNode` 始终 `httpServer.listen(port, "127.0.0.1", …)`。生产形态（Caddy 反代从 127.0.0.1 连接）下，**每一笔经代理转发的公网请求在应用层 remoteAddress 都是 127.0.0.1，一律放行**——`loopback` 模式对公网面功能上等于 `none`。且共享主机上任何本地进程也可直连 `127.0.0.1:port` 被信任。未配置 verifier 且广告地址非 loopback 时拒绝启动（fail-closed，设计正确），但 `loopback` 是 CLI help 中最温和的首选项，运维站公开商家节点时最可能选它，得到的是零应用层认证。

**影响**：`loopback` 是文档化的「可审计代理认证契约」，但认证责任完全在反代；反代未做认证时，公开 A2A 端点可被任何能触达代理的人操作（协商/协议篡改）。这是三仓重构中风险最高的配置脚枪。

**建议**：`--help`/README 显式标注 `loopback` 仅限「本地开发 / 代理即边界」并推荐公网节点用 `bearer:<token>`；当 `KIWI_A2A_PUBLIC_URL` 非 loopback 时拒绝 `loopback` 模式或启动时输出醒目警告。

## 四、上轮审查修复落地核验（2026-08-10 报告）

上一轮 16 项 P1 / 7 项 P2 全部有对应提交落地，本轮抽查确认其中与「重构」强相关的修复正确：

| 上轮问题 | 修复提交 | 本轮核验 |
|---|---|---|
| P1-13 中央 workflow 用 unittest 漏测 | `ab68ece` + portfolio-release.yml:228,242 | ✅ 已改 `uv run --locked python -m pytest -q`，注释说明原因 |
| P1-14 Cosign 参数错位 | portfolio-release.yml:296-323、release-rehearsal.yml:94-115 | ✅ `sign-blob` 与 `verify-blob` 已分离，证书 identity 固定 |
| P1-15 独立 PyPI 发布器 | catalog/shopping `pypi-publish.yml` | ✅ 均改 quality-only（`permissions: contents: read`，无 `id-token`），注释要求删除 Trusted Publisher 映射 |
| P1-16 多注册表发布不可恢复 | portfolio-release.yml:341-389 | ✅ 逐 registry 独立受保护 job，发布前检查版本已存在则跳过（幂等） |
| P1-01 域名重注册信任继承 | catalog `1a98c8e`/P1 批次 | ✅ `agent_catalog_writes.py` 域名变更清快照 + 验证按存储 canonical_domain；`test_domain_change_trust.py`（363 行）覆盖 |
| P1-04 KNP 信任绕过 | catalog `verifier.py`/`trust.py` | ✅ `has_spec` 要求非空 `specUrl`；`allowed_knp_versions=("1.0",)` |
| P1-05 入站幂等崩溃恢复 | kiwi `pipeline.ts` | ✅ ledger 事实恢复 + 提交/重复窗口关闭 |
| P1-06 同目的地双交付 | kiwi `handoff/transaction.ts` | ✅ `dest:<agreement_id>:<type>:sha256(ref)` 锁 + `openSync("wx")` 原子锁 + 锁内重读 |
| P1-07 商户终态重复转换 | kiwi `merchant-handler.ts` + `phase.ts` | ⚠️ 大体修复，但 accept 路径仍有绕过（本轮 P1-C） |
| P1-08 `publicBaseUrl` HTTPS | kiwi `a2a/node.ts` | ✅ HTTPS origin-only + loopback 例外 |
| P1-09 公网 agent 状态持久化 | kiwi `cli.ts`/`a2a/node.ts` | ✅ 稳定 dataDir + stop/restart 保持 |
| P1-10 Agent Card URL scheme | kiwi `product-publish.ts` | ✅ 绝对 HTTPS URL |
| P1-11 owner token 重定向 | kiwi `product-publish.ts`/`register.ts` | ✅ 全部 `redirect:"manual"` + 跨源 307/308 测试 |
| P2-01 JCS U+2028/U+2029 | kiwi `jcs.ts` | ✅ `JSON.stringify` ES2019 well-formed |
| P2-02 timeout timer 泄漏 | kiwi 7 处出站路径 | ✅ 最外层 `finally` 清理 |
| P2-03 UCP cache 超 512 | kiwi `discovery/ucp/resolver.ts` | ✅ cache cap 512 |
| P2-04 `ok:false` 被当成功 | kiwi `product-publish.ts` | ✅ `ok===true` fail-closed |
| P2-05 多商户同域授权 | catalog `agent_catalog.py` | ✅ 按精确 merchant_id |
| P2-06 搜索事件 JSON 截断 | catalog `buyer_search_events.py` | ✅ 先缩构后序列化，始终合法 JSON |
| P2-07 daemon 文件 0600 | shopping `23e4e2c` | ✅ 日志/备份/stop 均 0600（残存 `_PidFileLock` 0644，见 P3-03） |

## 五、逐仓深度发现

> 本节内容由三个并行的深度审查 agent 完成，主审查对其核心断言逐条核实后并入。

### 5.1 shopping-cli（HEAD `5ad9ec8`）——方案A 拆除审计

**方案A 拆除代码层完全干净**（经主审查复核）：`require_merchant_token` 与拆除前基线逐字节一致，纯本地 `api_tokens` 单一来源；方案A 循环从未触碰 DB schema（schema 增量只有 `product_handoff_destination`，来自无关的 `10ac944`）；`KIWI_CATALOG_*` / `CATALOG_PROXY_ROLE` / `mkt_free_` / `QuotaExceededError` 等在所有活动代码/测试/env/文档中零命中；shopping-cli 对外出站 HTTP 仅剩 `data_sources/erp_source.py`，与 catalog 零运行时依赖。全量 pytest：**820 passed / 9 skipped / 190 subtests**。上轮修复 P1-02、P1-12、P2-07、P1-13 均确认保持有效。

#### P2-A：`handoff_destination` 无校验自由文本，kiwi 无条件按 `external_checkout_url` 发布（跨仓契约缺口）

**位置**：`shopping_cli/api/handlers/catalog.py:322,349` → `core/catalog.py:331,405`；消费端 `kiwi/src/product-publish.ts:385-398`。

**证据（主审查核实）**：shopping-cli 仅 `bounded_text(handoff_destination, "handoff destination", MAX_PERSISTED_TEXT_CHARS)` 做长度限制，无 URL/词表校验；kiwi `product-publish.ts` 取原始字符串无条件映射为 `handoff_destination_types: ["external_checkout_url"]` + `handoff_destination_ref`，同样不校验 ref 形态。商家可存非 URL（chat-id / 电话 / 私域 checkout session ref）并随公开 catalog listing 以「外部成交 URL」类型广播。

**缓解因素（主审查核实）**：kiwi 消费侧 `handoff/url-safety.ts`（KTH/0.1）在买家实际打开成交入口时会强制 https/localhost scheme 白名单并拒绝 `javascript:`/`file:`/`data:`，host 需与商家声明域一致——**执行安全网在消费端存在**。残余风险是：① 公开目录的语义污染（非 URL 数据被标成 `external_checkout_url`）；② 未校验值经公开投影出网（见 §5.1 P2-B）。

**建议**：create/update 时对 URL 承载意图校验 `http(s)` origin、拒绝 opaque scheme，或显式存 `destination_type` 字段；补一条 kiwi `product-publish.ts` ↔ shopping-cli 的映射契约测试防再次漂移。

#### P2-B：`handoff_destination` 未在 `public_product_summary` 剥离，重新打开上轮 P1-02 边界

**位置**：`shopping_cli/core/catalog_views.py:16-38`（只 pop `stock` + merchant 私有字段）；`core/catalog.py:574`（`product_summary` 含 `handoff_destination`）；`api/handlers/buyer.py:135-153`（公开投影出口）。

**证据（主审查核实）**：`public_merchant_summary` 剥离 `contact` / `automation_boundaries`，但 `public_product_summary` 对商品的 `handoff_destination` 不做任何处理。该字段随 `GET /products/{sku}`、`GET /search/products`、`/buyer/ask` candidates/selected、会话商品与幂等回放路径一起出网。上轮 P1-02 专为此类「公开投影剥私有字段」而设，新字段（`10ac944`，晚于上轮审查）未纳入同一出口纪律。

**建议**：显式决定字段可见性——若为公开成交入口，在投影文档与 schema 契约测试中声明；若可承载私有数据，在 `public_product_summary` 中按 `contact` 同等方式剥离。

#### P3-01：匿名 listing-projection 端点枚举全量目录（含 `handoff_destination`）

**位置**：`shopping_cli/api/handlers/listings_projection.py:24-42`，`route_table.py:402-411`。

**证据（主审查核实）**：`GET /v1/merchant/listings/projections` 无 `merchant_id` 时返回所有商家的可发布投影；注释明示「公开读免鉴权（沿用 products 现状）」。与现有公开商品读模型一致，但构成更宽的枚举面，且承载未校验的 `handoff_destination`。**建议**：评估是否需要读 token，或至少要求 `merchant_id`。

#### P3-02：方案A 窗口期自动补建的 stub 商家行无清理迁移

**位置**：`687cab9` 的 `_ensure_merchant_exists`（`5ad9ec8` 删除）插入的 `name == merchant_id`、无 `api_tokens` 的商家行；移除提交无迁移清理。处于该状态的商家现无法通过本地 token 认证（其 catalog owner token / proxy secret 不再有效），`POST /merchants` 同 id 会 `ConflictError`。仓库自带 `shopping-cli.sqlite` 零商家，无生产影响。**建议**：补迁移标记清理 stub 行，或至少记录恢复步骤（admin `token/recover` + `PATCH`）。

#### P3-03：`_PidFileLock` 锁文件仍以 0644 创建

**位置**：`shopping_cli/agents/merchant_daemon.py:186-187`。与 P2-07 已加固的日志/stop 文件 0600 不一致。**建议**：改 `0o600`。

### 5.2 kiwi-catalog（HEAD `70a671e`）——方案A 令牌体系与解耦

**总体**：catalog 的认证模型现在是「三重凭据栈」——per-merchant 随机令牌（`mkt_`，SHA-256 + Fernet）为主、HMAC 派生 owner token 为无令牌行的 legacy 回退（需全局 secret，等价 admin）、门户账号会话（cookie，HttpOnly+Secure+SameSite=Lax）。解耦后 catalog 对外唯一的跨服务遗留面就是 §三 P1-B 的 `token/validate` 死端点。其余死代码（`shopping_token_encrypted` 列、HMAC legacy 回退）无害。注册即分配 `merchant_id` 未发现竞态（email UNIQUE + 条件 UPDATE + WAL 串行化）；`merchant_id` 伪装不可行（所有写路径均要求匹配的 token/会话）；SSRF 无新增暴露面。全量测试：**335 passed / 10 skipped**（CLAUDE.md 声称 5 skip，现为 10，文档漂移）。

**上轮修复核验（全部有效）**：P2-1 HMAC 不再绕过吊销（有令牌行时仅 active 可认证，revoked 直接 AuthError，不回退 HMAC）；P1-01 域名重注册信任（`agent_catalog_writes.py` 域名变更时清 capability/skills/profile/verification 快照，验证按存储的 canonical_domain fail-closed）；P1-04 KNP 信任（`verifier.py` `has_spec` 要求非空 `specUrl`，`trust.py` 锁定 `allowed_knp_versions=("1.0",)`）；P2-05 多商户同域按精确 merchant_id 授权；P2-06 搜索事件先缩构后序列化；上轮 P1-A（register 治理守卫，区别于本轮 §三 P1-A）。

#### 同 §三 P1-B：`/v1/merchants/{id}/token/validate` 死端点（agent 独立复核确认）

agent 独立复核确认：shopping-cli 侧 `token/validate` 引用零命中，catalog 侧端点未随拆除移除，双栈注册、无 admin token、无限流，返回布尔 `valid`，可确认 merchant_id 存在性并测试任意 `(token, merchant_id)` 对。43 字符随机令牌暴力不可行，但属公开面多余残留。**建议**：随方案A 一起移除端点 + `validate_merchant_token` helper + 测试；若确需保留，加 admin token + 限流。

#### P3-04：令牌吊销未覆盖账号会话的发现条目 delete/list

**位置**：`api/handlers/discovery_entries.py:66-88`（会话认证路径）；`services/discovery_entries.py` 仅 `create_entry` 检查 active token，`delete_entry`/`list_entries` 无 active 检查。

**证据（主审查核实）**：令牌被吊销的商家仍可经 7 天会话 cookie 删除/列出其发现条目，仅不能新建。「revoke = fail-closed」在写面间不一致。范围限自身数据，非越权。**建议**：`delete_entry` 同样强制 `_require_active_token`，或文档显式声明会话凭据独立于令牌吊销而存续。

#### P3-05：死 schema `merchant_tokens.shopping_token_encrypted`

**位置**：`db/migrations.py:743-752`（migration 020）、`db/models.py:215-217`。70a671e 移除代理/绑定特性后列保留但代码不再读写。**建议**：新迁移 drop 列并移出 SCHEMA。

#### P3-06：公开发现搜索共享单桶匿名限流，可被单客户端 DoS

**位置**：`api/handlers/discovery_entries.py:166-174`，`key="discovery_search:anonymous"`，默认 60/min 全匿名买家共享，无 per-IP 维度。

**证据（主审查核实）**：单个客户端即可耗尽共享预算，使公开搜索对所有人 429。**建议**：按客户端 IP（代理时取 X-Forwarded-For）分桶，或大幅提高共享额度。

#### P3-07：明文 owner token 在每次 `/login` 与 `/accounts/me` 返回（印证 §三 P2-C）

agent 独立确认 `account_view` 含解密明文令牌，永久 `mkt_` 令牌在每次认证视图都交付客户端，不仅签发时。属「令牌找回」设计，但扩大长期凭据暴露面（登录响应、每次 /me、下游 JSON 日志）。**建议**：评估改为显式 `POST /v1/accounts/token/reveal` 才回明文，`/me` 只回状态 + 前缀。

#### P3-08：`resolve_merchant_by_token` 是 O(active_tokens) 线性扫描

**位置**：`services/merchant_tokens.py:270-279`。每次 `/v1/merchants/self?owner_token=` 遍历全部 active 行逐行常量时间比较。当前规模无碍，随商家数线性退化。**建议**：建 `(token_hash → merchant_id)` 查找表或哈希唯一索引。

#### P3-09：测试卫生——ResourceWarnings + CLAUDE.md skip 数漂移

测试输出重复 `ResourceWarning: unclosed database`（指向 `db/migrations.py:297`）；CLAUDE.md「5 skip」实际 10。

### 5.3 kiwi（HEAD `5d7590d`）——公网认证边界与协议修复

**总体**：上一轮 P1/P2 批次修复质量高且全部经测试锁定——`npm run typecheck` / `npm run lint` 干净，`npm test` 123 files / **1782 tests 全过**。核心架构主线「Ledger 是持久事实、幂等只是索引」在 P1-05 恢复、P1-06 锁后再读、P1-07 相位机恢复、KTH ledger 投影中一致贯彻。上轮 P1-08/09/10/11、P2-01/02/03/04 均确认修复有效。残余问题集中在两处：① accept 路径绕过相位机权威守卫（下述 P1-C，本轮最重）；② 新认证边界 `loopback` 模式与「每商品成交入口」接线都半成品（P2-E / P3-11）。

#### P1-C：merchant-handler accept 分支忽略相位机结果，可产出相位机拒绝登记的协议

**位置**：`src/a2a/server/merchant-handler.ts:613`（`await advancePhase(negotiationId, { type: "accept_nonbinding", offer_id })` 未检查返回值）；对比顶层 `:441` 的 `if (!advanced) return declineReply("state_conflict")`。

**证据（主审查逐行核实）**：`applyAccept`（`src/negotiation/state/phase.ts`）仅允许 `OFFER_OPEN → AGREEMENT_REACHED`，否则抛 `state_conflict`；`advancePhase` 捕获后返回 `false`。accept 分支在 `buildAgreement`（约 `:596`）**之后**调用 `advancePhase` 且忽略返回，随后无条件 `return { kind: "accepted", ... }`。买家在商家已发 `conditional_offer`（OFFER_OPEN）后发 `clarification`（顶层 advance → `AWAITING_CLARIFICATION`），再直接 accept：offer_id/valid_until/terms_digest 全部校验通过、协议创建并返回，但相位机拒绝推进、ledger 无 `AGREEMENT_REACHED` 转换。进程内 `closedNegotiations` 阻断二次 accept；但**重启后 recovery（`:378-422`）按 ledger 事件重建相位为 AWAITING_CLARIFICATION**，二次 accept（新 message_id）可再次通过业务校验产出**重复协议**。

**影响**：绕过 BUG-10/P1-07 建立的权威终态守卫——与上轮 P1-07 同类（终态绕过 + 重复业务动作）。KNP 协议非绑定，直接商业影响受限，但若协议日后附加任何绑定性/支付副作用则升 P1。**建议**：accept 分支将 `advancePhase` 失败按 `declineReply("state_conflict")` 处理，且**不得返回协议**；相位机推进应在 `buildAgreement` 之前或与其原子绑定。

#### 同 §三 P2-D：`StaticBearerAuthVerifier` 令牌比较非常量时间

**位置**：`src/a2a/server/auth.ts:83`。对照 `src/agent/memory/vault.ts:154`（master-key 已用 `timingSafeEqual`）。公网 `KIWI_A2A_AUTH=bearer:<token>` 边界对共享 VPS/LAN 对手存在时序侧信道。**建议**：长度预检 + `crypto.timingSafeEqual`。

#### 同 §三 P2-E：`loopback` 模式对代理流量等价 `none`

**位置**：`src/a2a/server/auth.ts:94-115`、`src/a2a/node.ts:310`。见 §三 P2-E。**建议**：`loopback` 标注为仅本地开发；公网推荐 `bearer`。

#### P3-10：`product-publish.ts:395` 无条件把每件商品标为 `external_checkout_url`

**位置**：`src/product-publish.ts:385-398`。`handoff_destination_types: ["external_checkout_url"]` 硬编码，与商家实际存的 opaque ref（`merchant_contact`/`quote_document`/`purchase_order_draft`）不符；`validateDestination`（`destination.ts:109`）随后拒非 URL ref，`executeHandoff` 会对 opaque ref 做非预期的 URL/SSRF 探测（`transaction.ts:279`）。**建议**：从来源元数据派生类型（单一来源 `DESTINATION_TYPES`），不硬编码。与 §5.1 P2-A 同根。

#### P3-11：买家发现面丢弃商家声明的成交入口，「每商品成交入口优先」未接线

**位置**：`src/agent/buyer/buyer-tools.ts:1369-1381`（`search_listings` 未映射 `handoff_destination_ref`/`handoff_destination_types`，二者是 `contracts/kiwi-catalog/1.0/listing-record.schema.json` 的 oneOf 必需顶层字段）；`shortlist_listing`/`taskDeclaredHandoff`（约 `:1244`）随之几乎总是回退到 LLM 构造的目的地。commit `6c90780` 标题声明的「每商品成交入口优先」端到端未生效。URL 安全 + 审批门仍兜底，故 P3。**建议**：在 `search_listings` 输出透出 `handoff_destination_ref/types`。

#### P3-12：`KIWI_A2A_AUTH` env 边界无测试覆盖

**位置**：`src/a2a/node.ts:188-206`；tests 仅直接测 verifier 类与 options 注入，`tests/a2a-node.test.ts` 对 `KIWI_A2A_AUTH` 零命中。启动门禁与 env 解析是本次提交的安全关键面，回归（如拼写错误静默回落 `none`）不会被测出。**建议**：为每种 env 模式与「非 loopback + 无 verifier 抛错」补测试。

#### P3-13：`product-publish.ts:145` IPv6 loopback 判定缺陷

**位置**：`src/product-publish.ts:145`，`parsed.hostname === "::1"`——Node `new URL("http://[::1]").hostname` 实际返回 `"[::1]"`，故 `http://[::1]` catalog 域名被误判为远程而拒绝。**建议**：同时比较 `"[::1]"` 或复用 `isLoopbackHost`。

## 六、验证方法与结果

- **范围界定**：以上轮审查快照 HEAD（kiwi `1e34fc1`、catalog `ea6f977`、shopping `78d5c12`）到当前 HEAD 的 `git diff --stat` 为重构增量（kiwi +2747 行、catalog +4467、shopping +674），逐文件审阅该增量并抽读所触模块。
- **三路并行深度审查**：每仓一个独立 subagent，对其 CLAUDE.md/架构文档为基线，独立复现关键路径（git show、grep、读源码、跑测试），返回带 file:line 与证据的发现。
- **主审查交叉核实**：对全部 P1 与关键 P2 断言逐条亲自读码核实（portfolio.lock 消费链、token/validate 端点的双栈注册与无限流、accept 分支的 `advancePhase` 返回值、`public_product_summary` 剥离清单、`handoff_destination` 跨仓链路、`KIWI_A2A_AUTH` 各模式语义、发现搜索限流键、`product-publish.ts` 映射等），并对断言与代码不一致处按代码为准修正。
- **测试与静态检查**：kiwi `npm test` 123 files / 1782 tests 通过，typecheck/lint 干净；catalog `python3 -m unittest discover -s tests` 335 passed / 10 skipped（FastAPI 条件，CLAUDE.md 记录的 skip 数已漂移）；shopping `pytest` 820 passed / 9 skipped / 190 subtests。GitHub 上上轮 CI（pytest 门禁、cosign、CodeQL、契约锁）已按上轮建议修复并提交。

## 七、CI / 安全姿态

- dependabot：三仓均配置（kiwi: npm + github-actions；catalog/shopping: pip + 插件 npm）。
- CodeQL：三仓均配置，push main + PR 触发。
- 契约锁校验已接入 `portfolio-contracts.yml`（verify-contracts.mjs + verify_contract_lock.py + vectors）。
- 工作树干净；全部修复已提交。

## 八、发布前验收清单

**P1（发布阻断，须先关闭）**

- [ ] 重新锚定 `portfolio.lock.json` + 三仓 `kiwi-contracts.lock.json` 至当前选定提交，更新 `contract_bundle_sha256`，跑通组合 contract / 签名 / build / registry preflight（P1-A）。
- [ ] 删除或保护 catalog `/v1/merchants/{id}/token/validate` 死端点（P1-B）；删除后同步移除 `validate_merchant_token` helper 与测试。
- [ ] 修复 kiwi merchant-handler accept 分支：`advancePhase` 失败按 `declineReply("state_conflict")` 处理且不得返回协议；补「澄清挂起态直接 accept」+「重启后二次 accept」回归测试（P1-C）。

**P2（下个发布周期前关闭）**

- [ ] 决策并测试 `handoff_destination` 的公开可见性：无校验自由文本 + kiwi 无条件标 `external_checkout_url` + 未在 `public_product_summary` 剥离（P2-A / P2-B / P3-10）。
- [ ] `StaticBearerAuthVerifier` 改常量时间比较（P2-D）。
- [ ] `loopback` 模式标注仅限本地开发，公网推荐 `bearer`；启动时对非 loopback 广告地址 + `loopback` 模式输出警告（P2-E）。
- [ ] 更新 CLAUDE.md 令牌存储描述；明确 Fernet 可逆存储威胁模型（P2-C / P3-07）。

**P3（代码卫生/一致性）**

- [ ] §五 P3-01…P3-13 按项目节奏关闭（枚举面、stub 行清理、pidfile 0600、吊销与会话一致性、死列、匿名限流分桶、O(n) 扫描、买家发现面透出成交入口、KIWI_A2A_AUTH 测试、IPv6 loopback、测试卫生）。

**通用**

- [ ] 三仓全量测试 + 静态检查 + actionlint 通过（以最新工作树为准）；kiwi 补 `KIWI_A2A_AUTH` env 边界测试。

## 九、审查声明

本报告基于 2026-08-11 的三仓快照（kiwi `5d7590d`、kiwi-catalog `70a671e`、shopping-cli `5ad9ec8`），工作树干净。审查以只读方式进行，未修改产品代码。报告中的严重性评估基于代码静态审读与局部测试，不替代发布前的密钥/环境审计、生产演练与真实组合 release rehearsal。逐仓深度发现（§五）由独立 subagent 完成，主审查已对其全部 P1 与关键 P2 断言逐条核实；agent 内部编号与本文档全局编号的映射已在对应条目标注。
