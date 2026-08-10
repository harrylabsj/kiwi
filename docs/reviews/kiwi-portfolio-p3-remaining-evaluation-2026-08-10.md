---
title: kiwi 组合值得修改的缺陷清单（复核版，2026-08-10）
created: 2026-08-10
updated: 2026-08-10
type: code-review
topic: v0.7.0 发布前值得修改的缺陷与实施顺序
status: 已复核，待实施
tags: [code-review, release-gate, bug, kiwi, kiwi-catalog, shopping-cli]
---

# kiwi 组合值得修改的缺陷清单（复核版）

## 结论

原“剩余 P3”清单把真实缺陷、部署选择和未来风险混在了一起，并漏掉当前生产路径上
更高优先级的问题。本版只保留具备代码证据、会影响发布、互操作、安全、数据正确性或
长期运行的缺陷。

- **确定值得修改：11 项**，其中 P1 发布阻塞 6 项、P2 应修 5 项。
- **条件修复：3 项**，只有对应模块进入正式承诺面或部署形态后才实施。
- **当前不做：4 类**，避免为尚未启用的能力提前引入大迁移或 wire 契约变化。

### 复核基线

- `kiwi`：`4209c3d` + 当前未提交工作树；
- `kiwi-catalog`：`d1a18cb` + 当前未提交工作树；
- `shopping-cli`：`4f05bee`；
- 本次为实现与文档静态复核，**未重新宣称三仓全量门禁通过**。实施每项缺陷后须按其
  完成证据补测试，并在最终发布门禁统一复跑。

### 优先级定义

- **P1 发布阻塞**：不修不得宣布 v0.7.0 公网可用或第三方互操作完成。
- **P2 应修**：不一定阻止本地演示，但会留下重复执行、身份丢失或长期运行问题。
- **P3 条件项**：问题真实，但当前没有生产调用方或仅在尚未承诺的部署形态出现。

---

## 一、P1 发布阻塞

### BUG-01. 生产 A2A 路径使用固定在 2026-08-07 的假时钟

- **严重性 / 置信度**：P1 / 10
- **位置**：
  - `src/a2a/node.ts:77-84`
  - `src/a2a/negotiate.ts:142-150`
  - `src/a2a/server/merchant-handler.ts:121-140`
- **问题**：`monotonicNow()` 从固定常量 `2026-08-07T00:00:00.000Z` 开始，每次调用
  只增加 1ms。该函数不仅用于测试，也被 `startA2aNode()` 和
  `negotiateWithAgent()` 的真实运行路径调用。`created_at`、Ledger 时间、报价
  `valid_until` 与缓存 TTL 都不会跟现实时间前进。
- **影响**：第三方会收到历史时间戳或已经过期的报价；本机又用同一假时钟判断过期，
  形成“本机接受、外部拒绝”的互操作分裂。重启还会把时钟重置回同一历史起点。
- **推荐修复**：实现基于墙钟的单调时钟：每次返回
  `max(Date.now(), previous + 1)`，并保留可注入时钟供测试使用。`node.ts` 与
  `negotiate.ts` 复用同一原语，禁止生产代码出现固定日期基准。
- **完成证据**：
  1. 注入时钟单测覆盖同毫秒多事件仍严格递增；
  2. 集成测试断言生产默认 `created_at` 接近现实时间、`valid_until` 位于未来；
  3. 重启测试断言不会回退到历史日期。
- **工作量**：S（约 0.5-1 工程日，含回归测试）。

### BUG-02. 公网反代把外部请求误当成本机可信请求

- **严重性 / 置信度**：P1 / 10
- **位置**：
  - `src/a2a/node.ts:44-60, 170-190`
  - `src/a2a/server/server.ts:160-170`
  - `src/a2a/server/auth.ts:94-119`
  - `README.md:94-98`
- **问题**：当前工作树允许用 `KIWI_A2A_PUBLIC_URL` 经 Caddy/Nginx 对外广告和反代，
  但 `startA2aNode()` 没有传入 `authVerifier`。A2A Server 因而使用
  `LoopbackOnlyAuthVerifier`；反向代理从 `127.0.0.1` 连接节点，外部请求在应用层
  看起来就是 loopback 并被认证通过。
- **影响**：一旦按 README 暴露公网，socket 来源不再代表真实调用方，默认的
  “仅本机可访问”安全边界失效。
