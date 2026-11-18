# ZCode 完整开发指令：Kiwi 商家智能体 TOP1-3

将下面整段贴给 ZCode。它是一份分阶段总指令：本轮只执行 M1，完成后停下报告；M2–M6 仅作上下文，不要提前实现。

---

你是 Kiwi 项目的资深后端工程师兼技术负责人。目标是把《Kiwi 商家智能体 TOP1-3 设计 v1.1》实现为可测试、可回退的代码。你按 M1 → M6 的顺序推进，每个里程碑完成后必须停下、报告、等待确认；没有确认不得进入下一个里程碑。

## 一、工作区与硬约束

- 只在 `/Users/jianghaidong/coding/kiwi-top1-3` 工作。
- 分支 `feat/top1-3-m0`，基线 `366ef681800322446db21bd1b510c1d810964508`。
- 禁止：`git commit`、`git push`、`git checkout`、`git reset`、部署、发布、改生产数据、改生产配置。
- 禁止修改主仓 `/Users/jianghaidong/coding/kiwi`；它必须保持 `main` 干净。
- `node_modules` 已软链到主仓；禁止 `npm install` / `npm ci`。若缺依赖，停止并报告。
- 不修改 KNP wire、A2A 协议、公开 action 或错误码。
- 不启用个人跨会话记忆：TOP2 P0 只做组织/代理范围；`person`/`verified_person` 一律拒绝或降级。
- 客户外发 P0 固定关闭；P1 发送不得提前实现。
- `.m0-reference/` 是只读参考，不提交、不修改、不删除。

## 二、必读材料

先读，再动手：

1. `.m0-reference/Kiwi_商家智能体TOP1-3设计_v1.1_2026-11-15.md`
   - 重点：§1、§2、§4、§5–§8、§9–§12、§13–§16、§17–§22、§23、附录 A。
2. `.m0-reference/Kiwi_商家智能体TOP1-3设计_M0决策记录_2026-11-15.md`
   - D-M0-01 至 D-M0-10 已定，不要重新讨论。
3. `.m0-reference/Kiwi_商家智能体TOP1-3设计_M0收尾决议_2026-11-15.md`
   - §1 参数冻结 `policy_version=m0-pilot-1`。
4. `.m0-reference/Kiwi_商家智能体TOP1-3设计_v1.0_修订清单与M0决策项_2026-11-15.md`
   - R01–R13 的落点。
5. 仓库 `CLAUDE.md` 与现有代码模式：
   - `src/merchant-core/ops/schema.ts`：现有迁移账本写法。
   - `src/merchant-core/storage/`：事务、`ensureColumn`、存储辅助。
   - `src/merchant-core/followup/`：任务状态机、租约、fencing、UNKNOWN。
   - `src/a2a/reception/`：接待引擎、发布器、工具白名单、outbox。
   - `src/agent/skills/registry.ts`：技能格式校验思想。
   - `src/cloud/bootstrap.ts`：`state.sqlite` 与 facade 装配。
   - `src/a2a/reception/config.ts`、`src/merchant/ai-runtime/config.ts`：严格配置解析与预算模式。

## 三、已冻结的产品/架构决策

不要重新设计，按下面执行：

1. **D-M0-01 主体范围**：目标宿主按人主体能力未确认；P0 只启用 `organization` / `agent_scope` 记忆，个人 `verified_person` 关闭，保留接入点。
2. **D-M0-02 确认通道**：文本一次性短语 + 宿主卡片双通道，共用 `grant_request_id` / `confirmation_ref`；文本路径先交付。
3. **D-M0-03 商家纠正**：新增 `learning.submitCorrection`，再 `learning.promoteCorrection` 形成案例；不复用 `createCase` 硬凑来源。
4. **D-M0-04 技能发现**：运行快照注入 `skill_summaries`（≤5 项/600 字，不含正文）；`load_reception_skill` 最多 2 个/3000 字。
5. **D-M0-05 迁移账本**：`learning_schema_migrations`、`customer_memory_schema_migrations`、`operations_jobs_schema_migrations` 独立；不复用 `merchant_ops_schema_migrations` 版本号。
6. **D-M0-06 评测**：目标场景 3/3 通过且无硬门；不设结果后例外。
7. **D-M0-07 规则入口**：自然语言只生成规则候选，商家确认后由固定 executor 启用；模型不能直接启用。
8. **D-M0-08 单写者**：`state.sqlite` 所有权表 + 心跳租约；第二进程 fail-closed；旧 owner 不能提交。
9. **D-M0-09 参数**：`policy_version=m0-pilot-1`；预算/上限/留存按 M0 收尾决议 §1。
10. **D-M0-10 命名**：规则入口统一 `automation.prepareRule` 的 `template|goal` 双模式；不新增 `jobs.proposeRule`；现有 `MerchantJobs.runOnce(name)` 只作定时唤醒骨架。

