# Kiwi Merchant Buddy V2 开发计划

**日期：** 2026-09-14
**依据：** `kiwi-merchant-buddy-v2.md`（设计基线 `main@267485d` / v0.8.0）
**关系：** V1 MVP（facade + 远程 MCP + token 连接器 + 审批恢复，见 `workbuddy-buddy-app-dev-plan.md`）已交付，本文档是 V2 全量版的实施计划，V1 成果作为地基演进，不重写。

## 一、与 V1 MVP 的 Delta

| V2 要求 | V1 现状 | 差距 |
|---|---|---|
| 标准远程 MCP adapter | 已有（`src/mcp/merchant-server.ts`，无状态 streamableHttp） | 需加 OAuth、按 scope 过滤 tools/list |
| 共享业务服务层 | `src/merchant/workbench-service.ts` | 演进为 `src/merchant-core/`（service/commands/executor/operations/negotiation-adapters） |
| 审批持久恢复 | `recoverPendingDrafts`（重启重建钩子，仅 draft） | 持久命令记录 + 固定执行器注册表，覆盖全部写工具 |
| 连接器包 | 已有（用户自填 token 模式） | 内置连接器须 OAuth；token 模式仅作市场过渡 |
| 工具命名/契约 | `merchant_*` 7 个 | 改为 `kiwi_merchant_*`；写操作拆 `prepare_*` / `execute_approved` / `reject_candidate` |
| 展示组件 | 七类 presentation 走内部 ui 事件 | 映射为 MCP Apps 资源 + 文本降级 |
| 7×24 运维、部署包、运行时管理 | 未做 | 全新（`src/merchant-runtime/`、`deploy/merchant-bundle/`） |
| F01–F30 其余（init/publish/setup-public/记忆/私密面板/微信等） | 未接入 | 主体工作量 |

## 二、P0 现存问题（不等阶段排期）

1. A2A handler 固定交期 `2026-08-20T18:00:00Z` 已过期，上线前必须改为权威交期或明确未知（V2 §8.5）。
2. `merchant listings/status/doctor` 仍为占位命令（F28，C 类），补齐或移除宣传。
3. `pauseListing` 语义选型：选定「销售状态」或「catalog listing 撤回」的准确语义，禁止库存写零伪装下架（V2 §8.3）。
4. 磋商摘要 terms 提取不全：覆盖 counter_offer.proposed_terms、conditional_offer、最终协议；needs_human_review 不简单等价 AWAITING_CLARIFICATION（V2 §8.7）。
5. 锁定 Kiwi / shopping-cli / WorkBuddy 实测版本组合；现有兼容检查 `>=2.0.0` 无上限不等于接口能力合格。

## 三、前置决策

1. OAuth 实现路径：确认 WorkBuddy 是 OAuth provider 还是需自建 authorization server，决定 `src/auth/merchant-oauth.ts` 形态。连接器文档本轮抓取超时，阶段一开工前重读确认 SDK/OAuth/MCP Apps 兼容性。
2. 工具命名采用 `kiwi_merchant_*` 新名，V1 的 `merchant_*` 废弃（连接器未发布，无兼容负担）。
3. 先单商家隔离实例；OAuth 用户映射为服务端 principal_id，用户参数不能选择任意 merchant_id，跨商家切换须重新校验授权归属。
4. 部署形态：阶段一单活 + 自动重启 + 持续备份；主备 + fencing 租约切换放阶段四；主动主动不做。

## 四、分阶段实施

### 阶段一：完整边界和配套实例（约 2–3 周）

- 冻结 F01–F30 为验收矩阵（`tests/merchant-buddy/`）。
- `src/auth/merchant-oauth.ts` + `merchant-authorization.ts`：OAuth、principal/merchant/scope 校验、租户越权拒绝；在 `MerchantMcpAuthVerifier` 接缝上叠加 OAuth verifier。
- 数据目录接线改造：显式 `merchantDataDir` / `principalDataDir` / `transportSessionId` 分别注入（V2 §5.1），修掉 HTTP adapter 按 sessionId 建 dataDir 的接线。
- `src/merchant-runtime/`（manager/health/jobs）：独立管理进程、分项健康检查、实例启停。
- `deploy/merchant-bundle/`：Kiwi + shopping-cli 配套实例、服务托管、持久卷、版本锁、安装器（显式确认新实例，不新建空库替代已有安装）。
- 能力探测：`merchant-client.ts` capability 探测；shopping-cli 故障 fail-closed 不产生报价。
- 验收：首次绑定到正确商家；关 WorkBuddy 后 A2A 持续服务；停止 A2A 后管理入口可重启。