- **推荐修复**：
  1. `A2aNodeOptions` 增加显式 `authVerifier`；
  2. 只要广告地址不是 loopback，未配置公网认证就启动失败；
  3. CLI 公网模式接入 HTTP Message Signature 验证器，或使用明确、可审计的代理认证
     契约；不得只信任 `remoteAddress`；
  4. README 同步写明认证前置条件。
- **完成证据**：经真实 loopback 反代发送的未认证外部请求被拒；合法签名请求通过；
  本地未启用公网模式仍可使用 loopback 默认值。
- **工作量**：M（约 1-2 工程日，取决于密钥解析配置接线）。
- **依赖**：与 BUG-06 同一批完成。

### BUG-03. A2A 节点状态落临时目录，重启丢失幂等、Ledger、报价与终态

- **严重性 / 置信度**：P1 / 10
- **位置**：
  - `src/a2a/node.ts:154-157, 229-233`
  - `src/cli.ts:521-540`
  - `src/a2a/server/merchant-handler.ts:201-208, 396-423, 458-485`
  - `src/negotiation/recovery/recover.ts:133-142`
- **问题**：`startA2aNode()` 总是 `mkdtemp()`，`stop()` 时递归删除目录；CLI 虽展示
  `--data-dir`，却没有传给 A2A 节点。与此同时 `conditionalByNegotiation`、
  `closedNegotiations`、`phaseByNegotiation` 只存在内存，已有
  `deriveLocalPhase()` 也没有接入 merchant handler 的恢复路径。
- **影响**：重启后：
  - 同一消息的幂等记录和审计链消失；
  - 已终态 negotiation 可以重新打开；
  - 已发出的 conditional offer 无法再被接受，返回 `offer_unknown`；
  - 跨进程共享锁在默认节点形态下没有共同存储可锁。
- **推荐修复**：
  1. `startA2aNode()` 接受持久 `dataDir`，生产 CLI 使用 `<data-dir>/a2a/`；
  2. 仅测试或显式 demo 模式允许临时目录；正常 `stop()` 不删除生产状态；
  3. 从 Ledger 或持久投影恢复终态、当前 phase 与尚可行动的最后 offer；
  4. 对同一状态目录增加单 owner 或明确的多 worker 协调规则。
- **完成证据**：同一目录重启后，幂等 replay、终态拒绝重开、已有报价继续 accept、
  `tasks/get` 恢复均通过集成测试。
- **工作量**：L（约 2-4 工程日）。
- **依赖**：BUG-07、BUG-10 应在本项之后完成。

### BUG-04. 实际报价路径仍在静默舍入金额

- **严重性 / 置信度**：P1 / 10
- **位置**：
  - `src/a2a/server/merchant-handler.ts:254-259`
  - `src/agent/buyer/buyer-tools.ts:303-308`
  - `src/commerce/shopping-cli-source.ts:82-91`（已有正确的 lossless 原语）
  - `shopping-cli/shopping_cli/commerce/adapters.py:33-35`
  - `shopping-cli/shopping_cli/core/catalog.py:316-384`
- **问题**：部分路径已经使用 `losslessToMinorUnits()`，但生产 merchant handler、
  buyer task 和 shopping-cli adapter 仍分别执行 `Math.round(price * 100)` 或
  `int(round(price * 100))`。shopping-cli 商品入口只校验 finite/non-negative，未限制
  币种小数精度。因此 19.995 等值会被静默改写后进入报价。
- **影响**：对外协商的 `amount_minor` 可能不是数据源表达的价格；这是现有数据完整性
  bug，不是“未来增加税费后才发生”的风险。
- **推荐修复**：
  1. TypeScript 所有 major→minor 转换统一复用 lossless 原语，无法精确表达就
     fail-closed；
  2. Python 使用 `Decimal(str(value))` 按币种 exponent 做精确校验与整数转换；
  3. 商品创建、更新、ERP 导入边界拒绝超过币种允许精度的价格；
  4. 本轮不必先做全表 minor-unit schema 迁移，但新协议与 commerce 接口一律输出整数。
- **完成证据**：覆盖 `19.99`、`19.995`、`0.1`、极大值、非有限值和不同币种 exponent；
  lossy 输入稳定拒绝，合法值跨两仓得到相同 minor units。
- **工作量**：M（约 1-2 工程日）。

### BUG-05. 对外公开 spec 仍是旧规范身份与旧正文

- **严重性 / 置信度**：P1 / 10
- **位置**：
  - `CLAUDE.md:16-28`
  - `spec/a2a/extensions/negotiation/1.0:1-8`（rev1.1 / Draft / Kiwi v0.4+）
  - `docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md:1-8`
  - `docs/CURRENT-DOCS.md:3-20, 34-42`
