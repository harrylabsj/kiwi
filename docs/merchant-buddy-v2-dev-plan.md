# Kiwi Merchant Buddy V2 开发计划

**日期：** 2026-09-14
**依据：** `kiwi-merchant-buddy-v2.md`（设计基线 `main@267485d` / v0.8.0）
**关系：** V1 MVP（facade + 远程 MCP + token 连接器 + 审批恢复，见 `workbuddy-buddy-app-dev-plan.md`）已交付，本文档是 V2 全量版的实施计划，V1 成果作为地基演进，不重写。

## 一、与 V1 MVP 的 Delta

| V2 要求                                                        | V1 现状                                                     | 差距                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 标准远程 MCP adapter                                           | 已有（`src/mcp/merchant-server.ts`，无状态 streamableHttp） | 需加 OAuth、按 scope 过滤 tools/list                                                                         |
| 共享业务服务层                                                 | `src/merchant/workbench-service.ts`                         | 演进为 `src/merchant-core/`（service/commands/executor/operations/negotiation-adapters）                     |
| 审批持久恢复                                                   | `recoverPendingDrafts`（重启重建钩子，仅 draft）            | 持久命令记录 + 固定执行器注册表，覆盖全部写工具                                                              |
| 连接器包                                                       | 已有（用户自填 token 模式）                                 | 内置连接器须 OAuth；token 模式仅作市场过渡                                                                   |
| 工具命名/契约                                                  | `merchant_*` 7 个                                           | 改为 `kiwi_merchant_*`；写操作 prepare_*；批准/拒绝经管理页面（审查 BUG-02：execute/reject 不进 MCP 注册表） |
| 展示组件                                                       | 七类 presentation 走内部 ui 事件                            | 映射为 MCP Apps 资源 + 文本降级                                                                              |
| 7×24 运维、部署包、运行时管理                                  | 未做                                                        | 全新（`src/merchant-runtime/`、`deploy/merchant-bundle/`）                                                   |
| F01–F30 其余（init/publish/setup-public/记忆/私密面板/微信等） | 未接入                                                      | 主体工作量                                                                                                   |

## 二、P0 现存问题（不等阶段排期）

1. ~~A2A handler 固定交期 `2026-08-20T18:00:00Z` 已过期~~（2026-09-14 已修复：`merchant_policy.delivery_lead_days` 权威交期动态计算，未配置则 terms 省略 delivery_before + clarification 提示与商家确认；`resolveDeliveryBefore` in `src/a2a/server/merchant-handler.ts`）。
2. ~~`merchant listings/status/doctor` 占位命令宣传~~（已移除帮助文案宣传；命令保留明确「尚未实现」报错，侵入性最小）。
3. ~~`pauseListing` 语义选型~~（已选定「销售状态」= catalog paused flag 语义，禁止库存写零伪装下架；上游 shopping-cli 2.x 无端点 → fail-closed 报「不可得」，能力探测标定 `listing_pause=false`；记录于 `merchant-client.ts` 注释）。
4. ~~磋商摘要 terms 提取不全~~（已覆盖 counter_offer.proposed_terms / conditional_offer.base_terms / 最终协议 agreed_terms；needs_human_review = AWAITING_CLARIFICATION 或「非终态且最后一条为买家入站 offer/counter_offer/clarification 等待商家回应」）。
5. ~~版本组合锁定~~（2026-09-16 起由**协议协商**取代：安装期保留 `>= 2.0.0` 最低门槛粗检，运行时 `probeCapabilities()` 消费网关 `/capabilities` 的 `protocol_versions`，不含 `shopping.negotiation/0.1` → 硬拒启动；协商不可用回退 2.x legacy 已验证线（`< 3.0.0`），不可判定 fail-closed。详见附录第三批修复记录）。

## 三、前置决策

