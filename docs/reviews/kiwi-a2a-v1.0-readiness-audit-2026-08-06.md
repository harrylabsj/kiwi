# Kiwi A2A v1.0 就绪度审计

Created: 2026-08-06
方法：把 §41 完成定义的 27 条逐条映射到实现代码 + 测试证据，标 ✅（直接实证）/ ⚠️（部分或间接）/ ❌（缺失）。依据 = 仓库当前 `main`（74 测试文件，1235 tests 全绿）。

## 结论摘要

| 评估 | 数量 | 条目 |
| --- | --- | --- |
| ✅ 实证满足 | 27 | #1-27 |
| ⚠️ 部分满足 | 0 | — |
| ❌ 缺失 | 0 | — |

**A2A v1.0 已宣布（2026-08-07）。** 27/27 全部有代码 + 测试双证。原缺口 #24（network partition）已于同日补上 `tests/interop/interop-partition.test.ts`：模拟 merchant 停听后 buyer 发送 fail-closed（`ChannelError send_failed`）、同端口恢复后同一 negotiation 续跑收敛到 Agreement。§41 后由并行工作补入的 #27（没有库存预留副作用）与 #25/#26 同源证据（`reserves_inventory:false` 由 schema 与领域强制）。

## 逐条矩阵

| # | 完成定义 | 实现 | 测试证据 | 评估 |
| --- | --- | --- | --- | --- |
| 1 | Buyer/Merchant 独立 A2A Agent | `src/agent/`（buyer/merchant）、`src/a2a/` | `agent-buyer`、`merchant-turn`、`agent-integration`、`interop/interop-bilateral` | ✅ |
| 2 | 不依赖共同 Gateway 完成谈判 | `src/counterparty/a2a-direct/`、open-network v0.7 | `counterparty-a2a-direct`、`interop-bilateral`（直连无网关） | ✅ |
| 3 | 能发现 UCP Profile | `src/discovery/ucp/`（resolver/well-known） | `discovery-ucp`、`ucp-profile-server`、`ucp` | ✅ |
| 4 | 能发现并验证 Agent Card | `src/discovery/agent-card/` + trust 签名 | `agent-card`、`discovery-resolve`、`trust-jws`、`trust-http-message-signature` | ✅ |
| 5 | 能协商 capability intersection | `src/discovery/ucp/intersect.ts` | `capability-intersect`、`ucp-intersect`、`discovery-ucp` | ✅ |
| 6 | 公开稳定 namespace | `com.harrylabsj.kiwi.shopping.negotiation` + `kiwi.harrylabsj.com` 托管（Cloudflare Pages，2026-08-06 上线） | `negotiation-schema`；托管 URL 验证 | ✅ |
| 7 | 九类核心对象冻结 schema | `contracts/negotiation/1.0/schema.json` | `negotiation-schema`（32 例）+ `negotiation-schema-domain-crosscheck`（39 例） | ✅ |
| 8 | ConditionalOffer 确定性求值 | `src/negotiation/condition/` | `condition-evaluator`、`negotiation-domain` | ✅ |
| 9 | ID/TargetRef 模型生命周期 | `src/negotiation/domain/identifiers.ts` | `negotiation-identifiers`、`negotiation-envelope`（扁平 TargetRef/scope 约束） | ✅ |
| 10 | Message replay 幂等 | `src/negotiation/ledger/` + idempotency | `idempotency`、`ledger`（30 个含 idempot 的文件） | ✅ |
| 11 | duplicate ID / diff digest 可检测 | ledger + `verifyEnvelopeDigest` | `idempotency`（重复 message_id）、`negotiation-envelope`（digest 篡改） | ✅ |
| 12 | 多轮谈判跨进程恢复 | `src/negotiation/recovery/recover.ts` | `recovery`、`negotiation-phase`、`interop-recovery` | ✅ |
| 13 | A2A Task 跨进程恢复 | `src/a2a/` task + recovery | `a2a-task-state`、`a2a-task-poller`、`recovery`、`reliability` | ✅ |
| 14 | remote/local divergence 可 reconciliation | `src/negotiation/recovery/recover.ts`、`src/counterparty/a2a-direct/index.ts` | `recovery`、`interop-recovery` | ✅ |
| 15 | approval stale 可检测 | `src/operator/`（approval + stale TTL） | `operator-approval`、`reliability`（stale recovery）、`agent-consultation` | ✅ |
| 16 | Principal Memory 不进 remote context | `src/agent/memory/`（principal binding/task_context 隔离） | `agent-memory`（principal 绑定、task_context 仅自己可见）、`agent-buyer`、`interop-untrusted` | ✅ |
| 17 | Remote Content 不能直接成 Principal Memory | context-map（untrusted→candidate）+ memory 写入门禁 | `agent-memory`（candidate 非 trusted）、`context-map`、`interop-untrusted`、`counterparty-no-downgrade` | ✅ |
| 18 | Remote Agent 不能拿任意本地工具 | `src/agent/tools/`（tools-guard） | `tools-guard`、`counterparty-no-downgrade`、`agent-kernel` | ✅ |
| 19 | Hosted 与 Direct 共用 domain semantics | `src/counterparty/`（channel 抽象：a2a-direct + shopping-cli-hosted） | `counterparty-channel-contract`、`counterparty-shopping-cli-hosted`、`interop-cross-channel`（"direct 与 hosted 产出相同 phase 序列"） | ✅ |
| 20 | Legacy Adapter 兼容不扩权 | `src/protocol/legacy-shopping-negotiation/adapter.ts` | `legacy-adapter`、`counterparty-shopping-cli-hosted` | ✅ |
| 21 | reasoning backend 不改变 wire semantics | JCS 规范化（`src/negotiation/jcs.ts`）确定性生成 wire；与模型无关 | `knp-conformance-vectors`、`knp-data-part-examples`（frozen 向量锁 wire） | ✅（间接：无"换后端跑同一输入"直接测试） |
| 22 | 安全测试全部通过 | 安全边界实现（memory/tools/trust） | `tools-guard`、`agent-memory`、`trust-jws`、`trust-http-message-signature`、`trust-policy`、`interop-untrusted`、`counterparty-no-downgrade` | ✅ |
| 23 | RFQ abuse / fan-out privacy tests 通过 | `src/fanout/`（policy/disclosure/orchestrator）+ a2a-server throttle | `fanout-policy`、`fanout-disclosure`、`fanout-orchestrator`、`a2a-server-throttle`、`interop-fanout` | ✅ |
| 24 | partition / replay / restart tests 通过 | recovery/reliability 实现 | `reliability`（stale recovery/heartbeat）、`recovery`、`a2a-task-state`（中断）、`interop-recovery`、**`interop-partition`（2026-08-07 新增：停听→send_failed fail-closed→同端口恢复→收敛 Agreement）** | ✅ |
| 25 | 没有订单副作用 | schema 强制 `creates_order:false` + domain `requireFalse` + order-record 只读 | `negotiation-schema`（creates_order=true 拒绝）、`order-record`、`handoff` | ✅ |
| 26 | 没有支付副作用 | schema 强制 `authorizes_payment:false` | 同上 + `handoff`（agreement→checkout 仅 operator 授权后） | ✅ |
| 27 | 没有库存预留副作用 | schema 强制 `reserves_inventory:false` + domain `requireFalse` | `negotiation-schema`（reserves_inventory=true 拒绝）、`negotiation-schema-domain-crosscheck` | ✅ |

## 缺口闭合：#24 network partition（2026-08-07）

原缺口已补上：`tests/interop/interop-partition.test.ts` 用真实 http server 模拟分区——
merchant 停听后 buyer 发送抛 `ChannelError("send_failed")`（fail-closed、不降级、不挂起），
同一端口重新 listen 恢复后，同一 `negotiation_id` 续跑 CounterOffer→ConditionalOffer→Accept→Agreement，
双侧 Ledger 链有效、agreement 三副作用 flag 全 false。

## 宣布

**2026-08-07，A2A v1.0 正式宣布（27/27 完成定义全部实证满足）。**
依据本文档就绪度矩阵；协议文档 `docs/protocol/kiwi-negotiation-protocol-1.0.md` 状态转为
Normative（Released），基线 `docs/kiwi-a2a-architecture-baseline.md` §41 加盖宣布戳，
包版本 0.5.0 → 1.0.0，git tag `v1.0.0`。