- **问题**：仓库明确声明 `spec/` 是公开协议源，但其中 KNP 正文仍为 rev1.1；当前文档
  清单指向 rev1.4。实测两文件为 128 行新增、47 行删除，共 175 行变化。另一方面，
  rev1.4 的 metadata 仍写 `target_implementation: Kiwi v1.0.0`，不能直接整文件复制，
  否则又会引入版本回退后的身份漂移。
- **影响**：第三方按公开 spec 实现时，会得到与当前实现/当前文档清单不同的状态机和
  契约说明。即使运行时代码尚未完全接线，这也已经是互操作发布问题。
- **推荐修复**：先确定单一规范源，再把 rev1.4 errata 内容与 v0.6/v0.7 版本身份一起
  校准到 `spec/`；增加 CI 检查，防止公开 spec 与实现侧权威文档再次无说明漂移。
- **完成证据**：
  1. `spec/`、`CURRENT-DOCS.md` 和目标版本 metadata 一致；
  2. 所有规范差异要么消失，要么由明确的生成/同步规则与 changelog 解释；
  3. schema、转换表和 action 词表契约测试通过。
- **工作量**：M（约 1-2 工程日，含人工校对）。
- **依赖**：不依赖 BUG-10；若 BUG-10 后改变规范语义，再单独 bump 文档修订号。

### BUG-06. 已签名请求可以不绑定请求体

- **严重性 / 置信度**：P1 / 10
- **位置**：
  - `src/trust/identity/message-signature.ts:365-374`
  - `src/trust/identity/trust-policy.ts:23-32, 74-80`
  - `src/trust/identity/auth-verifier.ts:133-180`
- **问题**：只有签名者主动把 `content-digest` 放进 covered components 时，验签器才
  重算 body。T1 已要求 HTTP Message Signature，但当前没有任何最小覆盖组件策略；
  因此把要求限定到 T2/T3 也不正确。
- **影响**：服务端可能确认“调用方签名有效”，却没有确认该调用方签过当前 JSON body。
  一旦 BUG-02 接入真实公网验签，该缺口就进入生产信任边界。
- **推荐修复**：所有带非空 body 的已签名请求均强制覆盖
  `@method`、`@target-uri`、`@authority` 与 `content-digest`；若要兼容无 body 请求，
  按请求形状定义最小组件集合，而不是按签名者自选或只按 T2+ 判断。
- **完成证据**：合法签名通过；body 被改、digest 缺失、digest 未进入 covered components、
  关键 derived component 缺失均稳定拒绝；T1/T2/T3 矩阵有回归测试。
- **工作量**：S-M（约 0.5-1 工程日）。
- **依赖**：与 BUG-02 同批发布。

---

## 二、P2 应修

### BUG-07. 幂等锁没有覆盖业务副作用，outbound 甚至缺进程内串行化

- **严重性 / 置信度**：P2 / 10
- **位置**：
  - `src/negotiation/idempotency/store.ts:139-179`
  - `src/a2a/server/pipeline.ts:98-119, 273-407`
  - `src/counterparty/a2a-direct/index.ts:208-270`
  - `src/handoff/idempotency.ts:88-142`（可参考完整临界区）
- **问题**：给 `commit()` 单独加文件锁只能串行化最终写入，无法阻止两个执行者都在
  `check()` 后完成网络调用或 handler 副作用。Inbound pipeline 只做进程内
  `withKeyLock()`；`A2ADirectChannel.send()` 连同进程的整段锁都没有。
- **影响**：同 key 并发发送可能产生两次远端调用或两次业务效果，最后只是在 commit
  阶段发现冲突，已经无法撤销前面的副作用。
- **推荐修复**：提供按 `(sender_identity, message_id)` 的异步 ownership/lease，覆盖
  `check → handler/network effect → ledger → commit` 全临界区；同进程与共享持久目录
  的跨进程执行使用同一语义，并有超时、崩溃残留和 fencing 测试。
- **完成证据**：
  1. 同进程两个并发 direct send 只发生一次网络调用；
  2. 两个子进程共享目录只允许一个 owner 执行；
  3. owner 崩溃后可安全恢复，不会让旧 owner 延迟提交覆盖新 owner。
- **工作量**：M-L（约 1-2 工程日）。
- **依赖**：先完成 BUG-03 的持久目录和 owner 模型。