1. OAuth 实现路径（2026-09-15 spike 已确认）：WorkBuddy **不是** OAuth provider，其内置 OAuth 管理器只完成客户端侧流程（OAuth 2.1 + PKCE、公共客户端、动态客户端注册 RFC 7591），**服务端端点须自建**。需在 MCP Server 侧实现：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/oauth/register`（RFC 7591，须回显 redirect_uris）、`/oauth/authorize`（PKCE S256）、`/oauth/token`（access_token ≈1h + refresh_token ≥30d，支持 refresh_token 授权类型）。redirect_uri 精确匹配，优先 `workbuddy://workbuddy/mcp/connector%3A<source>/oauth/callback`，回退 `http://127.0.0.1:{动态端口}/oauth/callback`；授权码一次性、约 10 分钟有效；连接器侧 `auth_mode` 省略即走 OAuth。依据：https://open.workbuddy.cn/docs/connector 。
2. 工具命名采用 `kiwi_merchant_*` 新名，V1 的 `merchant_*` 废弃（连接器未发布，无兼容负担）。
3. 先单商家隔离实例；OAuth 用户映射为服务端 principal_id，用户参数不能选择任意 merchant_id，跨商家切换须重新校验授权归属。
4. 部署形态：阶段一单活 + 自动重启 + 持续备份；主备 + fencing 租约切换放阶段四；主动主动不做。

## 四、分阶段实施

### 阶段一：完整边界和配套实例（约 2–3 周）

- 冻结 F01–F30 为验收矩阵（`tests/merchant-buddy/`）。
- ~~`src/auth/merchant-oauth.ts` + `merchant-authorization.ts`~~（2026-09-15 第一波已完成）：OAuth 2.1 授权服务器（元数据发现/RFC 7591 注册回显 redirect_uris/授权页 CSRF/PKCE S256/授权码一次性 10 分钟/access 1h + refresh 30d 轮换/RFC 7009 撤销；授权码与 token 只存 sha256 摘要落 `oauth.sqlite`）；`MerchantOAuthVerifier` 叠加在 `MerchantMcpAuthVerifier` 接缝上（租户越权拒绝、返回 principal/merchant/scope 授权上下文）；profile `merchant_mcp.auth_mode` = token（V1 过渡保留）| oauth；issuer 生产强制 https（loopback 可 http 推导）。scope 定义 merchant:read / merchant:write。第二波已接 tools/list 按 scope 过滤 + tools/call 逐次强制（静态 token 过渡模式全量）。
- ~~数据目录接线改造~~（已完成：`src/mcp/merchant-dirs.ts` 显式 merchantDataDir / principalDataDir / transportSessionId 三槽位；无状态传输会话不参与路径派生；重启路径稳定，agentId 经消毒）。
- ~~`src/merchant-runtime/`（manager/health/jobs）~~（2026-09-15 第二波已完成）：`MerchantRuntimeManager`（a2a/mcp 受管子进程、pidfile、异常退出退避自动重启、停止后可经管理入口重启、管理进程重启后从 pidfile 恢复视图）；`collectMerchantHealth`（进程/商品源探测记录/目录可写/磁盘分项报告，fail-closed）；`MerchantJobs`（健康轮询 + 持续备份显式接缝——备份实现留阶段四，缺省报「未实现」不静默成功）；CLI `kiwi merchant runtime start|stop|status|health`。
- ~~`deploy/merchant-bundle/`~~（已完成）：安装器（`--confirm-new-instance` 显式确认；已有安装/已有数据库 fail-closed 拒绝，不新建空库替代；`--dry-run`）、`versions.lock.json` 版本锁（与 `src/product-compat.ts` 单一来源有防漂移测试）、systemd + launchd 双模板、README 拓扑说明（单活 + 自动重启 + 持续备份；主备 fencing 留阶段四）。
- ~~能力探测~~（已完成：`HttpMerchantClient.probeCapabilities()`，故障/版本超上限 fail-closed 不编造数据）。
- ~~F01–F30 验收矩阵冻结~~（已完成：`tests/merchant-buddy/acceptance-matrix.ts` + 完整性测试——30 条连续无缺无重、covered/wired 必须挂真实测试证据、状态统计基线防倒退）。
- 验收：首次绑定到正确商家；关 WorkBuddy 后 A2A 持续服务；停止 A2A 后管理入口可重启——三条均有自动化测试（`tests/merchant-buddy/stage1-acceptance.test.ts`）。

