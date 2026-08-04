---
title: Kiwi 0.1.0 代码评审
created: 2026-08-04
type: research-note
topic: kiwi A2A 电商磋商 Agent Runtime 代码评审
status: review
tags: [code-review, kiwi, a2a, negotiation-agent, pi-agent-core]
---

# Kiwi 0.1.0 代码评审

**范围**：`~/coding/kiwi`（0.1.0，单 commit `9b66604`）全部 `src/`（约 5000 行）+ `tests/`（183 个测试）+ 冻结契约 + 脚本。本次评审只读，未修改代码。

**验证状态**：`npm run verify` 全绿 —— lint 0 error / typecheck strict / build / 183 tests 全过 / `verify:package` 生产包冒烟通过。

**总体结论**：工程质量在同类项目里属上乘。fail-closed 姿态贯穿 profile 校验、Ajv 契约校验、manifest 所有权验证、base_url 安全、工具 allowlist、no-order 边界；内容寻址幂等键设计干净；supervisor 的 nonce-in-argv + ps 验证 + 原子 0600 manifest + ready-marker 门禁是真正用心做的。**没有发现高严重度问题**。最值得优先修的是 M1（transient 后 claim 悬置 300s）和 M2（fake 同键重放语义背离契约），两者都是「会在生产或长跑中被咬到」的可靠性问题，修复成本都很低。

---

## Medium

### M1. claim 成功后、结算前的瞬时错误会让 claim 悬置到 300s stale TTL

位置：`src/runtime/negotiation-turn.ts:147-158`。

`claimMessage` 成功之后进入 `finishTurn`，包着它的只有 `try/finally { heartbeat.stop() }`，**没有** catch 来结算 claim。任何从工具调用或结算调用里抛出的 CommerceError（snapshot 瞬时失败、`submitNegotiationDecision` 响应丢失、`completeClaim` 瞬时失败）都会直接传出 `runNegotiationTurn`。`runForeground` 捕获 transient 后退避重试，但重试时该消息仍处 `processing`，`listPendingMessages` 不再返回它 → 退避重试拿到的是 `no_work`，消息要等 `abandonStaleClaims` 的 300s TTL 才被恢复。

- 具体后果：decisions 已被网关接受的 case 会通过内容寻址幂等键自愈（重领后重放同键→accepted→complete），所以**不会丢数据**，但每次都要白等 5 分钟。
- 建议：claim 成功后包一层 catch，任何逃逸的异常在传播前 best-effort `abandonClaim`（或按错误类型 `failClaim`），让消息立即回到 pending。

### M2. Fake client 对 in-flight 同键重放返回 `claimed:true`，与文档契约不一致，且会掩盖双处理缺陷

位置：`src/commerce/fake-client.ts:325-333` 和 `283-300`。

- 同 idempotency key + `processing` 的现存 claim → 返回 `claimed: true`（已实测确认）；
- `listPendingMessages` 不排除已被 claim 的消息。

因此两个**同身份** worker 会同时看到同一消息并各自视为「我拿到了 claim」，各自跑完整 turn（双写/双提交）。README 明确声明 claim 幂等契约是「非可重试的现存 claim 返回 claimed=false」（`src/commerce/types.ts:72-74` 同样如此注释），fake 的同键分支绕过了这条。真实网关由服务端决定、可信，所以这是 **fake 与契约的背离**，风险在于：基于 fake 的测试永远抓不到「同一身份双 worker」这类回归，而生产部署文档又明确允许同身份多 worker（"可被其他 worker 重领"）。建议把 fake 的同键-processing 分支改成 `claimed:false`。

### M3. `--once` 模式不注册任何信号处理，Ctrl-C 会孤儿化 claim

位置：`src/cli.ts:203-221`。

`--once` 路径不建 AbortController、不传 signal，也不装 SIGINT/SIGTERM handler。README 的「SIGINT/SIGTERM → abort Pi → 未 accepted 的消息一律 abandon」只对前台循环成立；`--once` 下按 Ctrl-C，Node 默认终止，processing claim 留在网关，要等下一个 runtime 的 300s stale 恢复。建议 `--once` 也挂 signal，至少注册 handler 走 abandon 路径。

---

## Low

### L1. 日志脱敏在两种写法下泄漏值（已实测复现）

位置：`src/supervisor/logs.ts:34-39`。

- 小写 `shopping_agent_token=supersecret123` → `shopping_agent_[REDACTED]=supersecret123`（**值泄漏**）。原因：`shopping_(merchant|buyer|agent|admin)_...` 模式**没有 `/i` 标志**，且按顺序先消费了变量名，随后的 `token[:=]` 模式在 `[REDACTED]` 后面找不到关键词。
- `env[SHOPPING_AGENT_TOKEN]=leaked` → 原样输出（**完全未脱敏**）。

