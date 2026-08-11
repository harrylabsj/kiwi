# Kiwi 生态代码审查与修复跟进报告

## 审查对象

`kiwi` 0.6.0、`kiwi-catalog` 0.1.0、`shopping-cli` 3.0.0 之后的代码改动（包含审查快照时可见的工作树改动）。

**审查快照**：2026-08-10（Asia/Shanghai）  
**当前修复状态**：已暂停在本报告所述工作树状态；不建议发布。代码修复由 Claude-Ds 落地，本报告记录独立验收结果。  
**原始发现统计**：P0 0 项，P1 16 项，P2 7 项。

## 一、执行摘要

本次审查没有发现 P0，但发现 16 项会影响发布、跨仓信任、幂等性、凭据安全或公共数据边界的 P1 问题。最需要优先处理的是：

1. `kiwi-catalog` 的域名重注册会把旧域名的端点、profile 和验证证据留在新域名下，导致新域名可能继承旧域名的 `commerce_verified` 信任状态。
2. Kiwi 的 UCP 发布模型与自身消费者/校验器不一致；catalog 又允许缺少 KNP 版本、规范和 schema 的 capability 进入商业信任评估。
3. 多处交付、入站处理和终态保护不是原子或不可绕过的，重试/并发下可能重复处理、重复交付或重复接受取消。
4. shopping-cli 的候选商品接口会向具备有效 buyer/channel token 的调用者返回库存、商户联系方式和自动化边界等内部字段；自定义 HTTP opener 还可能在跨源重定向前泄露 Bearer。
5. 发布流水线存在测试入口遗漏、Cosign 参数错误、独立 PyPI 发布器和多注册表不可恢复等问题，发布结果可能部分成功或绕过中央保护流程。

在所有 P1 修复、回归测试和 portfolio lock 更新完成前，建议将三个仓库标记为 release blocked。审查阶段未修改产品代码；本轮修复由 Claude-Ds 完成，验收方未直接编辑产品源代码。

## 修复跟进状态（截至 2026-08-10 暂停点）

### 当前工作树与独立验收

| 仓库 | 当前 HEAD | 工作树 | 独立验收结果 |
|---|---|---|---|
| `kiwi` | `1e34fc19d6bdbd43fba97b866574d73277acd4d7` | 有未提交修复与测试；另有未跟踪审查 DOCX | `npm test`：122 files / 1770 tests passed；lint、typecheck、build、contracts、vectors、package smoke 均通过 |
| `kiwi-catalog` | `ea6f97716247242e8db74b40274f9bf7067c7271` | 有未提交修复、UCP/KNP 回归测试和新增服务文件 | pytest：581 passed；Mypy 通过；Ruff 失败 1 项（`tests/test_knp_trust_evaluator.py:502` 未使用 `json` 导入） |
| `shopping-cli` | `78d5c127002141ec5dfa5bef0b0dc639ea127bad` | 有未提交修复与回归测试；`.claude/` 为代理工作目录 | pytest：828 passed、194 subtests passed；Ruff/Mypy 通过 |

`git diff --check` 在三仓均通过。测试结果只代表当前暂停点，不代表已完成提交、组合锁或真实发布演练。

### 问题关闭矩阵