### 阶段二：全量读取、分析、展示与记忆（约 2–3 周）

- ~~工具改名~~（2026-09-15 已完成）：MCP 工具 `merchant_*` → `kiwi_merchant_*` 全量改名；写工具改名 `kiwi_merchant_prepare_product_change`（prepare 语义；execute_approved/reject_candidate 属阶段三）。审批候选内部 tool 名（`draft_product_change`）不变——它是写门/恢复机制的内部标识，不是 MCP 工具名。连接器包 mcp.json/SKILL.md/buddy 配置同步；打包校验与防漂移测试全绿。
- ~~`src/merchant-core/service.ts`~~（已完成）：`MerchantCoreService` 包装 V1 workbench facade（白名单/租户/fail-closed 语义不变），MCP 工具层改经 core 调用（`MerchantWorkbenchSurface` 结构类型，既有调用方无感）；两轨统一列表与私密阈值接缝并入。
- ~~`negotiation-adapters.ts`~~（已完成）：统一列表带 `source_protocol`（a2a/shopping）与 `source_id`，状态名保留各协议口径；`assertReviewRoute` 跨轨 fail-closed（A2A 人审绝不调 shopping-cli resolve-review）；单轨不可用时 tracks 标 unavailable（明确「不可得」不缺半）。
- ~~`src/mcp/merchant-resources.ts`~~（已完成）：七类 presentation 映射 MCP 资源（`kiwi-merchant://presentation/<component>`），read 返回 JSON + 等效文本摘要双 content（降级不丢关键字段）；catalog/human_review enrich 加白名单 pick（上游多带字段也不泄露）；私密类无资源。MCP Apps 嵌入形态待平台预览验证。
- ~~六个商家 Skill 适配~~（已完成连接器包侧：SKILL.md 新工具名 + prepare→确认两阶段文案 + 展示资源说明；`skills/merchant/` 六个 Skill 绑 Pi agent 工具（未改名），无需适配；Buddy 六技能编排留平台配置）。
- ~~记忆治理（F22）与私密面板（F23）「不泄露」面~~（已完成）：远程场景不挂记忆/私密 MCP 工具；`readPrivateThresholds` 管理面接缝（读取审计落 private-access.jsonl，绝不记值；无审计目录拒绝裸读）；验收测试断言私密字段不出现在任何工具输出与资源。
- 验收：金额/时间/UTC 口径一致；缺失数据显示「不可得」不填零；不暴露其他商家或人员资料——均有自动化测试（`tests/merchant-buddy/stage2-acceptance.test.ts`）。

### 阶段三：所有经营写入闭环（约 2–3 周）

- ~~`src/merchant-core/commands.ts` / `executor.ts`~~（2026-09-15 已完成）：持久命令记录复用 `WriteApprovalCandidateStore`（tool/参数/前置版本 digest/授权主体/有效期/单次用途/状态机，state.sqlite 单 owner 写）；固定执行器注册表静态注册 7 个写工具（禁止动态分发）；恢复推广到全部写工具（`recoverPendingCommands`：已注册工具经注册表重建钩子，未注册的死候选标 expired），覆盖 V1 recoverPendingDrafts 语义。
- ~~写链路闭环~~（已完成；审查第一批加固后形态）：prepare → 预览（前后对照）→ 确认通道（**管理确认页** `/admin/pending`：管理员 cookie 会话 + 一次性确认凭证（绑定候选摘要/主体/商家/动作，单次用途）；execute/reject 不在 MCP 注册表——模型不可自我批准）→ 执行器重校验（前置版本重读重哈希/有效期/硬策略——私有底价执行器强制且不透气数值）→ 幂等执行（重放 not_approvable）→ 回读校验 → 审计（store 状态流转 + content hash + 确认记录含批准人/时间）。配套商家确认页面最小骨架：`src/merchant-admin/pending-page.ts` + `src/auth/merchant-sessions.ts`（管理员口令 scrypt 哈希，`kiwi merchant mcp admin-passwd` 初始化）。
- ~~覆盖写面~~（已完成）：prepare_product_create / prepare_inventory_update / prepare_listing_change（F08 销售状态语义，能力缺失 fail-closed「不可得」）/ prepare_review_resolve（F14 两轨：shopping 走 resolver，A2A 报「不可得」绝不跨轨）/ prepare_policy_change（F17 热更新：执行器写覆盖层即时生效）。
- 阶段二遗留核查（已修复）：chat kernel presentation 接线的 principalId 口径不一致——`merchant-tools.ts` presentationContext 与 kernel 的 intelligence backend principal 校验键统一为 owner_id（此前 agent_id ≠ owner_id 时 digest/catalog 展示必然校验失败/读空）。
- 验收：展示≠执行；无真实确认无法扩大权限；重复提交只执行一次；过期或对象已变更拒绝旧授权；重启恢复后再校验再执行——均有自动化测试（`tests/merchant-commands.test.ts`）。