### 阶段二：全量读取、分析、展示与记忆（约 2–3 周）

- `src/merchant-core/service.ts`：完整业务入口（商品/库存/两轨磋商/协议/intelligence/记忆/私密阈值），workbench-service 迁入或包装。
- `negotiation-adapters.ts`：统一列表带 `source_protocol`/`source_id`，详情保留各自状态名；人工处理按来源路由，A2A 人审不调 shopping-cli resolve-review。
- `src/mcp/merchant-resources.ts`：七类 presentation 映射 MCP Apps 资源 + 文本降级。
- 六个商家 Skill 适配新工具名与确认流程。
- 记忆治理（F22）与私密面板（F23）：远程场景补足人员授权与敏感展示边界；私密数值不进工具结果。
- 验收：金额/时间/UTC 口径一致；缺失数据显示「不可得」不填零；不暴露其他商家或人员资料。

### 阶段三：所有经营写入闭环（约 2–3 周）

- `src/merchant-core/commands.ts` / `executor.ts`：持久命令记录（tool、参数、前置版本、digest、授权主体、有效期、单次用途）+ 固定执行器注册表；恢复后再次校验再执行，不满足标 superseded/expired。
- 写链路：prepare → 具体预览 → 可信确认界面记录授权 → 执行器校验授权/版本/硬策略 → 幂等执行 → 回读 → 审计。模型自报「已批准」不作证据；宿主无可验证确认接口时用配套商家页面（`src/merchant-admin/`）。
- 覆盖 create/update/inventory/listing（F08 语义落地）、人工处理（F14 两轨路由）、策略变更热更新（F17）。
- 验收：展示≠执行；无真实确认无法扩大权限；重复提交只执行一次；过期或对象已变更拒绝旧授权。

### 阶段四：网络发布、运维与旧入口兼容（约 2–3 周）

- CSV 导入预览/发布/撤回（F04）、注册与发现检查（F25）、域名接入向导（F03）；公开投影与私有数据分离。
- 长任务 operation_id 异步机制（queued/running/succeeded/partially_failed/failed）；相同幂等键不重复导入/发布；部分成功逐项回执。
- 微信绑定状态与事件查看（F29）；CLI/TUI/HTTP-SSE 旧入口共用业务服务。
- 7×24 加固：告警（进程异常/商品源不可用/注册失效/积压/磁盘/证书）、持续备份、恢复演练；需要时单活主备 + fencing。
- 验收：月度可用性 ≥99.9%、RTO ≤5 分钟、已确认询价/协议 RPO=0；CLI/TUI/微信/Buddy 同一业务事实。

### 阶段五：完整验收与平台预览（约 1 周）

- 逐条执行 F01–F30 留证据（含启用/禁用两种情形）；V2 §10 的 11 个验收组逐组过；阻塞功能不得从清单删除换取「全量覆盖」。
- WorkBuddy OAuth 首次绑定、重连、权限撤销、MCP Apps、应用预览联调。
- 连接器包切 OAuth 模式重新打包提交审核。

**总计估算：9–13 周**；P0 修复（1–2 天）可与阶段一并行启动。

## 五、主要风险

1. WorkBuddy OAuth/MCP Apps 细节未确认，auth 层可能返工——阶段一前先平台 spike。
2. shopping-cli 接口能力未验证（Kiwi client 存在 ≠ 上游可用）——resolveReview、listing 语义、交期权威源逐接口核对实测版本。
3. 状态目录单 owner 写限制——主备需 fencing 租约，不提前引入分布式协调。
4. 范围蔓延——排除采购能力、代买家支付/下单/交接；「商家纯度」验收组卡 tools/list 和 Skill 内容。

## 六、目标文件结构（按 V2 §9，实施时以实际为准）

新增：`src/merchant-core/`（service/context/capabilities/commands/executor/operations/negotiation-adapters）、`src/mcp/merchant-resources.ts`、`src/auth/`、`src/merchant-admin/`、`src/merchant-runtime/`、`deploy/merchant-bundle/`、`tests/merchant-buddy/`、`docs/merchant-buddy/`、`integrations/hosts/workbuddy/merchant/`（OAuth 连接器包）。
修改：`merchant-tools.ts`、kernel/kernel-builder、`action-candidate.ts`、`write-gate.ts`、`intelligence/`、`merchant-presentations.ts`、`http/merchant-server.ts`、`a2a/node.ts`、`a2a/server/merchant-handler.ts`、`merchant-client.ts`、`product-init/publish/setup-public.ts`、`cli.ts`、`profile.ts`、`product-compat.ts`。