| 问题 | 当前状态 | 验收说明 |
|---|---|---|
| P1-01 域名重注册信任继承 | 已实现，待最终合并 | catalog 域名/端点/证据清理与 domain-control 回归已加入；完整 pytest 通过 |
| P1-02 buyer/channel 私有字段泄露 | 已实现，待最终合并 | 公共投影覆盖 candidates/selected 和幂等响应；shopping 全量 pytest 通过 |
| P1-03 Kiwi UCP 发布/消费模型漂移 | 基本修复，跨仓演练待做 | Kiwi canonical publisher、capability 元数据和 catalog adapter 已加入；Kiwi UCP 测试及 catalog exact-shape 回归通过，尚未执行带最终 portfolio lock 的真实组合演练 |
| P1-04 KNP 信任绕过 | **未完全关闭** | capability ID 识别、版本/schema 门禁已加入；但当前 catalog `verifier.py` 仍以 `bool(knp_specs)` 推导 `has_spec`，`version + schema` 而缺 `specUrl` 的变体仍需修正；Ruff 另有测试文件未使用导入 |
| P1-05 入站提交失败重复执行 | 已实现，待专门 crash-after-handler 验收 | pipeline 已增加落账事实恢复；全量 Kiwi 测试通过，但随机 task-id 的独立故障注入验收尚未在暂停点完成 |
| P1-06 handoff 同目的地双交付 | 已实现，待最终合并 | 目的地锁键和锁内 ledger 重读已加入；handoff 回归通过 |
| P1-07 商户终态重复转换 | 已实现，待最终合并 | 终态动作纳入 phase guard；相关 Kiwi 测试通过 |
| P1-08 `publicBaseUrl` URL 约束 | 已实现，待最终合并 | HTTPS origin-only 与 loopback 例外已加入；node/profile 回归通过 |
| P1-09 公网 agent 状态持久化 | 已实现，待最终合并 | CLI 使用稳定 agent data directory；重启/目录测试通过 |
| P1-10 Agent Card URL scheme | 已实现，待最终合并 | product publish 构造绝对 HTTPS URL；发布回归通过 |
| P1-11 owner token 重定向 | 已实现，待最终合并 | 认证 catalog 请求改为 manual redirect/fail closed；发布回归通过 |
| P1-12 shopping 自定义 opener 凭据泄露 | 已实现，待最终合并 | 任意 callable fail closed、OpenerDirector 去除 redirect handler；91 个定向测试、全量 pytest、Mypy 通过 |
| P1-13 中央 workflow 漏测 | 已实现，待组合 rehearsal | 中央 workflow 已改 pytest；actionlint 曾通过，最终 GitHub rehearsal 尚未执行 |
| P1-14 Cosign 参数错误 | 已实现，待组合 rehearsal | sign/verify 步骤已拆分并固定证书身份校验；仅完成静态检查，未在 GitHub OIDC 环境实跑 |
| P1-15 独立 PyPI 发布器 | 已实现，运维映射待确认 | catalog/shopping workflow 已改为 quality-only；仍需在 PyPI 删除旧 Trusted Publisher 映射 |
| P1-16 多注册表发布不可恢复 | 已实现，待组合 rehearsal | 中央发布拆成独立受保护 job，并加入版本存在性检查；未执行真实 registry 重跑演练 |
| P2-01 JCS U+2028/U+2029 | 已实现 | JCS 测试与 Kiwi 全量测试通过 |
| P2-02 出站 timeout timer 泄漏 | 已实现 | 相关出站路径改为最外层 finally 清理；全量 Kiwi 测试通过 |
| P2-03 UCP cache 超过 512 | 已实现 | cache cap/eviction 回归加入并通过 |
| P2-04 `ok:false` envelope 被当成功 | 已实现 | product publish fail-closed 回归通过 |
| P2-05 catalog 多商户按最新行授权 | 已实现 | merchant_id 精确授权与跨商户回归通过 |
| P2-06 搜索事件非法 JSON | 已实现 | bounded JSON 结构化缩减与 581 项 pytest 通过；需先清理 Ruff 导入错误 |
| P2-07 daemon 文件权限 | 已实现 | fresh/existing/rotated/stop 权限回归通过；shopping 全量 pytest 通过 |

### 当前发布阻塞项

1. 修正 `kiwi-catalog/kiwi_catalog/discovery/verifier.py` 的 `has_spec` 判定，并删除 `tests/test_knp_trust_evaluator.py` 中未使用的 `json` 导入。
2. 用最终选定的三个提交更新 `portfolio.lock.json`，再执行组合 contract、签名、构建、registry preflight 和重跑演练。
3. 对 Kiwi P1-05/P1-06/P1-07 做随机 task-id、真实并发和重复终态的独立故障注入验收；完成 Kiwi→catalog→Kiwi UCP 真实端到端演练。
4. 在 PyPI 侧确认已删除两个独立仓库 Trusted Publisher 映射；在 GitHub 受保护环境中实跑 Cosign/三 registry job。

本轮用户要求“先修改到此”，因此以上项目保留为明确的后续动作，Claude-Ds 已暂停继续改码。

## 二、基线、当前版本与范围

