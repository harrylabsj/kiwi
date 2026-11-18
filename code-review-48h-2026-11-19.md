# Kiwi 48 小时增量代码审查报告

审查日期：2026-11-19。审查范围：`2551ca3b..f7e84df6`（2026-11-17 08:12 → 2026-11-19 06:14，共 49 个提交）；src 增量基线 `94390ce9..f7e84df6`（窗口内最早两个提交均为 workbuddy 测试修复，无 src 变更）。当前提交：Kiwi `f7e84df6`。

本报告仅覆盖 48 小时增量，不表示全库无 bug 或生产上线通过。此前全库裁定见 [full-codebase-code-review-2026-10-07.md](./full-codebase-code-review-2026-10-07.md)（114 项）。

## 审查范围与方法

- **规模**：158 个文件变更、+34,404/−218 行；其中 **src 84 个文件、+20,056/−177 行**，新增 src 文件 56 个。
- **方法**：按 5 个功能流域并行深度审查（投递链路 / 经营调度与所有权栅栏 / learning 评测 / 客户记忆与治理 / workbench 与管理 API 面），每个流域覆盖对应测试文件以区分"有意设计"与"缺陷"；全部 P0/P1 发现由主审逐条重读源码复核后才列入。
- **静态门禁**：`tsc --noEmit` ✅ 通过；`eslint --max-warnings=0` ✅ 通过。

## 当前结论

共报告 **30 项**：P0 ×2、P1 ×7、P2 ×21。另有一批经核验后确认无问题的重点面（见"已核验无问题"节）。

| 状态 | 数量 | 说明 |
|---|---:|---|
| P0（安全/跨主体泄露级） | 2 | 客户自助身份层"自发自验"，主体绑定不变量失效；当前服务层无 HTTP 接线，属 M3 接线前硬前提 |
| P1（生产大概率触发的真实缺陷） | 7 | 集中在投递 dispatcher 租约/幂等/收件人接线、learning 不确定尝试恢复出路、保留期死代码 |
| P2（边界缺陷/设计隐患） | 21 | 竞态、无退避重试、保留策略缺失、fail-closed 可用性等 |

主要风险集中在三处：①客户自助身份层（绑定/授权是自发自验的）；②投递链路的租约与收件人接线缺口；③learning 不确定尝试在默认部署下无恢复出路。

---

## P0（2 项）

### P0-1 customer:self 可自发自验任意主体的数据授权

- **位置**：`src/merchant-core/customer-memory/grants.ts:113-189`（createGrantRequest / confirmGrant）
- **证据**：`createGrantRequest` 接受 `customer:self` 能力（L118-121）+ 任意 ACTIVE `subject_id`，并把一次性确认短语与 `confirmation_ref` **直接返回给同一调用方**（L179-189）；`confirmGrant`（L196-267）只需 `customer:self` + 短语/引用任一匹配即创建 ACTIVE grant，全程不校验 actor 与 subject 的绑定关系。短语摘要只证明"谁持有短语"，而短语正是发给调用方本人的。
- **失败场景**：客户 A（任一持有 `customer:self` 的会话）对主体 B 调 `createGrantRequest` → 拿到短语 → `confirmGrant` → 获得 B 作用域的 `customer_memory`/`history_recall` grant；`HistorySearchService.search`（history.ts:162-188）校验 merchant+能力+grant 但不校验主体绑定，A 即可读取 B 的历史摘要。测试 `tests/customer-memory.test.ts:720-739`（B04）将该跨主体确认流程固化为 fixture，即该流程被编码为"预期行为"而非被拦截。
- **可达性**：reception 工具面当前安全（`customerContext` 服务端经 `contextFor(merchantId, identity)` 派生，工具参数不含主体）；这些服务 API 尚无 HTTP 接线——但它们是文档化的 M3 客户自助合同，且是 `assertActorOwnsSubject` 成立的唯一根基。
- **修复建议**：`createGrantRequest` 与 `confirmGrant` 两条腿都强制主体绑定（或仅允许 `memory:write` 商家侧创建 + 短语带外送达已验证的客户联系方式）。

### P0-2 主体绑定挑战自发自验，任意会话可绑定任意主体

- **位置**：`src/merchant-core/customer-memory/identity.ts:126-200`（linkChallenge / linkConfirm）
- **证据**：`linkChallenge` 只要求 `customer:self` + 目标主体存在且 ACTIVE（L135-145），随后把 `proof` 直接 return 给调用方（L172）；`linkConfirm` 校验仅 `row.actor_id === actor.actor_id`（同一 actor）、session 匹配与 proof 摘要——同一会话既是挑战签发者又是证明消费者。文件头注释（"昵称/电话/IP/文本相似度不能建立身份"）表明绑定本应是身份证明，现实现证明不了任何事。
- **失败场景**：客户 A 调 `linkChallenge({ target_subject_id: subjectB })` → 拿到 proof → `linkConfirm` → `currentSubjectForActor` 返回 B；`assertActorOwnsSubject`（memory.ts:169-181）对 A 在 B 的记忆上全部放行：A 可 `confirmMemory`/`correctMemory` B 的记录，配合 P0-1 的 grant 还可经 reception recall/search 工具接收 B 的记忆与历史。
- **可达性**：同 P0-1（服务层，无 HTTP 接线；reception 工具面安全）；`tests/customer-memory.test.ts:99-113` 与 `tests/reception-customer-tools.test.ts:110-115` 将自绑定任意主体固化为预期流程。
- **修复建议**：挑战改为两方流程——由 `memory:write`（商家侧）签发、proof 经带外渠道送达已验证客户联系方式；或 `linkConfirm` 前在服务端验证主体控制权。

---

## P1（7 项）

### P1-1 requestDeletion 漏主体绑定校验，可跨客户删除