## 四、里程碑与交付物

### M1 共性控制（本轮只做这个）

目标：所有后续模块共用的身份、授权、版本、迁移、单写者与开关基础。

交付：

1. **ActorContext**
   - 类型、服务端创建/校验、字段：`merchant_id`、`actor_id`、`auth_strength`、`subject_binding`、`capabilities`。
   - 模型/客户端只能提交业务参数，不能提交可信 merchant/subject/权限。

2. **DataUseGrant**
   - 类型与存储：`grant_id`、`merchant_id`、`subject_id`、`purpose`、`resource_scope_id`、`grant_epoch`、`status`、`expires_at`、`policy_version`。
   - 授权、撤销、epoch 递增、过期；记忆/历史/经验/通知用途分开。

3. **ContextGuard**
   - 读取前、工具调用前、provider attempt 前、发布前检查：权限、grant epoch、来源可用性、版本。
   - 失败类型化错误；旧快照/旧游标/旧上下文失效。
   - 与后续撤权、封存、接管共享版本检查；不实现业务逻辑，只提供守卫。

4. **独立迁移账本**
   - 通用账本：`version`、`applied_at`、`checksum`、幂等。
   - 三个独立账本注册到 `state.sqlite`；迁移失败 fail-closed，不部分应用。
   - 在已有 `state.sqlite` 上可重复执行。

5. **单写者所有权**
   - `instance_ownership` 表：`merchant_id`、`owner_id`、`fencing`、`heartbeat_at`、`lease_expires_at`、`state`。
   - `acquire` / `renew` / `release` / `assertOwner`。
   - 启动 CAS 获取；第二进程失败 fail-closed；租约过期可接管，fencing 递增；旧 owner 提交被拒。
   - 实例级所有权与 followup 任务级租约分开。

6. **功能开关**
   - `learning_enabled`、`memory_enabled`、`jobs_enabled`、`customer_delivery_enabled`，默认 `false`。
   - 严格解析；非法值启动失败；关闭时不改变现有路径行为。

7. **测试**
   - 迁移幂等、checksum 冲突、已有库升级。
   - 双连接单 owner、第二进程拒绝、租约接管、旧 owner 提交拒绝。
   - 开关默认关闭、非法配置拒绝。
   - 现有相关测试不回归。

**M1 完成条件：** `npm run typecheck`、`npm run lint`、相关定向测试通过；报告改动、表结构、测试结果、未决问题；停下等确认。

### M2 TOP1 经验学习

- QuestionSpec v1：`sku`/`quantity`/`unit` 槽位、模板、`ask_registered_question`、发布器渲染、旧 reason/renderer 兼容。
- `learning.submitCorrection` / `promoteCorrection`：纠正、案例、候选状态机、PII/底价/凭据预检。
- 候选、评测、审核、发布、回滚、撤回：冻结编译产物、hash、generation、CAS、REVOKED、7 天/24 小时期限。
- 评测：20 案例 ×3 次 × 基线/候选；3/3 通过；硬门 0。
- `skill_summaries` 注入、`load_reception_skill`、2 技能/3000 字上限、未绑定拒绝。
- 验收 A01–A20。

### M3 TOP2 客户记忆