| 仓库 | 版本基线 | 基线提交 | 当前 HEAD | 范围说明 |
|---|---|---|---|---|
| `kiwi` | v0.6.0 | `494ebc6f57986c0e146fe1562ec7be40ee851f91` | `1e34fc19d6bdbd43fba97b866574d73277acd4d7` (`1e34fc1`) | 版本标签之后的提交及当前未提交修复 |
| `kiwi-catalog` | v0.1.0 | `68cd984465c97ea3123bd16a67621726c6b883f8` | `ea6f97716247242e8db74b40274f9bf7067c7271` (`ea6f977`) | 版本标签之后的提交及当前未提交修复 |
| `shopping-cli` | v3.0.0 | `b6f0caba346689743cd976606c277dd07a10f49f`（annotated tag peeled commit） | `78d5c127002141ec5dfa5bef0b0dc639ea127bad` (`78d5c12`) | 版本标签之后的提交及当前未提交修复 |

另发现 portfolio lock 已滞后：`portfolio.lock.json` 中的 catalog SHA 为 `0e01e8d54cb844c9f73a92ffa06e49491da8a67c`，shopping-cli SHA 为 `0b8507c852b38405a5d0d1138eb3c2da3361b614`，均不是当前 HEAD。`npm run verify:portfolio-lock -- ...` 因 catalog HEAD 不匹配失败。锁文件必须随最终选定提交一起更新，不能把未锁定的工作树直接发布。

## 三、验证方法与结果

- 审阅版本标签到当前 HEAD 的提交差异、工作树差异、跨仓协议/发布工作流和测试入口。
- 对关键问题编写最小复现或直接执行现有测试，重点覆盖重试、并发、重定向、跨域信任和公共投影。
- 检查 TypeScript/Python 静态检查、YAML/actionlint、契约锁、打包和发布前检查。

验证结果：

- `kiwi-catalog`：519 个测试通过；Ruff、Mypy、`git diff --check` 通过。
- `shopping-cli`：pytest 814 个测试通过、194 个 subtests 通过，coverage 85%；Ruff、Mypy、Node 检查、contract lock、wheel/sdist/入口点/npm pack 检查通过。
- 三个仓库的工作流 YAML/actionlint 及 consumer contract lock 检查通过，但组合发布入口仍有以下 P1 缺陷。
- `kiwi` 在并发工作树更新前完成过 Vitest 1710 个测试通过；随后又加入时钟/状态相关改动。最新工作树的类型检查及时钟测试通过，但由于渲染/测试过程需写入 `node_modules/.vite-temp` 且沙箱批准额度耗尽，未能重新完成最新工作树的全量 Vitest。该限制不改变已复现的代码问题，修复后必须补跑全量测试。

修复暂停后的独立复核已完成：Kiwi 当前工作树 `npm test` 为 122 个测试文件、1770 个测试全部通过，`npm run lint`、`npm run typecheck`、`npm run build`、`npm run verify:contracts`、`npm run verify:vectors` 和 `npm run verify:package` 均通过；kiwi-catalog 为 581 个 pytest 通过、Mypy 通过，但 Ruff 因 `tests/test_knp_trust_evaluator.py:502` 的未使用 `json` 导入失败；shopping-cli 为 828 个 pytest、194 个 subtests 通过，Ruff/Mypy 均通过。上述结果对应当前未提交工作树，不代表最终提交或组合发布已验收。

## 四、严重性定义

- **P1**：发布或合并阻断项。会造成信任提升错误、敏感信息泄露、重复业务动作、协议不可互操作或发布完整性破坏。
- **P2**：重要可靠性、规范一致性或运维风险。通常不会单独导致立即接管，但应在下一个发布周期前关闭。

## 五、P1 发现（发布阻断）

### P1-01：域名重注册保留旧端点，并沿用旧域名验证证据

**位置**：`/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/agent_catalog_writes.py:275-276`；验证链 `/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/agent_verification.py:516,640`。

**证据与影响**：商户先以 `one.example` 注册端点，再以 `two.example` 重注册且不提供 URL 时，数据库域名变为 `two.example`，但端点、profile 和验证证据仍指向 `one.example`；完整验证后可为 `two.example` 产生 `commerce_verified`。这会把旧域名的控制证明提升到新域名。