### 阶段四：网络发布、运维与旧入口兼容（约 2–3 周）

- ~~CSV 导入预览/发布/撤回（F04）~~（2026-09-15 已完成）：`src/merchant-core/product-import.ts`（CSV 解析预览逐行回执 + 幂等键执行 + 部分成功 partially_failed）接命令闭环；撤回 `kiwi_merchant_prepare_products_withdraw`（listing 销售状态语义，逐项回执）。
- ~~注册与发现检查（F25）+ 域名接入向导（F03）~~（已完成：`src/merchant-core/network-checks.ts`——checkNetworkRegistration 结构化注册检查（catalog 可达 + 注册记录有效，失效可检测，fail-closed）；buildDomainOnboardingChecklist 检查单（公开投影分离自动判定 + DNS/TLS 人工项显式 manual））。
- ~~长任务 operation_id 异步机制~~（已完成）：`src/merchant-core/operations.ts`（queued/running/succeeded/partially_failed/failed；同幂等键返回同一 operation 不重复执行；与命令记录同一 state.sqlite）；`kiwi_merchant_get_operation` 查询工具（read scope）。
- ~~微信绑定状态与事件查看（F29）~~（已完成只读面）：`getWeixinStatus()`（脱敏不返回 bot_token；无事件存储明确「不可得」）；绑定/撤销操作留后续。
- ~~旧入口一致性~~（已核查 + 测试）：CLI/TUI 走 kernel/facade、MCP 走 merchant-core（包装同一 facade）——同一业务事实有测试锁定（stage4 一致性用例）；无大重构。
- ~~7×24 加固~~（部分完成）：告警事件接入 health（进程/商品源/注册失效/积压/磁盘/证书临期，结构化 code+severity）；持续备份落地（`src/merchant-runtime/backup.ts`：VACUUM INTO 事务一致快照 + manifest sha256 校验 + 轮换 + 恢复演练测试；RPO 口径诚实：RPO ≤ 备份周期，磋商 ledger 在备份集内；RPO=0 需同步持久化，留主备阶段——BUG-06）；jobs 调度器已接入 `runtime start`。主备 + fencing 只出设计（deploy/merchant-bundle/README），未引入分布式协调。
- 验收：见「五」后补的阶段四验收测试（`tests/merchant-buddy/stage4-acceptance.test.ts`）。

### 阶段五：完整验收与平台预览（约 1 周）

已完成（2026-09-15）：

- F01–F30 逐条复核：矩阵 30 条无缺无重（完整性测试锁定），covered/wired 条目证据文件存在性自动校验；启用/禁用两情形测试（merchant_mcp.enabled、auth_mode token/oauth 均覆盖）。
- V2 §10 的 11 个验收组逐组自动化（`tests/merchant-buddy/acceptance-groups.test.ts`）；需平台实测的部分显式登记 `PLATFORM_MANUAL`（全天接待月度可用性、主备 fencing RTO/RPO、MCP Apps 嵌入渲染），检查单见 `docs/merchant-buddy/workbuddy-e2e-checklist.md`。
- WorkBuddy 联调离线部分：OAuth 首次绑定/重连（重启后 refresh 仍有效）/撤权撤销端到端（`tests/merchant-buddy/oauth-e2e.test.ts`，workbuddy:// 与 127.0.0.1 两条回调路径）。
- 连接器包切 OAuth 模式：`integrations/hosts/workbuddy/kiwi-merchant-connector-oauth/`（无 auth_mode、无 token 占位）；token 包保留为过渡（source 改 `kiwi-merchant-token`，双 source 符合平台要求）；打包脚本 `--bundle token|oauth` 双包校验。