- **位置**：`src/merchant-core/customer-memory/memory.ts:455-462`
- **证据**：`confirmMemory`（L356）与 `correctMemory`（L406）都调用 `assertActorOwnsSubject`，`requestDeletion` 只做 `requireActor(input.actor, merchantId, ["customer:self", "memory:write"])`；随后按 `erase_scope_id` 单独执行：删除证据行（L476-480）、`customer_memories` 置 deleted 并清空 key/value_ref（L482-490）、删除 history_fts/history_index（L492-499），并经 source-governance 封存 scope、撤销其**全部** ACTIVE grant（source-governance.ts:510-542）。
- **失败场景**：绑定客户 A 凭 B 的 `erase_scope_id`（可从自身 grant 记录 `listBySubject` 获得）销毁 B 在该商家内的全部记忆、证据、历史索引与授权。1b1e245e（"客户自助写路径强制主体绑定"）恰好漏掉删除路径；删除测试（customer-memory.test.ts:488）只用本人 scope，未覆盖。
- **修复建议**：解析 scope 后先验证 actor 绑定于（或为管理员）该 scope 涉及的主体，再登记删除作业。

### P1-2 claimDelivery 无租约前置条件，发送可被双重领取与重复发送

- **位置**：`src/merchant-core/customer-delivery/dispatcher.ts:82-105`；`dispatcher-loop.ts:57-61`；`repository.ts:227`
- **证据**：`claimDelivery` 只检查 `status !== "PENDING"`、`valid_until`、`findBlocking`（排除自身），随后**无条件覆盖** `lease_owner: input.worker_id` 并落库——不检查是否已有未过期租约（对比 `completeDelivery` 的 `requireLease`，不对称证实这是遗漏）。`repository.listDue` 会列出租约已过期的记录（即使原发送仍在途）；`dispatcher-loop` 的 `setInterval` 无重入保护；claim 路径未包 `store.inTransaction`（仅测试如此），跨进程同样无保护。
- **失败场景**：适配器发送挂起超过 120s 租约（见 P1-3）或两个 workbench 进程跑同一 DB 的 loop：双方 claim 同一 PENDING 记录并都发送——SMTP/weixin 等非幂等渠道客户收到重复消息；败者的回执经 `requireLease`/`invalid_transition` 被丢弃。
- **修复建议**：`claimDelivery` 在 `lease_owner` 存在且 `lease_expires_at > now`（非本 worker）时拒绝；loop 增加重入互斥。

### P1-3 SMTP 适配器读响应无 deadline，send() 可永久挂起

- **位置**：`src/merchant-core/customer-delivery/smtp-adapter.ts:45-67,82-100,142`
- **证据**：`readResponse`（L45-62）仅由 data/error/close 结算；`command`（L64-67）无计时。唯一的 connect timeout（`socket.once("timeout", ...)`，L82-96）被连接 promise 消费——连接后 timeout 事件没有拒绝或销毁 socket 的监听；STARTTLS 升级后的 TLSSocket 完全没有 timeout（L100 附近）；`send` 只解构 `{ delivery }`，忽略 `dispatchDelivery` 传入的 `timeout_ms`（channel.ts:82-86），下游也没有任何 deadline。
- **失败场景**：SMTP 服务器接受连接后在 EHLO/MAIL FROM/DATA 停止响应：`send()` 永不结算，该 tick 永久阻塞、租约 120s 过期后后续每 15s tick 重新 claim 并重发同一邮件（叠加 P1-2 → 每个租约周期一封重复邮件），每次尝试泄漏一个 socket。
- **修复建议**：每条 `readResponse` 加 per-command deadline（如 `Promise.race` + `options.timeout_ms`），超时销毁 socket 并返回 `unknown`。

### P1-4 授权/频控只在 prepare 时检查，发送时不复核

- **位置**：`src/merchant-core/customer-delivery/dispatcher.ts:82-105`；`channel.ts:63-101`；对照 `types.ts:18-22`、`binding.ts:153`
- **证据**：claim/dispatch 从不重读 binding 或 subscription——`claimDelivery` 只验证状态/有效期/流占用，`dispatchDelivery` 直接 `adapter.send`。文档合同是发送时门控：`types.ts:18-22`（"发送前必须同时具备：…目的/频率授权、退订入口…"）、`binding.ts:153`（"退订：epoch 递增；退订后发送门拒绝（C12）"）。无调用方补偿：`prepareDelivery` 尚无生产调用方，loop 的 `adapterFor`（workbench-server.ts:271）只看渠道。频控同理：`sent_today` 在 prepare 时从已持久化回执采样，多条已排队 PENDING 记录各自看到 `sent_today=0`，可全部发出突破 `max_per_day`。
- **失败场景**：通知冻结 `valid_until` +1h；客户在 +5m 经 `DeliveryConsentRepository.unsubscribe` 退订；dispatcher 在 +10m 照发——明确 opted-out 的客户收到商业消息（合规违约），排队批量可突破频控。
- **修复建议**：在 claim 事务内重载 binding/subscription/grants 并重跑授权检查（撤销/退订/过期/max_per_day）后再允许发送。

### P1-5 收件人接线不消费 address_ref：SMTP 收件人是固定 env 地址，weixin 回退到机器人主人

