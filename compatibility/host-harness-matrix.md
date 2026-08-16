# Host / Harness Compatibility Matrix（§6.10 / §十一 Phase 3）

验收"语义不变量"而非要求不同宿主生成完全相同的排名/文本。以下矩阵记录当前各
接入方向的角色、状态与必须保持的语义不变量。

## 语义不变量（跨宿主强制，§6.10）

| 不变量 | 内容 | 验证点 |
|---|---|---|
| Schema | 同一 CommerceIntent / DelegationPolicy / Persistent Task schema | `contracts/` + `verify:contracts` |
| 授权门 | 五层授权 deny-wins；accept/handoff 绑定持久 approval_id | `tests/mcp-facade.test.ts` "五层授权" |
| 脱敏 | host-context isolation：只投影 CommerceIntent，无 Principal Memory | "host-context isolation" 测试 |
| 幂等 | 写操作 idempotency_key 去重，返回原 task | "幂等" 测试 |
| 恢复 | 重启后 pending/approval 可解释 | "持久化" 测试 |
| 错误分类 | McpError.code 语义稳定（task_not_found/approval_required/...） | `errors.ts` + 协议面测试 |
| 协议摘要 | Agreement digest 可审计（provenance + reply_text） | evidence-gate 报告 |
| 版本兼容 | MCP 版本协商 fail-closed；未知版本拒绝 | "initialize 版本协商" 测试 |

## 接入方向矩阵

| 接入 | 方向 | 角色 | 状态 | 状态权威 | 推理实现 |
|---|---|---|---|---|---|
| Hermes | Host→Kiwi Buyer | 首个真实 Host reference（§6.9） | P0 PILOT ✅ 已接线 | Kiwi Buyer Core | Hermes 自有 LLM |
| DeepSeek Harness | Kiwi↔Harness | 受限 ReasoningBackend / contract 验证面 | P0 PILOT ✅ contract gate 24/24 | Kiwi（无 Commerce 写权） | DeepSeek V4（mock 验证 / --real） |
| marketplace resident daemon | 商家侧 | Merchant Core 确定性应答（Standalone-first） | ✅ 独立运行 | shopping-cli | 确定性规则（无 LLM） |
| kiwi merchant runtime | 商家侧 | Merchant Ops/推理增强（可拔插） | ⚠️ 磋商增强（fake model 队列有限） | shopping-cli | fake（Phase 3 → real） |
| OpenClaw / Kimi / Codex / WorkBuddy | Host→Kiwi Buyer | 扩张 | AFTER GATE（双证据门） | — | — |

## 验收纪律

- 不要求不同宿主产生完全相同的排名/文本（§6.10）。
- Hermes 产品证据门 + DeepSeek Harness contract gate 通过前，暂停新增
  OpenClaw/Kimi/Codex/WorkBuddy 产品化集成（§十一 Phase 2）。
- 下一宿主扩张不是时间驱动，而是证据驱动（真实采用来源决定）。