### BUG-08. 对方已接受非绑定报价后仍 abandon claim

- **严重性 / 置信度**：P2 / 10
- **位置**：
  - `src/agent/kernel.ts:891-900`
  - `src/operator/runner.ts:254-299, 390-400`
  - `src/runtime/negotiation-turn.ts:287-308`
- **问题**：自动轮询发现对方 `accept_nonbinding` 后，把 key 放进内存
  `settledNegotiations`，随后调用 `runner.abandon()`。abandon 的语义是释放 claim，
  允许之后重新领取；内存 Set 只是当前进程的遮挡层，重启后消息会再次进入处理。
- **影响**：重复 claim、重复快照和重复“已达成共识”通知；原文建议持久化 Set 只是
  固化旁路状态，没有结算权威 claim。
- **推荐修复**：对方接受是“本消息已处理”的终态，调用 `completeClaim()`；
  `settledNegotiations` 最多保留为进程内优化，不再承担正确性。
- **完成证据**：首次处理后网关 claim 为 completed；重启后同一消息不再 pending，
  不产生第二次用户通知。
- **工作量**：S（约 0.5 工程日）。

### BUG-09. 商户重新获批时创建新 merchant_id，旧资源失去控制面

- **严重性 / 置信度**：P2 / 10
- **位置**：
  - `kiwi_catalog/services/accounts.py:387-432`
  - `kiwi_catalog/services/merchant_tokens.py:100-180`
  - `kiwi_catalog/db/models.py:30-65, 318-345`
- **问题**：已有 merchant_id 的账户在 token 被 revoked 后可以重新申请；批准逻辑却
  无条件 `new_platform_merchant_id()` 并覆盖账户绑定。旧 ID 下不仅有
  `catalog_agents`，还有 `commerce_listings` 等弱引用资源。
- **影响**：只迁移 agents 会继续留下 listing、影子 merchant、token 与审计身份分裂；
  商户无法用新 token 管理旧资源。
- **推荐修复**：merchant_id 是稳定身份，token 是可轮换/撤销凭据。已有 merchant_id 的
  账户重新获批时复用原 ID 并重新签发 active token；只有显式“新身份/身份重置”管理
  操作才能创建新 ID，且必须以事务迁移全部所属资源。
- **完成证据**：revoked→reapply→approve 后 merchant_id 不变，旧 agent/listing 仍可管理；
  被拒且从未获批的账户首次批准仍创建新 ID；审计记录凭据重签发而非身份迁移。
- **工作量**：S-M（约 0.5-1 工程日）。

### BUG-10. 规范状态机没有接入生产 merchant handler

- **严重性 / 置信度**：P2 / 10
- **位置**：
  - `src/negotiation/state/phase.ts:254+`
  - `src/a2a/server/merchant-handler.ts:201-235, 298-490`
  - `src/negotiation/recovery/recover.ts:133-142`
- **问题**：`transitionPhase()` 只有测试调用；生产 handler 用三个 Map 和分支隐式表达
  状态，只记录少量终态 transition。中间相位与规范转换表没有成为接收消息的权威门。
- **影响**：实现可能接受规范禁止的 action 顺序；“只约束终态、双方自行维护中间态”
  若不同时缩小 conformance 声明，会形成契约与实现不一致。
- **推荐修复**：在 BUG-03 的可恢复状态基础上，把每个入站 action 映射到
  `transitionPhase()`；非法转换 fail-closed，合法转换与 handler 副作用原子落账。
  本版不推荐仅写一句“运行时不约束”后继续宣称完整 KNP runtime conformance。
- **完成证据**：用生产 A2A handler 跑完整转换表；每个非法边均拒绝，每个合法边产生
  一条可恢复的 state transition；重启后结果一致。
- **工作量**：M-L（约 2-3 工程日）。
- **依赖**：先完成 BUG-03；完成后如有规范语义变化，再更新 BUG-05 的文档修订。

### BUG-11. buyer bootstrap 限流窗口行永不清理

- **严重性 / 置信度**：P2 / 9
- **位置**：
  - `shopping_cli/api/idempotency.py:90-115`
  - `shopping_cli/db/models.py:212-220, 322-323`
- **问题**：每个活跃 `(token_hash, buyer_id, 60s window)` 产生一行；持续每分钟活跃时
  上限是 1440 行/买家/天。旧窗口已经不参与限流，却没有清理路径。