- **位置**：`src/merchant/workbench-server.ts:256-266`；`src/merchant-core/customer-delivery/weixin-adapter.ts:49`
- **证据**：生产 loop 构造 `createSmtpChannelAdapter({ ..., to: String(process.env.KIWI_DELIVERY_EMAIL_TO ?? "").trim() })`——不论 `binding.address_ref`，所有投递发往同一地址；weixin 适配器 `to = options.recipient_user_id ?? options.credentials.ilink_user_id`（默认机器人主人自己）。没有任何适配器消费授权绑定的 `address_ref`，即整个 binding/consent 链条不控制实际传输目标。
- **失败场景**：开关与 env 就绪后，所有绑定的客户级 payload 投递到同一邮箱（跨收件人披露）；或 weixin 通知落到商家自己的账号却标记 SENT。
- **可达性**：loop 仅在 `customer_delivery_enabled` + `KIWI_DELIVERY_DISPATCHER=1` 下启动（f7e84df6"明确授权后启用"）。
- **修复建议**：在 `adapterFor` 内按 delivery 从 binding 解析收件人后再放开超测试模式的使用。

### P1-6 派发不确定的模型调用在默认部署下永久卡死候选评测

- **位置**：`src/merchant-core/learning/evaluation.ts:569-576`（catch 路径）；`src/merchant-core/learning/service.ts:1188-1196`；`src/merchant-core/learning/repository.ts:313-315`
- **证据**：评测 runner 设 `timeoutMs: 90_000`（real-evaluation-runner.ts:142）+ `requireCompleteModelRun: true`；超时或模型中途出错时 agent runtime 抛 `evaluation_runtime_outcome_unknown`（agent-runtime.ts:1501-1502），catch 路径在 `input.setAttempt !== undefined` 时直接 throw `evaluation_attempt_uncertain`，**不落任何持久状态**——`learning_evaluation_config.pending_attempt` 停在 `phase:"dispatched"`（注释明示"留待人工核对"）。该 marker 的终态写入方只有：本地 receipt（成功返回才写）或 `resolvePendingEvaluation`——后者对无 receipt 的 dispatched marker 要求 `this.recoveryVerifier !== undefined`（service.ts:1191，否则抛 `evaluation_recovery_unavailable`），而 verifier 对任何非 200 返回 `unknown`（recovery-gateway.ts:96）。`checkEvaluationConfig`（repository.ts:313-315）此后以 `evaluation_attempt_uncertain` 阻塞所有重跑；`pending_attempt` 无 TTL/sweeper（grep 确认无其他清除路径）。
- **失败场景**：120 次回放中任一场景一次 90s 超时或瞬时 429，即把候选永久楔死在 `EVALUATING`：`evaluateCandidate` 永远抛 `evaluation_attempt_uncertain`；`resolvePendingEvaluation` 仅在配置 `KIWI_EVAL_RECOVERY_GATEWAY_URL` **且** transport adapter 记录过该 dispatch_id 时才可能成功。提交语"In Recover uncertain learning evaluation attempts"在默认部署不可满足——超时场景永远到不了终态。
- **修复建议**：在 runner 无/未及流证据时落 terminal `failed`/`interrupted` run_status（或给 `pending_attempt` 加 TTL，到期标记 `interrupted` 并以新 dispatch_id 重派）；把 gateway 核对保留给真正不确定的完成态。
- **关联**：`service.ts:1210`——EVALUATING 期间 `reviseCandidate` 允许改候选（只锁 APPROVED/STALE/EXPIRED），revision 变化后 recovery 永远抛 `evaluation_attempt_changed`，marker 永久搁浅并阻塞同 artifact 重评（P2-6）。

### P1-7 保留期清算是死代码：expireDue 无任何生产调用方

- **位置**：`src/merchant-core/customer-memory/memory.ts:509-557`；`src/merchant-core/context-governance/data-use-grant.ts:272-283`
- **证据**：`CustomerMemoryService.expireDue()`（清除 `purge_at` 已到的 key/value_ref/source_refs 及 history_index/history_fts 行）与 `DataUseGrantStore.expireDue()` 在 src 内零生产调用（grep 仅测试及无关同名方法）；`workbench-server.ts`、`merchant-runtime-assembly.ts`、`a2a/node.ts`、`cloud/bootstrap.ts` 均未调度；`history_cursors`、已消费的 `binding_challenges`、`grant_requests` 行也无清理。
- **失败场景**：文档化保留不变量——"purge_at = min(确认/采集+分类期限, 采集+90 天, grant 到期)，读取不延长"、"历史索引超期删除"——只存在于未执行代码中。客户记忆 `value_ref`、历史全文、证据行、游标无界累积且静止留存远超承诺的 90 天（读路径按时间过滤，查询不可见但从未删除）：隐私保留违约 + 无界增长。
- **修复建议**：将 memory/grants 的 `expireDue()` 接入 workbench/ownership 调度（与 OperationsScheduler 并列），或按相同 fenced-write 纪律周期 tick 清理。

---

## P2（21 项）

### 详细（8 项）

**P2-1 scheduler 失败错误串含控制字符时，failClaimedTask 校验先抛、retryTask 被跳过**
`src/merchant-core/operations-jobs/scheduler.ts:251-266`；`service.ts:226-229,1173`。`error_code: err.message.slice(0,100)` 直传 `failClaimedTask`，其首句 `text(input.error_code, "error_code", 128)` 拒绝含 `\u0000-\u001f\u007f` 或空值——多行（model SDK 报文内嵌）错误消息使校验在任何 DB 写之前抛 `OperationsJobsError("validation")`；scheduler 把 fail+retry 包在同一 `try { } catch { /* 吞掉 */ }`，`retryTask` 因此不执行：任务滞留 RUNNING（120s 租约），下一 tick sweepRuleTasks 标终态 UNKNOWN 并保守结算预算；设计好的 FAILED→15s 退避→重领路径永不触发，且 trigger_key 去重阻止重新入队，本次运行落入人工核对。修复：先清洗（`message.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,100) || "executor_error"`），并把 `retryTask` 放独立 try。