**建议**：域名变更时清除或重建 endpoint/profile/capability/evidence 快照，重新绑定 domain-control target；验证时以数据库规范化域名和 profile authority 做一致性校验。

### P1-02：buyer/channel 原始候选泄露库存与商户私有字段

**位置**：`/Users/jianghaidong/coding/shopping-cli/shopping_cli/agents/buyer_cli.py:108-109`；`/Users/jianghaidong/coding/shopping-cli/shopping_cli/core/channels.py:323`；公共投影定义 `/Users/jianghaidong/coding/shopping-cli/shopping_cli/core/catalog_views.py:8-31`。

**证据与影响**：`/buyer/ask` 与 `/channels/messages` 将原始 candidate/selected 对象返回给任何具备有效 buyer bootstrap/channel token 的调用者，复现可读到精确 `stock`、`merchant.contact`、`merchant.automation_boundaries`。这绕过了已有 `public_product_summary` 边界，形成库存、联系方式和商户策略泄露。

**建议**：在候选生成、选中结果、API 响应和幂等响应的所有出口统一调用 `public_product_summary`；对内部字段增加 schema/contract 测试，拒绝通过序列化回归。

### P1-03：Kiwi UCP 发布者与消费者/校验器模型漂移

**位置**：发布者 `/Users/jianghaidong/coding/kiwi/src/a2a/server/ucp.ts:120-136`；校验器 `/Users/jianghaidong/coding/kiwi/src/discovery/ucp/validate.ts:363-374`；消费者类型 `/Users/jianghaidong/coding/kiwi/src/discovery/ucp/types.ts:71-80`；协议要求 `docs/protocol/kiwi-negotiation-protocol-1.0.md:1012-1024`。

**证据与影响**：publisher 输出顶层 `specificationVersion/serviceIdentity/services[]` 和字符串数组 `capabilities`；同一输出直接喂给仓内 `validateUcpProfile()` 会失败：`profile_malformed: /ucp must be present`。发布的 capability 还缺少 KNP 强制的 `version/spec/schema`。结果是 Kiwi→Kiwi UCP 往返失败、转入 Agent Card fallback，且 capability intersection 永远缺失。

**建议**：选定唯一规范模型或提供显式 adapter；补齐 capability 的 version/spec/schema/authority；新增 publisher → validator → consumer 的 round-trip 测试。

### P1-04：catalog 对 KNP capability 的识别与信任评估可被绕过

**位置**：`/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/discovery/ucp.py:183`；`capabilities.py:181-183`；`verifier.py:356-414`。

**证据与影响**：解析器仅要求 capability 是字符串列表，并把版本/spec/schema 置空；KNP allowlist 只在 endpoint `protocol` 被标成 `knp` 时启用。将 Kiwi 发布的 `com.harrylabsj.kiwi.shopping.negotiation` 放在 `protocol: a2a` endpoint 中，实跑 parser/evaluator 得到 `passed=True`、`commerce_capability_count=1`、`claimed_knp_versions={}`，可推进 `commerce_verified`，绕过 KNP 版本、规范、schema 和 allowlist。

**建议**：按 capability ID/namespace 识别 KNP，不依赖 endpoint protocol；强制要求有效 version/spec/schema/authority，并对 Card 与 UCP 做真实交集而非简单并集。

### P1-05：入站幂等在提交失败后会重复执行 handler

**位置**：`/Users/jianghaidong/coding/kiwi/src/a2a/server/pipeline.ts:290-303`；`/Users/jianghaidong/coding/kiwi/src/negotiation/ledger/event.ts:267`；复现测试 `tests/a2a-server.test.ts:795`。

**证据与影响**：handler 先执行，ledger append/commit 后发生故障；重试时 taskId/digest 改变，handler 再次执行。复现得到 `handler_calls=2` 和两条 `message_received`。支付、库存或其它商业动作可能被重复触发。

**建议**：持久化稳定的执行事实/结果并与幂等键原子提交；提交失败的重试必须能重放同一结果，而不是重新执行 handler。

### P1-06：Handoff 锁粒度不足导致同一目的地双交付

**位置**：`/Users/jianghaidong/coding/kiwi/src/handoff/transaction.ts:113-117`。

**证据与影响**：锁只覆盖 candidate ID；两个不同 candidate 但相同 agreement/destination 的并发交付都能通过。屏障复现两次 `handoff_delivered`，状态均为 delivered。