- **影响**：长驻 API 的表和索引单调增长；这是可独立、低风险处理的生命周期缺口。
- **推荐修复**：在限流事务内低频/抽样删除超过安全缓冲期的旧窗口，或增加独立周期
  清扫；使用现有 `updated_at` 索引并限制单批删除量。不要在本项顺带删除
  `audit_events`、`agent_message_processes` 或 `channel_message_ingresses`。
- **完成证据**：旧窗口被删除、当前窗口计数不受影响；并发限流仍不超发；大量旧行场景
  的清理有批量上限且不造成长写锁。
- **工作量**：S（约 0.5 工程日）。

---

## 三、条件修复项

这些问题真实，但是否现在实施取决于产品承诺或部署形态。先做明确选择，不能用不完整的
“最小修复”假装恢复能力已经成立。

### CONDITIONAL-01. UCP checkout 本地可信 mirror 无恢复

- `src/handoff/ucp-checkout/channel.ts:240-244, 402-506` 的问题成立。
- 远端响应不能重建 `HandoffSession.package/current_terms/current_terms_digest`，而
  update 和 completion gate 明确依赖这些可信本地字段；因此“mirror miss 时直接查远端”
  只能恢复部分读取，不能安全恢复完成流程。
- **若 UCP checkout 属于 v0.7 正式承诺面**：持久化可信 session 投影，加载时验证
  package/digest，并以远端状态刷新本地投影。
- **若仍是 demo/e2e 层**：在 capability、README 与发布声明中明确 experimental，
  不把重启续接列为已支持能力。

### CONDITIONAL-02. nonce 仅进程内共享

- `InMemoryNonceStore` 对单实例语义足够；真实问题只在 HTTP Message Signature 已接入且
  同一身份验证面部署多个 replica 时出现。
- 多 replica 上线前换成共享、原子 check-and-set 且带 TTL 的存储；在此之前写清单实例
  约束即可。本项不能替代 BUG-02/BUG-06。

### CONDITIONAL-03. fanout 轮询逐条落 Ledger

- `FanoutOrchestrator` 当前没有生产调用方，100ms poll 每次记 observation 会制造大量噪音。
- 在 fanout 接入生产前，改为状态/revision 变化才落账，并增加长轮询体量测试；本轮无需
  为未接线模块单独阻塞发布。

---

## 四、本轮明确不做

1. **不做全量 money schema 迁移**：先修 BUG-04 的边界无损转换与精度校验；是否把
   SQLite `REAL` 全迁为 minor-unit integer，等数据迁移设计与真实算术需求确定后再做。
2. **不统一删除审计与幂等表**：`audit_events` 需要归档/合规策略，
   `agent_message_processes` 与 `channel_message_ingresses` 需要明确 replay horizon；不能按
   一个 N 天常量批量删除。
3. **不改 ERP sync wire 契约**：网络失败 `200 + ok:false`、部分成功 report 和多 A
   fallback 是三个独立议题。当前已有文档化客户端信封，且未发现 Kiwi 生产调用方；若要
   改 HTTP 状态码，另立 API 契约变更，不混入本轮 bug 修复。
4. **不提前上共享 nonce/Redis**：只有多 replica 认证部署确定后实施 CONDITIONAL-02。

---

## 五、实施顺序与发布门禁

### Wave 1：先恢复可信运行基础

1. BUG-01 现实单调时钟；
2. BUG-03 持久目录与重启恢复；
3. BUG-08 正确结算已接受消息。

### Wave 2：关闭公网与数据完整性缺口

4. BUG-02 公网认证边界 + BUG-06 签名 body 绑定；
5. BUG-04 金额无损转换；
6. BUG-05 公开 spec 校准。

### Wave 3：补齐并发、状态机与跨仓生命周期

7. BUG-07 完整幂等 ownership；
8. BUG-10 生产状态机接线；
9. BUG-09 稳定 merchant_id；
10. BUG-11 限流窗口清理。

### 发布判断

只有以下证据同时成立，才可宣布 v0.7.0 公网/第三方互操作就绪：

- P1 六项全部完成并有负路径测试；
- A2A 节点重启恢复测试通过；
- 公网反代下未认证请求被拒、合法身份请求通过；
- 公开 spec 与版本身份一致；
- 三仓全量门禁重新执行并记录真实测试数；
- 至少一条第三方或独立实现互操作证据，不以双 Kiwi 端自测替代。

BUG-03 与 BUG-02 的实现形态会决定实际工期；架构选择落定后再按 Wave 分别估算，
不提供脱离持久化与认证方案的总工期。