**P2-2 saveReceipt 位于 try/catch 之外：claim 丢失会丢弃本地已知结果**
`src/merchant-core/learning/evaluation.ts:595`。`input.saveReceipt?.(marker, outcome)` 在守护 `runner(...)` 的 try/catch 之后；`saveReceipt`（service.ts:1088-1103）开头在自己的事务里 `assertClaim()`——评测 claim 过期（心跳失败/事件循环停顿 >300s）时异常裸抛出 `runCandidateEvaluation`（非 `evaluation_attempt_uncertain` 包装），marker 停在 dispatched、receipt 未写，尽管 outcome 已在手。修复：包进同一 try/catch 归类为 uncertain，成功时结果已在 receipt 中。

**P2-3 云端 facade 少传 recoveryWriteGuard，评测恢复写绕过单写者栅栏**
`src/cloud/bootstrap.ts:804-809`；对照 `src/mcp/merchant-runtime-assembly.ts:664`、`learning/service.ts:321`、`http/merchant-management/api.ts:1600-1608`。bootstrap 的 `openMerchantOperationsFacade` 未传 `recoveryWriteGuard`，`LearningService` 默认 identity；管理 API 的 recovery 路由刻意不包 `writeGoverned`、专门 catch `GovernanceRuntimeError`/`InstanceOwnershipError`——即栅栏应由内部 guard 提供。ownership 丢失（心跳失败/第二进程接管）后，其余 learning 写全部被栅栏拦截，唯独 `POST /merchant/api/v1/learning/evaluations/:id/recovery` 仍无栅栏写 learning 账本——正是 e610b3bc（"调度写路径纳入所有权栅栏"）要关闭的双写者竞态。修复：对照 assembly 传 `recoveryWriteGuard: (work) => governanceRuntime!.writeUnderOwnership(work)`。

**P2-4 managementDb 无 busy_timeout/WAL，并发写者下所有权/调度写立即失败**
`src/cloud/bootstrap.ts:780`。裸 `new DatabaseSync(path.join(config.dataDir, "state.sqlite"))`，文件内无任何 PRAGMA；而 merchant-runtime 路径设 `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000`（src/agent/agent-db.ts:95-97），其他 store 2000-5000ms。node:sqlite 默认 busy_timeout=0：两连接同文件时第二个 `BEGIN IMMEDIATE` 约 1ms 即失败 "database is locked"（实测 Node v22）。transaction.ts:30 记载的"并发写者等 busy_timeout 而不是直接 SQLITE_BUSY"只对设置了该值的连接成立。任一并发写者——readiness 探针（bootstrap.ts:357 自开连接做 BEGIN IMMEDIATE）、备份作业、设计 §1.3 允许的第二进程 legacy reception 写——都会让 owner 的 `evaluateDue`/`claimDue`/commit/renew 立即失败：tick 中断仅记日志；commit 时锁竞争丢弃已完成的模型结果并重跑（同预算双倍成本）；持续争用跨 60s lease 翻 `ownership_lost` 停用全部新功能直至重启。修复：打开后执行 `PRAGMA busy_timeout = 5000`（及 WAL）。

**P2-5 并发启动迁移竞态：版本读在事务外，输家进程启动崩溃**
`src/merchant-core/ops/schema.ts:551-561`；`cloud/bootstrap.ts:804`、`mcp/merchant-runtime-assembly.ts:662` 裸调用。`SELECT MAX(version)` 在事务外；之后每个版本用裸 deferred `BEGIN` 应用，`migrateMerchantOpsSchema` 事务内不复读版本，DDL 非 `IF NOT EXISTS`。两进程同时启动（首次部署/重叠重启）读同一 `current`；赢家提交后，输家 `CREATE TABLE` 报 "table already exists"（或因 P2-4 无 busy_timeout 立即 database is locked）→ 裸抛穿 bootstrap/assembly：整个进程启动失败，而非设计 §18.2 的"降级 features-off、第二进程继续服务 reception"。GovernanceRuntime.start 只重试 lock 类错误（runtime.ts:100-121），"table already exists" 不在其中。修复：`BEGIN IMMEDIATE` 内复读 `MAX(version)`（参照 `migrateModuleSchema` 的 ledger 做法），或包住 facade-open 迁移失败降级 features-off。

**P2-6 reviseCandidate 可使 uncertain marker 永久搁浅并永久阻塞同 key 重评**
`src/merchant-core/learning/service.ts:1210`（recovery 校验）与 `service.ts:892`（reviseCandidate）。`resolvePendingEvaluation` 要求 `candidate.state === "EVALUATING" && candidate.revision === binding.candidate_revision`，但 `reviseCandidate` 只锁 APPROVED/STALE/EXPIRED——EVALUATING 可改且不检查 pending uncertain marker；评测 key 不含 revision（`contentDigest({ merchantId, candidateId, artifact, suite })`，service.ts:1054），同 steps 的 revision+1 复现同 artifact_hash 同 key。marker 只能被成功的 resolve 清除。场景：模型调用不确定 → 操作员改候选（同 steps）→ recovery 永远 `evaluation_attempt_changed` → `checkEvaluationConfig` 永久阻塞该 (candidate, artifact, suite) key。修复：revise/stale 时对旧评测 key 清 marker（记 not_executed 式核对），或把 revision 纳入搁浅 marker 的 key。

**P2-7 weixin 适配器 catch-all 归为 UNKNOWN 且无任何核对路径，一条瞬态错误永久冻结该流**
`src/merchant-core/customer-delivery/weixin-adapter.ts:61-63`。`catch { return { outcome: "unknown" } }`——`sender.sendMessage` 抛错既可能是超时也可能是确定性 iLink 拒绝（assertOk 失败、收件人无效）；UNKNOWN 经 `findBlocking` 永久阻塞 stream，而 `retryUnknownDelivery`（dispatcher.ts:195-223）在 src 零调用方——没有任何 job 或运营路径解开 UNKNOWN。场景：iLink 一次 4xx（如收件人拉黑 bot）→ 该 binding+purpose 流永久 UNKNOWN → 后续通知全部 PENDING 直到静默过 `valid_until`（listDue 过滤掉）——消息丢失，每 tick 仅 stderr 一行。修复：分类 sender 错误（确定性拒绝归 not_sent），启用 loop 前接通 UNKNOWN 核对/验证路径。