**建议**：锁键至少使用 `(agreement_id, destination_type, destination_ref)`；锁内重新读取 ledger、执行终态检查并将交付事实与状态变更原子化。

### P1-07：商户终态保护未覆盖 withdraw/decline/cancel

**位置**：`/Users/jianghaidong/coding/kiwi/src/a2a/server/merchant-handler.ts:210-217`；状态转换 `/Users/jianghaidong/coding/kiwi/src/negotiation/state/phase.ts:250`。

**证据与影响**：`COMMERCIAL_ACTIONS` 排除了 withdraw/decline/cancel；两个 cancel 消息可被接受，ledger 出现 `CANCELLED -> CANCELLED`，终态被重复写入且绕过统一 transition guard。

**建议**：所有商业动作统一经过 `transitionPhase`/ledger-derived state；仅允许幂等重放，不允许把终态再次当作新动作接受。

### P1-08：`publicBaseUrl` 接受不符合承诺的 URL

**位置**：`/Users/jianghaidong/coding/kiwi/src/a2a/node.ts:136-151`。

**证据与影响**：当前只检查 `http(s)`，接受远程明文 HTTP、userinfo、path/query/fragment。后续 Agent Card/UCP URL policy 会拒绝远程 HTTP；将路径与 `/.well-known/...` 字符串拼接还会产生错误地址。README 与字段注释已承诺公网 HTTPS。

**建议**：公开配置只接受 HTTPS origin（无 userinfo/path/query/hash）；HTTP 仅允许自动生成的 loopback URL。以 `url.href === url.origin + '/'` 等价语义做校验。

### P1-09：`agent serve` 首次启动仍使用临时状态目录

**位置**：`/Users/jianghaidong/coding/kiwi/src/cli.ts:535-541`（重建路径在 `:560-566`）；节点持久化能力在 `/Users/jianghaidong/coding/kiwi/src/a2a/node.ts:162-171,284-288`。

**证据与影响**：节点层已有 `dataDir`，但 public `agent serve` 的第一次 CLI 调用没有传入 `args.dataDir`，仍创建临时 ledger/idempotency。进程重启会丢失已发布状态和幂等事实。

**建议**：首次启动与 rebuild 使用同一稳定目录；未指定时使用稳定的 agent data directory，并增加 stop/restart 状态保持测试。

### P1-10：首次商品发布写入无 scheme 的 Agent Card URL

**位置**：`/Users/jianghaidong/coding/kiwi/src/product-publish.ts:198-205`。

**证据与影响**：`agentCardUrl` 由裸域名拼成 `${domain}/.well-known/...`。catalog 需要 `http(s)`，且公网路径应为 HTTPS；首次注册随后会在验证阶段失败。

**建议**：构造真实的绝对 HTTPS URL（本地开发明确使用 loopback 例外），在发送前用同一 URL parser/校验器验证。

### P1-11：商品发布/撤回请求的 owner token 可被跨源重定向转发

**位置**：`/Users/jianghaidong/coding/kiwi/src/product-publish.ts:332-337,421-427`；正确示例 `/Users/jianghaidong/coding/kiwi/src/discovery/catalog-source/register.ts:101` 使用 `redirect: manual`。

**证据与影响**：默认 fetch 会跟随 307/308；跨源重定向可重放包含 `owner_token` 的 JSON。注册路径已手动禁止重定向，说明其余认证调用是不一致的。

**建议**：所有带 owner token 的请求统一 `redirect: manual`，验证 Location 只允许同源 HTTPS；增加跨源 307/308 不泄露测试。

### P1-12：shopping-cli 注入的自定义 opener 会在跨源重定向前泄露 Bearer

**位置**：`/Users/jianghaidong/coding/shopping-cli/shopping_cli/http_client.py:170-187`。

**证据与影响**：自定义 opener 可能先跟随 3xx，再在 `_assert_same_origin`（约 `:186`）之前复制 Authorization。Python redirect handler 复现恶意目标收到 `Bearer secret-token`。默认 opener 使用 `_NoRedirectHandler`，但注入 opener 仍可触发问题。