平台侧剩余（不可离线）：连接器/Buddy 应用提交审核、实机预览联调（按检查单留证据）、月度可用性与主备实测。

## 代码审查修复记录（2026-09-15 第一批：安全，2 P0 + 2 P1）

依据 `kiwi-merchant-buddy-v2-code-review.md`（基线 commit 0c3dcff）：

- **BUG-01（P0）OAuth 授权前无商家身份认证**：新增管理登录会话（`src/auth/merchant-sessions.ts`：scrypt 口令哈希落 `admin-credentials.json` 0600 不明文、12h 会话 HttpOnly/SameSite=Lax/生产 Secure、可撤销可过期）；`/oauth/authorize` 无会话 → 303 登录页（回跳原 URL），会话商家 ≠ 实例商家 → 403；挂起单绑定认证 principal_id（迁移老库补列，老挂起单不可再消费），授权码主体只能来自认证用户。账户来源：`kiwi merchant mcp admin-passwd`（口令只从 KIWI_MERCHANT_ADMIN_PASSWORD 环境变量读取）；单商家实例管理员 = 本实例 principal（profile.agent_id）。
- **BUG-02（P0）模型可自我批准**：`kiwi_merchant_execute_approved` / `kiwi_merchant_reject_candidate` 从 MCP 注册表移除（call 返回「未知工具」）；批准/拒绝唯一通道 = 管理确认页 + 一次性确认凭证（`oauth_confirmations` 表：绑定候选内容摘要 + 主体 + 商家 + 动作 + 10 分钟有效期，单次用途，事务内核销）；命令日志执行层逐项核对（候选摘要/主体/确认记录）。
- **BUG-03（P1）管理确认页授权与 CSRF**：`/admin/pending` 需登录会话；`/admin/decision` 需会话 + 有效确认凭证（缺/重复/过期/错配 403）；认证 principal 传入 execute/reject 并与候选主体核对；Bearer-only 旧表单路径废弃（浏览器表单不携带 Header 的问题由 cookie 会话解决）。
- **BUG-10（P1）Refresh Token 无独立过期**：`oauth_tokens` 加 `refresh_expires_at`（老库 ALTER 迁移 + 按 created_at+30d 回填）；轮换在同一事务内验证未撤销/未过期并核销（并发轮换只成功一次）。
- 测试：`tests/merchant-admin-security.test.ts`（8 条，逐条对应验收条件）+ `tests/merchant-oauth.test.ts` 增补（BUG-10 过期/重放/并发/迁移）。

## 代码审查修复记录（2026-09-15 第二/三批：运行链路 + 业务闭环，BUG-04~09 全量收官）