**P2-8 模型提供的 candidate_refs 未校验即原样渲染进买家可见回复**
`src/a2a/reception/agent-runtime.ts:419-433`；`src/a2a/reception/publish.ts:294-301`；`question-spec.ts:124-137`。`ask_registered_question` 的 candidate_refs 仅做数量截断（`filter(typeof==="string").slice(0,8)`），无长度/字符集/候选真实性校验；`publishResponsePlan` 经 `renderRegistered` → `renderTemplate` 原样 `join("、")` 进 `{candidates}`/`{mentioned}` 占位符（测试确认逐字渲染：`您提到了：SKU-1、SKU-2。`）。买家文本是 prompt 输入（"untrusted data"），prompt 注入可让模型发出任意字符串冒充商家官方公开回复——与发布设计"不接收模型自由撰写问句"相悖。（既有 `ask_clarification.candidates` 在基线已有同形通道，属同类扩展，故 P2。）修复：按引擎真实候选校验或限长/限字符集。

### 简表（13 项）

| # | 位置 | 问题 | 要点 |
|---|---|---|---|
| 1 | customer-delivery/channel.ts:90-101 | not_sent 分支绕过租约校验 | `lease_owner: undefined` 直接 save（repository.save 仅按 outbox_id UPDATE）；租约过期期间另一 worker 已 claim 时，该无条件下发把记录重置 PENDING，对方 completeDelivery 抛 lease_lost、accepted 回执丢失、消息重发 |
| 2 | customer-delivery/channel.ts:90-100 + dispatcher-loop.ts:81-97 | not_sent 无退避无上限 | not_sent 重置 PENDING 下轮再发，无 attempt 计数/退避列/终态；`blocked_reason` 只写不读；email-adapter.ts:80-82 把 422 坏地址、429 限速等全部归 not_sent——毒消息每 15s 重试整个 valid_until 窗口，打爆 provider |
| 3 | customer-delivery/gate.ts:181 vs a2a/reception/reply-outbox.ts:72-73 | 两侧 stream_key 命名空间结构性不相交 | delivery `${merchant}:${channel}:${binding_id}:${purpose}` vs outbox `${merchant}:a2a:${identity}:${contextId}`——M6-5 "接待回复与经营通知共用同一流门互斥"实际恒不生效；delivery key 嵌 purpose 使同收件人多目的并行。当前潜伏（生产 a2a/node.ts:818 构造 outbox 无 gate） |
| 4 | a2a/reception/reply-outbox.ts:98-109,135-143 | unknown 占用可被绕过 | `record()` 只对新记录的 unknown 进 gate；`markStatus(id,"unknown")` 对 dispatched 记录不持有；构造/加载不为持久 unknown 记录重进 gate，24h lease 过期后记录仍 unknown——重启后该流照常接新发送，违反"UNKNOWN 未核对前保持占用" |
| 5 | customer-delivery/consent-repository.ts:158-165,252-265 | epoch 保护的 UPDATE 不检查 changes | 读-算-写跨两条语句无事务；竞态下 UPDATE 匹配 0 行仍返回按过期读算出的对象（如 epoch+1）冒充成功（对比 repository.ts:216-218 有检查）。因守卫列仅由这些操作变更、prepare 门复核撤销，终态恰好仍正确 |
| 6 | learning/service.ts:1056,1062-1118 | 夹具漂移不检测 + evaluateCandidate 绕过栅栏（潜伏） | config_digest 只 pin suite 对象不含 fixtures；fixtures 无版本字段、suite/scenarios 仅类型级 readonly 未 Object.freeze——"冻结 pilot 商品夹具"是约定非强制；evaluateCandidate 全链仅 app 级 claim 不走 writeUnderOwnership（当前无 HTTP 之外入口） |
| 7 | learning/repository.ts:886-908 | learning 账本无保留策略 | learning_events/rejections/command_idempotency 只增不清理，`releaseEvaluationClaim` 故意永久保留 `command:` claim 行（SET expires_at=0）；无 prune 查询，长期库无界膨胀（对比 RFQ 的 pruneExpiredIdempotency） |
| 8 | customer-memory/reception-provider.ts:277 vs 251 | 直写 propose 用错 scope | `canPropose` 门在 `memory_scope_id`，`propose` 落 `resource_scope_id`（history scope）——与 reception-writer（用 memory_scope_id）不一致；fail-closed（grant_unavailable）或错 scope 归档，非泄露 |
| 9 | customer-memory/reception-provider.ts:56 | allowWrites 默认 true | 直写路径用全能力 systemActor、不问 `memory_enabled`、不走过 ownership fence；当前生产构造显式 false，但任何未来接线漏传选项即静默恢复无栅栏写路径 |
| 10 | customer-memory/grants.ts:247-255 + memory.ts:282-287,363-368 | confirmGrant 可对 SEALED scope 建 ACTIVE grant | `ON CONFLICT DO NOTHING` 不查 scope 状态；proposeMemory/confirmMemory 只查 grant 存活不查 data_scopes.state（对比 registerSourceRef 拒绝 SEALED）。删除封存后确认旧请求仍能建 grant；生产 writer 路径安全（reception-writer 查 scope.state） |
| 11 | merchant/workbench-server.ts:59-69,297-308,352-354 | 非 loopback --host 无 --public-url 时所有浏览器写 403 | `allowedOrigins()` 对 192.168.x 等产生空列表；浏览器同源 POST 必带 Origin，`assertWriteGuards` 全拒——fail-closed 无安全洞但 UI 静默不可用（测试只用 loopback）。修复：无 publicOrigin 时允许 host:port 派生 origin |
| 12 | customer-delivery/smtp-adapter.ts:142 | 随机 Message-ID，违反适配器幂等合同 | channel.ts:37-44 要求同一 delivery_id 作渠道幂等键、不得换 ID 重发；Resend/webhook 遵守，SMTP 每次 `randomUUID()`。at-least-once 重发（DATA 250 后崩溃、或 accepted 后 lease_lost）产生不可关联重复邮件，下游去重/审计原理上不可能。修复：`<${delivery_id}@kiwi.local>` 派生 |
| 13 | customer-delivery/gate.ts / dispatcher 全链 | UNKNOWN 语义依赖尚不存在的基础设施 | gate.ts 纯判定 + UNKNOWN 阻塞的设计，依赖"核对未执行"的验证路径；当前 `retryUnknownDelivery` 无调用方、无对账作业（与 P2-7 同根因的架构面观察） |