**建议**：移除或限制自定义 opener；强制使用 no-redirect handler，并在任何重定向处理前检查 origin、scheme 和端口；补充 injected-opener 回归测试。

### P1-13：中央发布/集成工作流使用 `unittest`，漏掉 shopping-cli pytest

**位置**：`/Users/jianghaidong/coding/kiwi/.github/workflows/portfolio-release.yml:230-239`；`portfolio-integration.yml:122-131`。

**证据与影响**：两处调用 `python -m unittest discover -s tests`。shopping-cli 的 `ab68ece` 已将自身质量门从 unittest 修正为 pytest，因为原入口遗漏约 240 个测试。中央门禁因此可能显示绿色但未执行完整测试集。

**建议**：统一使用 `python -m pytest tests/ -q`，把 coverage/contract lock 纳入中央门禁，并随最终 HEAD 更新 lock SHA。

### P1-14：Cosign 签名工作流把验证参数传给签名命令

**位置**：`/Users/jianghaidong/coding/kiwi/.github/workflows/portfolio-release.yml:295-302`；重复问题 `/Users/jianghaidong/coding/kiwi/.github/workflows/release-rehearsal.yml:95-102`。

**证据与影响**：`--certificate-identity` 与 issuer 是验证阶段参数，当前被传给 `cosign sign-blob`，签名 job 会在上传前失败。官方文档分别将 signing 与 verifying 参数分开。

**建议**：签名步骤只使用签名所需参数；签名后用独立 `cosign verify-blob` 校验证书 identity/issuer，或统一保存并验证 bundle。

### P1-15：catalog 与 shopping-cli 各自保留独立 PyPI 发布器

**位置**：`/Users/jianghaidong/coding/kiwi-catalog/.github/workflows/pypi-publish.yml:8-47`；`/Users/jianghaidong/coding/shopping-cli/.github/workflows/pypi-publish.yml:8-30`。

**证据与影响**：任意 `v*` tag 或手工 dispatch 即可发布，拥有 id-token 写权限，没有 protected environment、完整 SHA 校验或 portfolio composition；catalog 还使用可变的 `setup-uv@v5`。这绕过 Kiwi 中央受保护发布流程，并允许单仓越过组合验证直接发布。

**建议**：删除/禁用两套 workflow 及对应 Trusted Publisher 映射，统一由中央、受保护、可审计的 portfolio release 发布。

### P1-16：多注册表发布不可恢复，失败会留下部分公开版本

**位置**：`/Users/jianghaidong/coding/kiwi/.github/workflows/portfolio-release.yml:359-376`。

**证据与影响**：流程按 npm → catalog PyPI → shopping PyPI 顺序发布；后一步失败时前一步已公开，重跑又可能因 npm 版本已存在而冲突，无法安全恢复。

**建议**：发布前预检所有版本、包和签名；每个 registry 使用可重入 job，已存在且 digest/版本完全一致时跳过，存在不一致时 fail closed；将 registry 发布拆为可独立重试的受保护 job。

## 六、P2 发现（重要跟进）

### P2-01：JCS 对 U+2028/U+2029 的序列化偏离 RFC 8785

**位置**：`/Users/jianghaidong/coding/kiwi/src/negotiation/jcs.ts:66-68`。

代码显式把 U+2028/U+2029 替换成 `\\u2028/\\u2029`；RFC 8785 §3.2.2.2 要求非控制类 Unicode 字符按原字符序列化。不同实现可能产生不同 digest/signature。建议删除特殊替换并加入官方/跨实现 vectors。

### P2-02：多处 timeout timer 只在成功路径清理

**代表位置**：`src/commerce/shopping-cli-source.ts:136-150`；同类位置包括 `src/a2a/client/client.ts:87`、`src/commerce/http-client.ts:99`、`src/discovery/catalog-source/kiwi-source.ts:143`、`src/discovery/catalog-source/source.ts:147`、`src/discovery/resolve.ts:308`、`src/discovery/ucp/resolver.ts:201`。

fetch 异常、重定向或非 2xx 路径可能留下 timer，长期运行会积累句柄和内存。建议把 timer 生命周期放入最外层 `try/finally`，并为失败路径增加测试。

### P2-03：UCP resolver cache 在全为有效项时可无限超过 512