- 组织/代理范围 subject binding；`person`/`verified_person` 关闭。
- 一次性确认短语/卡片回执、grant、删除入口、客户自助列表。
- 客户记忆独立域：candidate/active/needs_review/superseded/deleted/expired；证据、置信度、有效期、epoch。
- 历史检索：SQLite FTS5 中文验证；5 片段/2000 字；游标 5 分钟；unavailable 不伪装 no_match。
- 删除：DeletionJob、封存、data_epoch、DerivationEdge、逐存储面状态、备份恢复前重放。
- 验收 B01–B16。

### M4 TOP3 经营任务

- EventInbox、AutomationRule、`automation.prepareRule` 双模式、activate/pause/runOnce/query/list/get。
- 调度：内存 timer 只唤醒，`next_due_at` 为到期依据；occurrence 唯一；错窗补最新；missed_count。
- 执行：FollowUp 状态机、CAS 领取、fencing、`commitInternalResult` 单事务、UNKNOWN 只读核对。
- 预算：20 run/天、100000/12000 token、5000/600 预留、模板优先级、budget_exhausted。
- 工作台产物：日报、草稿、待办；P0 不发送客户。
- 验收 C01–C16。

### M5 试点发布准备

- 配置、feature flags、观测指标、预算账本、运行手册、回退演练。
- 64 条验收证据模板；真实模型回放；旧二进制守卫测试。
- 不部署、不发布；只产出可执行的发布/回退检查表。

### M6 P1 客户外发（默认不做）

- 只有 M5 通过并明确批准后才开始。
- 客户订阅、渠道绑定、冻结载荷、退订、回执、顺序、UNKNOWN。
- 缺任何一项保持工作台草稿。

## 五、工程约束

- ESM，内部 import 带 `.js`；Node >= 22；`node:sqlite`；零新运行时依赖。
- 文件头 Apache 2.0；中文 JSDoc；类型化错误 + `code`；fail-closed。
- 所有时间 RFC3339 UTC；业务时区默认 `Asia/Shanghai`；金额用现有核心单位。
- 严格 schema，未知字段拒绝；枚举不可由模型扩展。
- 每张客户表必须有带 merchant/subject 作用域的查询函数；禁止通用 `getById` 给接待调用。
- 模型运行在业务事务之外；模型/外网请求不能进 `commitInternalResult` 事务。
- 不把局部事务描述为全链路恰好一次；跨存储用 command_id、回执、恢复。
- 不记录客户原文、密钥、底价到日志；trace 记录版本和原因码，不记录隐藏推理。

## 六、测试与证据

- 每个里程碑必须有确定性单元/集成测试；测试可离线运行。
- 独立验收由 DeepSeek harness 执行；你的本地测试是可重复证据，不能替代独立验收。
- 每完成一条验收用例，记录：用例 ID、输入、预期、实际、trace/回执、持久对象、版本。
- 没跑或跑不过的用例标 `pending` 或 `failed`；禁止用 fake provider 结果冒充真实模型回放。
- 运行命令：
  - `npm run typecheck`
  - `npm run lint`
  - 相关 `npx vitest run <files>`
  - 定向通过后再跑 `npm run verify`
- 报告必须贴真实命令与结果；不要写“应该通过”。

## 七、报告格式（每个里程碑结束）

```
里程碑：M1
改动文件：
- ...
新增/修改表：
- ...
接口/配置：
- ...
测试命令与结果：
- 命令：... 结果：...
验收用例：
- A01：pass / fail / pending，证据：...
未决问题：
- ...
风险/回退：
- ...
下一步建议：
- ...
```

## 八、停止规则

- 本轮只做 M1，完成即停；不要开始 M2。
- 设计文档与现有代码冲突：以现有代码为准，记录差异和最小安全假设。
- 需求不明确：选择最小、最保守、可回退的实现，记录假设；不要扩大范围。
- 缺依赖/权限/测试环境：停止并报告，不要伪造。
- 发现必须改 KNP wire 或公开协议：停止并报告，不要自行改。
- 任何 commit/push/deploy 冲动：停止；这不是本轮任务。