---

## 已核验无问题的重点面

以下经审查确认成立（核验过程含对照测试与接线），不计入问题：

- **所有权栅栏**：`evaluateDue`/`claimDue`/`commitInternalResult` 在两种装配（workbench `governance.write`、bootstrap `writeUnderOwnership`）内均走 `writeUnderOwnership`；HTTP 规则变更走 `writeGoverned`；scheduler 的 `failClaimedTask`/`retryTask` 由任务级 `worker_id`+`fencing_token` CAS 覆盖；`acquire`/`renew`/`release` 为 fenced CAS，运行时绝不采纳他人 token。未发现无守卫的 stale-owner 写路径。
- **双派发防护**：claimDue 是 `BEGIN IMMEDIATE` 内的 CAS；claimed 任务为 RUNNING 不可再选；接入 BackgroundBudgetStore 后 concurrency=1 预留门阻止在途 run 的二次准入——重叠 interval tick（无重入守卫存在）不能双跑任务。
- **预算**：reserve/settle/release 逐 run 一致；被吞的 `settleRun` 失败（service.ts:1053）只把 run 留在 RESERVED 直到下次 claimDue 的 sweep 保守结算——自愈、无超出文档方向的漂移；预留表 ~20 行/天/商家，有界。
- **模块迁移 runner**：逐版本事务应用、checksum 固定、gap 检测、`newer_than_build` 均正确且有测试；`learning_evaluation_*` claim/receipt v2/v3 序列一致。
- **transaction.ts**：savepoint 嵌套、poison/uncertain fail-closed、auto-rollback 探针有进程级抢占 fixture 支撑；wrapper 介导的写回滚完整性成立。
- **评测防重核心**：prepared→dispatched CAS（`transitionEvaluationAttempt`）、`saveReceipt` 对持久 dispatched marker 的等值校验、`local:` receipt 优先于外部证据、adoption 的 `contentDigest(binding)` 等值、attempt-not-already-present 与 baseline-first 同事务守卫、claim 互斥 + `UNIQUE(merchant_id, candidate_id, artifact_hash, suite_version)`、receipt 与结果同事务删除——其宣称关闭的崩溃窗口确实关闭；恢复不双计数（`runs_completed` 有守卫地加一；pilot-metrics.ts:137-146 只读最终 report_json）。
- **评测超时对齐**：timeout/model-error → `evaluation_runtime_outcome_unknown` → uncertain、clean no-plan finish → quality failure，与测试一致；90s 本身正确（问题在恢复出路，见 P1-6）。
- **管理 API 鉴权面**：全部新 `/merchant/api/v1/*` 路由 `requireActor` → `authorizeOrThrow`（权限 + merchant 不匹配 404）；所有 POST 另过 `assertWriteGuards`（HMAC CSRF token、api.ts:4753-4758 timing-safe 比较、Origin 精确匹配）；`governanceRouteDisabled` 在 flag 关或无 ownership 时 404——双重 fail-closed。
- **admin-passwd**：scrypt（N=16384）哈希、N 范围加固的 timing-safe 验证、重置时 0600+chmod、`--force` 必需、密码不经 argv、TTY 掩码提示、非 TTY 需 env；登录路由按 socket IP 限速（10 次失败锁 5 分钟）；cookie session 落盘 sha256 摘要。
- **reception 超时实现**：`setTimeout` 调 `agent.abort()`（abort signal 取消 pi-agent-core 模型流读取）、`finally` 清 timer、预算 lease 以 unknown 结算——真取消而非仅竞速计时器。
- **技能加载限额**：MAX_LOADED_SKILLS=2 / MAX_LOADED_SKILL_CHARS=3000 / summaries 5×600，带审计原因（A19 覆盖第三次加载拒绝）；skill-contract 拒绝未知 step 字段、未注册 action/guard/question_id，steps 上限 12。
- **customer-memory 核心面**：reception 工具面 `customerContext` 服务端派生、工具参数不带主体；fenced writer（reception-writer）在单个 `BEGIN IMMEDIATE` × `writeUnderOwnership` 内复核 binding epoch、scope epoch、grant epoch、memory_set_version，失配全 fail-closed；private-transport PII 走 0700 目录内 0600 socket、字节限额、内容不落日志；history.search 硬过滤 merchant/subject/grant/epoch/purge/SEALED，cursor 绑 grant+query（B11）；grant 撤销的 epoch 轮转正确孤儿化旧快照（B08）。
- **context-guard/authority/actor-context**：未注入域 fail-closed、四检查点均要求能力、模型块未知字段严格拒绝（ef637ffb 已落实：hasOnlyKeys）。
- **feature-flags/pilot-readiness**：严格 schema、输出冻结；投递 loop 启动受 flag 门控 + 每 tick `assertOwner`（抛 feature_disabled）。
- **buyer 全局搜索**（3b103fc2）：仅移除目录搜索的 region 过滤（limit 50，无 fanout/SSRF 变化）；`MerchantDeclined.merchantMessage` 控制字符剥离、300 字上限、sharecode 打码。
- **bootstrap 失败模式**：无效 governance flag 或 init 失败拒绝启动（无静默降级）；CAS 获取失败仅按 §18.2 关闭新功能；governance 事件日志只含类型/原因码。
- **env 横切**：`KIWI_GOVERNANCE_DISABLE_INIT`、`KIWI_OPERATIONS_SCHEDULER`、`KIWI_DELIVERY_DISPATCHER`、`KIWI_MEMORY_SOCKET_PATH` 缺省时一律 fail-closed；`KIWI_WORKBENCH_SERVICE_STATE` 非法值 → DEGRADED；reception 数值 env 校验失败回退 + 告警。

