# Kiwi Merchant Buddy V2 开发计划

**日期：** 2026-09-14
**依据：** `kiwi-merchant-buddy-v2.md`（设计基线 `main@267485d` / v0.8.0）
**关系：** V1 MVP（facade + 远程 MCP + token 连接器 + 审批恢复，见 `workbuddy-buddy-app-dev-plan.md`）已交付，本文档是 V2 全量版的实施计划，V1 成果作为地基演进，不重写。

## 一、与 V1 MVP 的 Delta

| V2 要求                                                        | V1 现状                                                     | 差距                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 标准远程 MCP adapter                                           | 已有（`src/mcp/merchant-server.ts`，无状态 streamableHttp） | 需加 OAuth、按 scope 过滤 tools/list                                                     |
| 共享业务服务层                                                 | `src/merchant/workbench-service.ts`                         | 演进为 `src/merchant-core/`（service/commands/executor/operations/negotiation-adapters） |
| 审批持久恢复                                                   | `recoverPendingDrafts`（重启重建钩子，仅 draft）            | 持久命令记录 + 固定执行器注册表，覆盖全部写工具                                          |
| 连接器包                                                       | 已有（用户自填 token 模式）                                 | 内置连接器须 OAuth；token 模式仅作市场过渡                                               |
| 工具命名/契约                                                  | `merchant_*` 7 个                                           | 改为 `kiwi_merchant_*`；写操作拆 `prepare_*` / `execute_approved` / `reject_candidate`   |
| 展示组件                                                       | 七类 presentation 走内部 ui 事件                            | 映射为 MCP Apps 资源 + 文本降级                                                          |
| 7×24 运维、部署包、运行时管理                                  | 未做                                                        | 全新（`src/merchant-runtime/`、`deploy/merchant-bundle/`）                               |
| F01–F30 其余（init/publish/setup-public/记忆/私密面板/微信等） | 未接入                                                      | 主体工作量                                                                               |

## 二、P0 现存问题（不等阶段排期）

1. ~~A2A handler 固定交期 `2026-08-20T18:00:00Z` 已过期~~（2026-09-14 已修复：`merchant_policy.delivery_lead_days` 权威交期动态计算，未配置则 terms 省略 delivery_before + clarification 提示与商家确认；`resolveDeliveryBefore` in `src/a2a/server/merchant-handler.ts`）。
2. ~~`merchant listings/status/doctor` 占位命令宣传~~（已移除帮助文案宣传；命令保留明确「尚未实现」报错，侵入性最小）。
3. ~~`pauseListing` 语义选型~~（已选定「销售状态」= catalog paused flag 语义，禁止库存写零伪装下架；上游 shopping-cli 2.x 无端点 → fail-closed 报「不可得」，能力探测标定 `listing_pause=false`；记录于 `merchant-client.ts` 注释）。
4. ~~磋商摘要 terms 提取不全~~（已覆盖 counter_offer.proposed_terms / conditional_offer.base_terms / 最终协议 agreed_terms；needs_human_review = AWAITING_CLARIFICATION 或「非终态且最后一条为买家入站 offer/counter_offer/clarification 等待商家回应」）。
5. ~~版本组合锁定~~（已验证上限：`SHOPPING_CLI_COMPAT` 改为 `>= 2.0.0 < 3.0.0`；`HttpMerchantClient.probeCapabilities()` 能力探测 + 结果落盘 `capability-probe.json`，`kiwi merchant mcp serve` 启动时执行，故障 fail-closed 警示不阻塞启动——报价路径本身已 fail-closed）。

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
- ~~写链路闭环~~（已完成）：prepare → 预览（前后对照）→ 确认通道（`kiwi_merchant_execute_approved` / `kiwi_merchant_reject_candidate`，merchant:write scope + 授权主体一致性校验；模型自报不作证据）→ 执行器重校验（前置版本重读重哈希/有效期/硬策略——私有底价执行器强制且不透气数值）→ 幂等执行（重放 not_approvable）→ 回读校验 → 审计（store 状态流转 + content hash）。配套商家确认页面最小骨架：`src/merchant-admin/pending-page.ts`（/admin/pending + /admin/decision，Bearer 强制，PRG 回跳）。
- ~~覆盖写面~~（已完成）：prepare_product_create / prepare_inventory_update / prepare_listing_change（F08 销售状态语义，能力缺失 fail-closed「不可得」）/ prepare_review_resolve（F14 两轨：shopping 走 resolver，A2A 报「不可得」绝不跨轨）/ prepare_policy_change（F17 热更新：执行器写覆盖层即时生效）。
- 阶段二遗留核查（已修复）：chat kernel presentation 接线的 principalId 口径不一致——`merchant-tools.ts` presentationContext 与 kernel 的 intelligence backend principal 校验键统一为 owner_id（此前 agent_id ≠ owner_id 时 digest/catalog 展示必然校验失败/读空）。
- 验收：展示≠执行；无真实确认无法扩大权限；重复提交只执行一次；过期或对象已变更拒绝旧授权；重启恢复后再校验再执行——均有自动化测试（`tests/merchant-commands.test.ts`）。

### 阶段四：网络发布、运维与旧入口兼容（约 2–3 周）