- **BUG-04（P1）runtime 子进程未用统一数据目录**：`src/merchant-runtime/services.ts`——A2A/MCP 子进程显式携带 `--data-dir <merchantDataDir>` 与确定 cwd；健康/备份与子进程读写同一数据根。
- **BUG-05（P1）商品源健康检查依赖陈旧探测文件**：`health.ts` 探测记录加 `checked_at`/`probed_at` 新鲜度判定（缺省 3 分钟 = 3 个健康轮询周期），过期/读取失败判 unhealthy；周期任务重刷探测。
- **BUG-06（P1）在线备份不一致**：SQLite 改 `VACUUM INTO` 事务一致快照（busy 短暂重试，失败 fail-closed）；快照后实际打开备份库跑 `PRAGMA integrity_check`，不通过删除该轮快照并抛错；RPO 口径诚实化为 RPO ≤ 备份周期（RPO=0 留主备阶段）。
- **BUG-07（P1）策略变更没有应用到运行时**：新增 `src/merchant-core/policy-runtime.ts`（`MerchantPolicyRuntime`）——写端 patch 与当前生效策略合并后用 `parseMerchantPolicy`（从 profile 校验逻辑抽取，与启动同一套规则）校验，原子写**完整生效策略**（tmp+rename 0600，含 version/updated_at），回执带版本/digest/applied_keys 进命令记录；读端（A2A 子进程）按文件 mtime 缓存跨进程读取，坏文件保留上一个良好策略并告警、legacy patch 文件忽略回退。A2A handler 的 `merchantPolicy` 接受 provider（每报价取运行中策略，`node.ts`→`merchant-handler.ts` 贯通）；执行器硬策略（私有底价）改按运行中策略校验（`ExecutorContext.currentPolicy`）。测试：`tests/merchant-policy-runtime.test.ts`（9 条：校验拒绝/原子写/版本 digest/重启延续/跨进程生效/坏文件 fail-safe/legacy 忽略/报价端到端）+ `tests/merchant-commands.test.ts` 增补（策略热更经真实运行时、硬策略跟随运行中策略）。
- **BUG-08（P1）"全量完成"与验收矩阵不一致**：矩阵条目加 `v2Scope`（committed/deferred）与 `reach`（mcpTools/mcpResources/adminPage/cli 到达路径）——committed 条目必须 wired/partial（承诺项不得 pending）、deferred 必须 pending（延后项不得宣称交付）、partial 必须附受限说明、wired 必须声明到达路径且 mcpTools 逐个与真实 MCP 注册表核对；committed 集合在测试中冻结（15 项 = 10 wired + 5 partial，其余 15 项显式延后），撤销 covered≥16/wired≥4 最低阈值冒充口径；F15 因管理确认页闭环（BUG-01/02/03）诚实升级 wired，F17 备注 BUG-07 热生效。测试：`tests/merchant-buddy/acceptance-matrix.test.ts` 重写。
- **BUG-09（P1）部署安装器生成不可运行实例**：`install.mjs` 现安装 Kiwi 运行应用（`--app-dir` 缺省仓库根；dist + package.json + 生产依赖复制到 `<prefix>/app`，缺一拒绝）、安装 merchant profile（`--profile` 必填，轻量校验 role: merchant + agent_id，落 `<prefix>/config/profile.yaml`）、放置实例凭据引用（`--credentials-env` → `<prefix>/.kiwi/credentials.env` 0600，值不读不记；缺省查 `~/.kiwi/credentials.env` 的 KIWI_MERCHANT_TOKEN，可显式跳过）、渲染服务单元统一 `--profile` + `--data-dir`（BUG-04），并新增 shopping-cli 独立托管单元（systemd Wants/After 依赖；launchd 无依赖排序由 KeepAlive 兜底，启动命令由 `--shopping-bin`/`--shopping-args` 决定——本仓库只锁版本范围不约定其 CLI 形态）；宣告完成前强制 preflight（真实执行安装产出的 `cli.js --version` 冒烟 + 服务单元渲染/profile/凭据核对），任一失败即安装失败。测试：`tests/deploy-merchant-bundle.test.ts` 扩到 9 条（缺 profile/非 merchant profile/裸 dist 缺依赖/凭据缺失拒绝 + 成功安装产物与冒烟）。

## 代码审查修复记录（2026-09-16 第三批：1 P0 + 5 P1 + 全量 P2 加固）

依据第三轮全量 code review（基线 main@04110a5 + 工作区版本范围改动）：