---

## 修复优先级建议

1. **客户自助身份层三件套**（P0-1、P0-2、P1-1）：M3 接 HTTP 前的硬前提；相关测试把漏洞流程固化为 fixture，需连测试一起改（两方挑战流程 / 管理侧创建 + 短语带外 / 删除路径补 assertActorOwnsSubject）。
2. **投递链路四件**（P1-2 租约前置 + loop 重入互斥、P1-3 SMTP deadline、P1-4 发送时复核授权/频控、P1-5 收件人接线）：四项凑齐前不建议把 dispatcher 放出测试模式；同时接通 UNKNOWN 核对路径（P2-7）。
3. **learning 恢复出路**（P1-6 terminal fallback 或 TTL 重派）+ 小修（P2-1 错误串清洗、P2-2 saveReceipt 入 try、P2-6 revise 清 marker）：数行修复，闭合"评测可恢复"承诺。
4. **bootstrap 三小修**（P2-3 recoveryWriteGuard、P2-4 PRAGMA、P2-5 迁移复读版本）可一次提交完成。
5. **保留策略接线**（P1-7 + P2-7 表项 7）：隐私承诺与无界增长，接调度即可。
6. 其余 P2 按流域排入常规修复节奏。

## 附录 A：48 小时提交清单（49 个）

| 时间 | 提交 | 说明 | 流 |
|---|---|---|---|
| 11-19 06:14 | f7e84df6 | feat(delivery): P1 明确授权后启用 customer_delivery | 投递 |
| 11-18 22:40 | 882040a3 | fix(delivery): 投递循环必须同时满足 P1 功能开关 | 投递 |
| 11-18 22:31 | 466094aa | feat(delivery): M6-6 投递循环与 workbench 邮件接线 | 投递 |
| 11-18 22:23 | 38397f07 | feat(delivery): M6-6 SMTP 发送适配器 | 投递 |
| 11-18 22:18 | 0725ae61 | feat(delivery): M6-6 邮件（Resend）发送适配器 | 投递 |
| 11-18 21:41 | 4cf85a6f | feat(delivery): M6-6 微信 iLink 发送适配器 | 投递 |
| 11-18 21:23 | cf78d140 | feat(reception): M6-5 回复 outbox 接入共用 StreamGate | 投递/接待 |
| 11-18 21:22 | 20aafde5 | feat(delivery): M6-3 绑定/订阅持久化与管理 API | 投递 |
| 11-18 21:14 | e5354d0b | feat(ops): 经营投影适配器接入调度 | 经营 |
| 11-18 20:56 | e610b3bc | feat(ops): 调度写路径纳入所有权栅栏 | 经营 |
| 11-18 20:54 | 55ab6f16 | feat(ops): 接入经营调度与评测终态网关契约 | 经营 |
| 11-18 17:32 | 703e9308 | Bind evaluation streams to dispatch identifiers | 评测 |
| 11-18 17:07 | bd61fb53 | Prove evaluation attempts before dispatch | 评测 |
| 11-18 16:58 | cbc4ca19 | Persist evaluation receipts for recovery | 评测 |
| 11-18 15:21 | 394670a3 | Recover uncertain learning evaluation attempts | 评测 |
| 11-18 10:59 | bcd335aa | Harden merchant runtime governance and evaluation | 治理 |
| 11-18 09:04 | 8ccb5eb9 | test(governance): 对齐 operations-jobs 账本 v3 断言 | 治理 |
| 11-18 08:58 | a5065a30 | feat(delivery): M6-5/6 共用流门与渠道适配器 | 投递 |
| 11-18 08:52 | e6da2b9b | feat(ops): 经营建议真实模型执行器与回退兼容测试 | 经营 |
| 11-18 08:42 | d2b93f86 | feat(ops): 补齐 C02-C16 与 A01-A03/A12 能力 | 经营 |
| 11-18 08:35 | 3b103fc2 | fix(buyer): search Kiwi Network globally | 买家 |
| 11-18 08:28 | ef637ffb | fix(reception): 严格拒绝模型块未知字段；补齐 B03/X02 | 接待 |
| 11-18 08:26 | 3fc796c3 | fix(learning): 已固定 RETIRED 版本可继续加载；补齐 A10/A11/A15 | 学习 |
| 11-18 08:21 | 1b1e245e | fix(memory): 客户自助写路径强制主体绑定；补齐 B/X 验收 | 记忆 |
| 11-18 08:14 | 024de901 | feat(delivery): M6-2 followup_outbox 持久化 v4 与发送仓库 | 投递 |
| 11-18 08:05 | 794cf857 | feat(delivery): M6-3 收件人绑定与目的订阅领域逻辑 | 投递 |
| 11-18 08:01 | a0dd7993 | feat(delivery): M6-2/4 发送领取、回执与 UNKNOWN 恢复状态机 | 投递 |
| 11-18 07:59 | b7614646 | feat(learning): 发布事件记录发布人；补充 A08/C01 回归 | 学习 |
| 11-18 07:57 | 0c508b2c | chore(evidence): 增加 64 条试点证据校验脚本 | 证据 |
| 11-18 07:55 | ab9fe96f | feat(delivery): M6-1 P1 客户发送门纯判定 | 投递 |
| 11-18 07:45 | e2e62130 | test(reception): 覆盖 A19 第三次技能加载被拒绝 | 接待 |
| 11-18 07:41 | 4b029734 | fix: recognize piece units and explain quote declines | 买家 |
| 11-18 07:30 | e550bfa8 | feat(reception): 指标记录技能加载结果（A17–A20 审计） | 接待 |
| 11-17 22:45 | 43816ca0 | fix(learning): 评测超时对齐 90s，套件 v1.3 接受受控澄清 | 学习 |
| 11-17 22:12 | 00d1295f | feat(learning): 评测套件 v1.2 修订价格异议与比较目标场景 | 学习 |
| 11-17 22:06 | 3eddb585 | fix(merchant): 学习/自动化写前逐次核验治理所有权 | 治理 |
| 11-17 22:06 | 3865f044 | feat(learning): 评测每场景 3 次回放并冻结 pilot 商品夹具 | 学习 |
| 11-17 21:58 | 9356981f | feat(learning): 评测回放记录可审计诊断摘要 | 学习 |
| 11-17 21:50 | 98d57b0f | feat(merchant): 独立 workbench 接入 TOP1-3 管理路由并单写者准入 | workbench |
| 11-17 21:32 | 14799d07 | merge: main into feat/top1-3-m0 before main fast-forward | 合并 |
| 11-17 21:27 | fef13c5f | feat(merchant): TOP1-3 M1-M5 governance, learning, memory and operations | 治理 |
| 11-17 20:50 | 03ddea13 | feat(merchant): add admin-passwd command and permanent listing status | workbench |
| 11-17 19:15 | 523ea7b8 | fix(release): keep 0.12.30 shipping lock for workbench candidate | 发布 |
| 11-17 19:09 | 1b0ca454 | feat(merchant): add standalone workbench server | workbench |
| 11-17 18:30 | 1b025656 | fix(portfolio): sync procurement expert to 1.1.3 | 组合 |
| 11-17 18:21 | 7fb85b65 | feat(merchant): improve negotiation replies and workbench pricing | 商家 |
| 11-17 10:49 | 94390ce9 | test(workbuddy): validate Linux cache and buyer identity | 适配器 |
| 11-17 08:12 | 2551ca3b | fix(workbuddy): recover buyer cache lock after process exit | 适配器 |