**位置**：`/Users/jianghaidong/coding/kiwi/src/discovery/ucp/resolver.ts:279-285`。

达到 512 后只清理过期项；如果全部有效且远端 `max-age` 很长，插入会继续增长到 513+。建议采用 LRU/最旧项淘汰，并设置最大 TTL。

### P2-04：商品发布对 `ok:false` JSON envelope 未 fail closed

**位置**：`/Users/jianghaidong/coding/kiwi/src/product-publish.ts:274-279`。

HTTP 成功但 JSON 为 `ok:false` 时，解析结果可能为空，调用方仍可能把操作当作成功或在撤回时清空全部 projections。建议明确要求 `ok === true` 且 `results` 为数组，否则返回失败并保留现有状态。

### P2-05：catalog 多商户同域名授权选择“最新行”而不是 merchant_id

**位置**：`/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/api/handlers/agent_catalog.py:481-493`。

迁移 v17 后 domain 不再唯一，但授权逻辑仍按最新记录选择 merchant token；复现中合法商户 A 会因已暂停的商户 B 被拒绝。建议使用 `(merchant_id, normalized_domain)` 精确选择；匿名请求需定义多记录冲突策略。

### P2-06：buyer search event 截断序列化后的 JSON，读取时静默丢失

**位置**：未跟踪文件 `/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/buyer_search_events.py:58-60`。

代码先 `json.dumps` 再截断到 2000 字符，可能截断在字符串/转义中间；读取时解析失败并静默返回空事件。建议先约束结构和值，再序列化；写入前/读取时使用 `json_valid` 或显式错误。

### P2-07：shopping-cli daemon 新建日志和 stop 文件权限为 0644

**位置**：`/Users/jianghaidong/coding/shopping-cli/shopping_cli/agents/merchant_daemon.py:457-462,554`。

`Path.open("ab")` 在常见 umask 下创建 0644；只有轮换路径设置了 0600。日志可能含订单/商户信息，stop 文件也不应被其他用户改写。建议使用 `os.open(..., 0o600)`，并对既有文件、备份文件和 stop 文件执行 `chmod 0600`。

## 七、建议的修复顺序与验收门槛

### 第一批：先封住信任与数据边界

1. 修复 P1-01、P1-03、P1-04，统一 domain-control、UCP、KNP capability 模型。
2. 修复 P1-02、P1-11、P1-12，建立公共投影和凭据重定向的单一出口。
3. 为每项新增跨仓契约测试：Kiwi build → catalog parse/verify → Kiwi consumer round-trip。

### 第二批：保证业务动作不会重复或跨终态

1. 修复 P1-05、P1-06、P1-07、P1-09，覆盖 crash-after-handler、并发交付、终态重放和 restart/recovery。
2. 修复 P1-08、P1-10，统一 URL origin/HTTPS 校验并覆盖本地 loopback 例外。

### 第三批：修复发布门禁与可恢复性

1. 修复 P1-13、P1-14、P1-15，确保只有中央发布工作流能发布，并且测试/签名参数正确。
2. 修复 P1-16，完成 registry preflight、digest 幂等和独立可重试 job。
3. 更新 `portfolio.lock.json`，再执行完整组合发布 rehearsal。

### 合并前验收条件

- 所有 P1 具备回归测试，复现用例在修复后稳定通过。
- 三仓全量测试、静态检查、actionlint、contract lock 和打包检查通过。
- Kiwi 最新工作树补跑完整 Vitest；不得只依赖旧快照的通过结果。
- portfolio lock 与将要发布的三个提交完全一致。
- 发布 rehearsal 在隔离环境中验证签名、registry 重跑和单仓 workflow 不可绕过。

## 八、外部规范依据

- Sigstore Cosign 签名：[Signing with blobs](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/)
- Sigstore Cosign 验证：[Verify](https://docs.sigstore.dev/cosign/verifying/verify/)
- RFC 8785 JSON Canonicalization Scheme：[§3.2.2.2 Serialization of Strings](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.2.2)

## 九、审查声明

本报告是基于上述提交、工作树和测试快照的代码审查结果，不替代发布前的安全验证、密钥/环境审计或生产演练。报告作者未修改三个产品仓库；修复应由项目负责人在确定的提交范围内完成，并重新生成锁文件与验证记录。