大写 `SHOPPING_AGENT_TOKEN=value` 恰好被第 4 条 `token[:=]\S+` 兜住，所以现有单测覆盖不到缺口。修复：给 shopping_ 模式加 `/i`，并加一条「`[A-Za-z0-9_-]*_TOKEN` / `token[\]?[:=]`」兜底。这是纵深防御，实际危害取决于 shopping-cli 网关是否会把 env 写进日志。

### L2. 实例 `data/`、`logs/` 目录是 0755，SQLite 库可能本地可读

位置：`src/supervisor/init.ts:214`。

`data`/`logs`/`profiles` 均 `0o755`，实例根目录由 recursive mkdir 以默认 umask（通常 0755）创建。`kiwi.stack.json`(0600)、`run/`(0700)、日志文件(0600) 都收紧到位了，但 `data/shopping.sqlite` 由 shopping-cli 以自己的默认 open 权限创建（通常是 0644），里面存的是会话与报价正文——在多人机器上其他本地用户可读。对一个把「隐私不变量」当卖点的项目，建议 `data/` 也压到 0700。

### L3. `npm test` 在全新 clone 上不 build 会失败，与 README「无外部依赖」不符

`dist/` 在 `.gitignore` 里且未入库（已确认 `git ls-files dist` 为空），而 `tests/cli-entrypoint.test.ts:29-31` 在 `dist/cli.js` 缺失时直接 `throw`。`npm run verify` 先 build 所以没问题；但单独 `npm test` 会挂。建议该测试改为 skip，或在 README 注明 `npm test` 前需先 build。

### L4. 超时/信号 abort 与「在途 accepted submit」竞态时，turn 会被误报为 failed

位置：`src/runtime/negotiation-turn.ts:238-254`。

`agent.abort()` 触发后 `waitForIdle()` 可能先于在途 submit 的 resolve 返回，此时 `tracker.decisionResult` 还没写入 → 走「无决策」分支 `failClaim`，而网关侧其实已 accepted。靠内容寻址幂等在重试时自愈，但本次 turn 报告会是 `failed`。现有超时测试用的是从不 submit 的 `hangingStreamFn`，没覆盖此路径；取决于 Pi 的 abort 语义，建议补一个「submit 在途时超时」的确定性测试确认行为。

### L5. shutdown 时 `rejected_retryable` 结果走 `failClaim` 而非 `abandonClaim`

位置：`src/runtime/negotiation-turn.ts:279-298`。

README 的 shutdown 语义是「未 accepted 的消息一律 abandon（绝不 complete）」，但外部信号到达时若最后结果是 `rejected_retryable`，代码会 `failClaim`。两者都可重领、都非 complete，属文档微漂移，不是功能 bug。

---

## Nits

- `isModelConfigError`（`negotiation-turn.ts:338-341`）只匹配 "api key"/"unauthorized"/"401"；模型 403/配额错会被判可重试（退出码 10 而非 4）。
- `runUp` 只在 spawn 后 750ms 检查 agent 存活（`manage.ts:378-384`）；更慢的运行时故障（如认证重试循环）仍会上报 success，属监控盲区。
- `heartbeat` 在 `completeClaim` 与 `stop()` 之间仍可能再打一拍——已结算 claim 上无害（refreshed 0 / not_found 计一次 failure）。
- `BUDGET_LEAK_PATTERN`（`buyer-policy.ts:38-39`）启发式偏宽：`预算书`/`预算案` 等无辜措辞也会被本地门拒绝；另外英文侧漏了 "ceiling"/"limit" 单独出现的情况。属权衡，可接受。
- `PROVIDER_BASE_URL`（`model.ts:31-41`）缺 `google-vertex`、`amazon-bedrock` → 这两个 provider 在 profile 未显式给 base_url 时落到 `""`。
- `runDoctor` 对 profile 文件二次解析做 secret 扫描（`doctor.ts:52`），有轻微 TOCTOU，无实际影响。

---

## 结论

代码质量在同类项目里属上乘：安全边界（no-order、仅两工具、buyer 私有预算只在本地门、HTTP 明文仅限 loopback、supervisor 从不按名字/端口杀进程）都落实到了代码与测试，且 `verify` 全套绿。**没有发现高严重度问题**。最值得优先修的是 M1（transient 后 claim 悬置 300s）和 M2（fake 同键重放语义背离契约），两者都是「会在生产或长跑中被咬到」的可靠性问题，修复成本都很低。L1/L2 是隐私主题下的收尾项。