## 附录 B：审查覆盖清单

| 流域 | src 文件 | 主要测试 |
|---|---|---|
| 投递链路 | merchant-core/customer-delivery/{binding,channel,consent-repository,dispatcher-loop,dispatcher,email-adapter,gate,repository,smtp-adapter,stream-gate,types,weixin-adapter}.ts；a2a/reception/reply-outbox.ts；接线 workbench-server.ts、a2a/node.ts | customer-delivery-{binding,channel,consent-repository,dispatcher-loop,dispatcher,gate,repository,smtp,stream-gate}.test.ts、reception-reply-outbox-gate.test.ts |
| 经营调度与所有权 | operations-jobs/{scheduler,service,advice-runner,projection,pilot-evidence,pilot-metrics}.ts；ownership/{instance-ownership,runtime}.ts；migrations/{ledgers,runner}.ts；storage/transaction.ts；ops/{facade,schema,surface}.ts；budget/background-budget.ts | operations-scheduler、operations-jobs、instance-ownership、storage-transaction、operations-projection、operations-advice-runner、pilot-evidence |
| learning 评测 | learning/{service,repository,evaluation,real-evaluation-runner,recovery-gateway,evaluation-fixtures,evaluation-suite-v1,initial-skills,precheck,reception-skill-catalog,types}.ts；a2a/reception/agent-runtime.ts（超时路径） | learning-evaluation、learning-recovery-gateway、learning-candidates、learning-corrections(-api)、learning-release、m5-evaluation-suite(-fixtures)、governance-runtime |
| 客户记忆与治理 | customer-memory/{memory,identity,grants,history,private-transport,reception-provider,reception-writer,types}.ts；context-governance/{actor-context,authority,context-guard,data-use-grant,feature-flags,pilot-readiness,source-governance,types}.ts；a2a/reception/customer-memory-tools.ts | reception-customer-tools、customer-memory、source-governance、context-guard、context-governance-actor-grants、governance-feature-flags、merchant-reception-approval-claims |
| workbench 与 API 面 | merchant/workbench-server.ts；http/merchant-management/{api,page}.ts；cli.ts；mcp/{merchant-server,merchant-runtime-assembly,tools}.ts；cloud/bootstrap.ts；a2a/server/{merchant-handler,pipeline}.ts；a2a/reception/{publish,question-spec,skill-catalog,skill-contract,types}.ts；buyer-core 相关 delta | merchant-workbench-server、merchant-management-api、reception-question-spec、reception-skill-catalog、reception-agent-runtime、cli-entrypoint |

## 附录 C：局限

- 审查为静态读码 + 测试对照，未运行真实 SMTP/Resend/weixin/iLink 供应商、未迁移真实 DB、未做跨机/断电注入。
- P0-1/P0-2 当前无 HTTP 接线（服务层合同）；P1-5/P1-6 的触发前提分别是"投递 loop 放出测试模式"与"默认部署触发一次 uncertain"——按当前启用节奏（f7e84df6 明确授权启用）均属近期可现实触发面，非纯理论。
- 计数不跨轮累加：本报告 30 项为 48h 增量的独立裁定，不与 10-07 全库 114 项合并统计。