- **P0/P1-6 版本锁改为协议协商**：本地 shopping-cli 已是 3.2.5，原「3.x 上限 fail-closed」决策由真实能力协商取代——`probeCapabilities()` 先读 `/health` 版本，再以 catalog 凭据读 `/capabilities` 的 `protocol_versions`，含 `shopping.negotiation/0.1` 才判兼容；`kiwi merchant mcp serve` 启动时 verdict=incompatible 硬拒（exit CONFIG），indeterminate/unhealthy（不可达/协商不可用/健康未过）警示不阻塞；协商不可用（端点缺失/无权限/瞬时故障）回退 legacy 已验证线 `SHOPPING_CLI_LEGACY_VERIFIED`（2.x 实测线），3.x 无协商不可判定 fail-closed。probe 报告新增 `verdict`/`protocol_versions` 字段；versions.lock note 与部署 README 同步。
- **P1-1 create 白名单 + 钉归属**：`parseProductCreateInput`（types）prepare 层校验（sku/title 非空、price 有限非负、stock 非负整数、可选字段白名单、merchant_id 不一致直接拒绝），执行器重校验并强制 `merchant_id = ownerId`；`enforceFloor` 改收 unknown，非有限数值一律拒绝（原恒 false 比较让底价检查纸面化）。
- **P1-2 审批执行原子认领**：新增 `action_candidates.executing_at` 列（MIGRATION_7，status CHECK 无法 ALTER 故不加状态值）——`claimForExecution()` 条件更新 approved 且未认领，changes=1 才执行；双通道（管理页/内核）并发第二个调用得 not_approvable；崩溃残留（approved+executing_at）由 `supersedeExecuting()` 在 recoverPending 时标 superseded（外部副作用不可判定，绝不二次执行）。
- **P1-3 幂等键加固**：显式空/纯空白 key 拒绝（nullish 兜底不覆盖空串）；显式 key 与参数摘要绑定（`csv-<key>-<digest>` / `withdraw-<key>-<digest>`）——同 key 同内容真重放，同 key 不同内容不再静默返回旧 operation 谎报成功；import/withdraw 终态 failed → 输出 `ok:false` 走 supersede（审计不再把全部失败记成已执行）。
- **P1-4 底价 fail-closed**：A2A 定价 `floorMinorForSku()` 底价已配置但无法无损换算（如 85.005）→ 返回 null，该 SKU decline temporarily_unavailable；绝不落到 0（等于关闭底价护栏）。
- **P1-5 paused 静默失效**：上游 PATCH /products 无 paused/active（2.x/3.x 实测）——`parseProductPatch` 显式拒绝 `paused` 并引导到 `prepare_listing_change`；fake client 同步；buddy 配置 inventory-draft 提示词与工具列表修正。
- **P2 OAuth/auth**：refresh 过期迁移单事务 + 幂等回填 + NULL 按 fail-closed 拒绝；refresh grant 强制校验 client_id（RFC 6749 §6）；token/授权/管理面响应统一 `Cache-Control: no-store`；oauth 库启动清理过期行（挂起单/授权码/凭证/双过期 token/管理会话）；consumeCode 事务 + 条件更新（双进程防重放）；/oauth/register 限速（20/小时/IP）+ /admin/login 失败锁 10 次锁 5 分钟；畸形 body → 400 + stderr 日志（不再 500 静默）；确认页显示 client_id/注册时间（client_name 标注自报）；profile 注释缺省值改 oauth（与 cli 实现一致）；a2a_port 上界 65535；admin-credentials 重置强制收紧 0600；oauth.sqlite 先 0600 预建再打开（消除权限窗口）。
- **P2 MCP 工具层**：入参强转改 validation（paused 非布尔/source_protocol 非法枚举/stock 非数字/skus 非字符串数组一律拒绝，不再静默 coerce 反转意图）；listProducts 翻页聚合（原 limit=100 截断污染 CSV 存量判定）；operation running 超 30 分钟按中断标 failed 放行新任务；withTimeout 文案提示先查候选防重复提交；非业务异常收敛为统一文案（细节进 stderr）；get_product 校验商品归属（非本商家按未找到）；token 过渡模式 serve 启动警示写闭环死路（建议 OAuth 或内核 /approve）。
- **P2 core/A2A**：reject 状态守卫（仅 pending/approved 可拒，executed 不可改写审计）；`resolveServeDataDir` 复用 `agentDirName` 消毒（读端=写端，非 ASCII agent_id 策略热更恢复生效）；policy-runtime 文件删除显式告警（不再静默冻结）；rfq/offer/counter_offer 出站 advancePhase 返回值检查（被拒不落账不发出，防相位分裂）；数量 0/负/小数 schema_invalid 拒绝；确认凭证核销移到候选存在性/可执行性核对之后（候选已死不白烧凭证）；service 便捷包装注释澄清主体口径。
- **P2 runtime/备份**：MerchantJobs 同任务重入保护（与「串行执行」口径一致）；matchesProcess 失败区分「查无此进程」与「查询手段失败」（unknown 按存活认领，绝不双 spawn）；stop 按 pidfile 原始 command 认领旧进程（spec 变更后旧实例可停）；pidfile 写失败回滚并杀刚拉起的子进程；快照源库缺失 fail-closed + readOnly 打开（拒绝产出校验全绿的空库快照）；restoreBackup 路径越界守卫（`..`/绝对路径拒绝）；孤儿快照目录（无 manifest 且 >1h）启动清理；symlink 跳过项记入 manifest.skipped；成功备份原子写 latest-backup.json，health 新增 backup_stale 告警（备份停摆进通知通道）；capability-probe.json/health.json 原子写（防撕裂读假告警）；approveCandidate 同候选并发串行化。
- **P2 交付物/文档**：打包 URL 占位校验改 URL 解析整体锚定 hostname（防 example.com.evil.io 绕过）；install.json 计入已有安装检测（已装未启实例不可无确认重装）；凭据检查覆盖 profile `commerce.token_env`（SHOPPING_* 数据引擎凭据，只查存在性）；默认 `--shopping-args` 改 `api serve --port 8765`（3.x 无顶层 serve）；workbuddy README 工具数 7→15、buddy README token/OAuth 矛盾消除（模块 1/2/4 与 config 对齐）、联调清单 15 工具；两包 SKILL.md 补 prepare_products_import/prepare_products_withdraw/get_operation；buddy 配置 catalog 模式补 get_analytics（胶囊绑定修正）。
- **测试**：capability-probe 重写为协商语义（兼容/不兼容/legacy 回退/不可判定/不可达/落盘）；新增审批双通道并发认领回归 + refresh client_id 绑定回归；stage4 幂等/撤回断言按新语义更新；schema 版本断言 pin 到 MEMORY_SCHEMA_VERSION（7）；deploy 测试凭据 fixture 补数据引擎 token、二次安装断言按 install.json 语义更新。全量 vitest 2291 通过；lint/typecheck/build/contracts/vectors/harness/supply-chain/package 全绿。