- ~~CSV 导入预览/发布/撤回（F04）~~（2026-09-15 已完成）：`src/merchant-core/product-import.ts`（CSV 解析预览逐行回执 + 幂等键执行 + 部分成功 partially_failed）接命令闭环；撤回 `kiwi_merchant_prepare_products_withdraw`（listing 销售状态语义，逐项回执）。
- ~~注册与发现检查（F25）+ 域名接入向导（F03）~~（已完成：`src/merchant-core/network-checks.ts`——checkNetworkRegistration 结构化注册检查（catalog 可达 + 注册记录有效，失效可检测，fail-closed）；buildDomainOnboardingChecklist 检查单（公开投影分离自动判定 + DNS/TLS 人工项显式 manual））。
- ~~长任务 operation_id 异步机制~~（已完成）：`src/merchant-core/operations.ts`（queued/running/succeeded/partially_failed/failed；同幂等键返回同一 operation 不重复执行；与命令记录同一 state.sqlite）；`kiwi_merchant_get_operation` 查询工具（read scope）。
- ~~微信绑定状态与事件查看（F29）~~（已完成只读面）：`getWeixinStatus()`（脱敏不返回 bot_token；无事件存储明确「不可得」）；绑定/撤销操作留后续。
- ~~旧入口一致性~~（已核查 + 测试）：CLI/TUI 走 kernel/facade、MCP 走 merchant-core（包装同一 facade）——同一业务事实有测试锁定（stage4 一致性用例）；无大重构。
- ~~7×24 加固~~（部分完成）：告警事件接入 health（进程/商品源/注册失效/积压/磁盘/证书临期，结构化 code+severity）；持续备份落地（`src/merchant-runtime/backup.ts`：快照 + manifest sha256 校验 + 轮换 + 恢复演练测试；RPO=0 口径：磋商 ledger 在备份集内）；jobs 调度器已接入 `runtime start`。主备 + fencing 只出设计（deploy/merchant-bundle/README），未引入分布式协调。
- 验收：见「五」后补的阶段四验收测试（`tests/merchant-buddy/stage4-acceptance.test.ts`）。

### 阶段五：完整验收与平台预览（约 1 周）

已完成（2026-09-15）：

- F01–F30 逐条复核：矩阵 30 条无缺无重（完整性测试锁定），covered/wired 条目证据文件存在性自动校验；启用/禁用两情形测试（merchant_mcp.enabled、auth_mode token/oauth 均覆盖）。
- V2 §10 的 11 个验收组逐组自动化（`tests/merchant-buddy/acceptance-groups.test.ts`）；需平台实测的部分显式登记 `PLATFORM_MANUAL`（全天接待月度可用性、主备 fencing RTO/RPO、MCP Apps 嵌入渲染），检查单见 `docs/merchant-buddy/workbuddy-e2e-checklist.md`。
- WorkBuddy 联调离线部分：OAuth 首次绑定/重连（重启后 refresh 仍有效）/撤权撤销端到端（`tests/merchant-buddy/oauth-e2e.test.ts`，workbuddy:// 与 127.0.0.1 两条回调路径）。
- 连接器包切 OAuth 模式：`integrations/hosts/workbuddy/kiwi-merchant-connector-oauth/`（无 auth_mode、无 token 占位）；token 包保留为过渡（source 改 `kiwi-merchant-token`，双 source 符合平台要求）；打包脚本 `--bundle token|oauth` 双包校验。

平台侧剩余（不可离线）：连接器/Buddy 应用提交审核、实机预览联调（按检查单留证据）、月度可用性与主备实测。

**总计估算：9–13 周**；P0 修复（1–2 天）可与阶段一并行启动。

## 五、主要风险

1. WorkBuddy OAuth/MCP Apps 细节未确认，auth 层可能返工——阶段一前先平台 spike。
2. shopping-cli 接口能力未验证（Kiwi client 存在 ≠ 上游可用）——resolveReview、listing 语义、交期权威源逐接口核对实测版本。
3. 状态目录单 owner 写限制——主备需 fencing 租约，不提前引入分布式协调。
4. 范围蔓延——排除采购能力、代买家支付/下单/交接；「商家纯度」验收组卡 tools/list 和 Skill 内容。

## 六、目标文件结构（按 V2 §9，实施时以实际为准）

新增：`src/merchant-core/`（service/context/capabilities/commands/executor/operations/negotiation-adapters）、`src/mcp/merchant-resources.ts`、`src/auth/`、`src/merchant-admin/`、`src/merchant-runtime/`、`deploy/merchant-bundle/`、`tests/merchant-buddy/`、`docs/merchant-buddy/`、`integrations/hosts/workbuddy/merchant/`（OAuth 连接器包）。
修改：`merchant-tools.ts`、kernel/kernel-builder、`action-candidate.ts`、`write-gate.ts`、`intelligence/`、`merchant-presentations.ts`、`http/merchant-server.ts`、`a2a/node.ts`、`a2a/server/merchant-handler.ts`、`merchant-client.ts`、`product-init/publish/setup-public.ts`、`cli.ts`、`profile.ts`、`product-compat.ts`。