**遗留（显式未做）**：A2A `needs_human_review` 退化判定仍缺「买家已出价等商家回应」维度（需 scanLedger 补最后发言方，属功能性扩展）；stock 上限 clamp 未做（cache 库存不作为报价数量上限，保持当前协议口径）；token 过渡模式写闭环的完整方案（最小确认页）待产品决策。



## 五、主要风险

1. WorkBuddy OAuth/MCP Apps 细节未确认，auth 层可能返工——阶段一前先平台 spike。
2. shopping-cli 接口能力未验证（Kiwi client 存在 ≠ 上游可用）——resolveReview、listing 语义、交期权威源逐接口核对实测版本。
3. 状态目录单 owner 写限制——主备需 fencing 租约，不提前引入分布式协调。
4. 范围蔓延——排除采购能力、代买家支付/下单/交接；「商家纯度」验收组卡 tools/list 和 Skill 内容。

## 六、目标文件结构（按 V2 §9，实施时以实际为准）

新增：`src/merchant-core/`（service/context/capabilities/commands/executor/operations/negotiation-adapters）、`src/mcp/merchant-resources.ts`、`src/auth/`、`src/merchant-admin/`、`src/merchant-runtime/`、`deploy/merchant-bundle/`、`tests/merchant-buddy/`、`docs/merchant-buddy/`、`integrations/hosts/workbuddy/merchant/`（OAuth 连接器包）。
修改：`merchant-tools.ts`、kernel/kernel-builder、`action-candidate.ts`、`write-gate.ts`、`intelligence/`、`merchant-presentations.ts`、`http/merchant-server.ts`、`a2a/node.ts`、`a2a/server/merchant-handler.ts`、`merchant-client.ts`、`product-init/publish/setup-public.ts`、`cli.ts`、`profile.ts`、`product-compat.ts`。
