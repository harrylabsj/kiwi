# Kiwi 商家 AI 智能体 P0a — AC01–AC60 验收映射

日期：2026-11-03　分支：`feat/merchant-ai-reception-p0a`（未 push）
依据：`~/coding/docs/kiwi/Kiwi_商家AI智能体设计_v1.1_2026-11-03.docx` 附录 B.7（D01–D16）

## 口径

按设计 §22：仅填写映射不等于通过。本表状态分四档：

- **机制就绪**：P0a 代码已实现且有自动化测试证据（列出测试文件）。契约类 AC
  的"真实部署证据"（真实 provider trace、线上版本）仍属 M6 待执行。
- **部分就绪**：核心机制已有，AC 要求的完整证据链或子项未齐（注明缺什么）。
- **P0b 范围外**：B.7 决议明确不属 P0a（注明依据）。这些路径在 P0a 未启用，
  不是用 "N/A" 隐藏已启用路径。
- **已知缺口**：D 决议要求 P0a 具备但当前实现未覆盖，需在发布前补齐或降级决议。

## Q15 质量场景（D13）

- 数据集：`tests/reception-q15.scenarios.ts`（Q01–Q15，六层各 2–3 例，预标注目标/脚本/检查点/关联 AC）。
- 运行器：`tests/reception-q15.test.ts`（脚本化候选 + 真实引擎，每回合过全局硬门：locale、底价/边界泄露、reply_seq、outbox、追问上限）。
- **边界**：脚本化候选只验证系统侧行为；模型理解质量须按 §22.1 用真实 provider
  每例重复 3 次评分，属 M6 待执行。P0a 首发每例 1–2 次输入（§22.1 允许 2–4 次），
  分支变体随 P0b 扩到 60 例时补齐。

## 映射表

### 接待智能（AC01–AC05）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC01 | 部分就绪 | 缺 SKU/空消息追问：`merchant-reception.test.ts`、Q04/Q05；真实 provider 回合 trace 待 M6 |
| AC02 | P0b 范围外 | P0a 无商品搜索/推荐工具（B.8-2 只要求候选经商品源确认）；不编造由"无 free_text + 发布校验"兜底：`merchant-reception-publish.test.ts`、Q06 |
| AC03 | 部分就绪 | 会话持久化 + revision 递增 + 重启恢复（重开文件）：`merchant-reception.test.ts`、Q07；指代消解质量待真实模型评分 |
| AC04 | P0b 范围外 | "当前需求/未来意向"区分需要意向建模，P0a 只提取当前 quantity 与 target_price 候选 |
| AC05 | P0b 范围外 | 知识库问答工具未在 P0a 范围 |

### 需求澄清（AC06–AC10）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC06 | 部分就绪 | unit 仅作候选透传、由商品源口径渲染；无换算表，"两箱"歧义澄清依赖模型候选质量（待 M6 评分） |
| AC07 | P0b 范围外 | 需求模型无时限槽位，相对日期解析未实现 |
| AC08 | P0b 范围外 | 无搜索工具，同名 SKU 选择场景不出现 |
| AC09 | **已知缺口** | D03/B.8-2 要求"多商品请求明确提示并请买家选择，禁止只取第一项"；当前 interpreter 只有单 `sku` 候选字段，引擎无多商品检测，存在静默只取第一项的风险。需发布前补齐（如候选加 `skus[]` 或明确降级决议） |
| AC10 | 机制就绪 | 需求变更 revision 递增：`conversation-store.ts`、Q07；批准失效：`merchant-approval-invalidation.test.ts` |

### 事实与履约（AC11–AC15）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC11 | 机制就绪 | 事实快照 + 内容 digest 版本 + 有效期：`publish.ts`、`merchant-reception-publish.test.ts`、Q01 |
| AC12 | 机制就绪 | 库存三态（足/不足/待确认）：`engine.ts` renderFacts、Q01/Q02；库存写接口不存在于接待路径 |
| AC13 | 机制就绪 | 过期事实发布拒绝（expired）：Q08、`merchant-reception-publish.test.ts`；双权威源冲突 P0a 单源不出现 |
| AC14 | 机制就绪 | 仅"预计交期"表述（D11）：Q03、`merchant-delivery-terms.test.ts` |
| AC15 | P0b 范围外 | FulfillmentEvaluator 与替代方案推荐属 P0b（D11） |

### 商务数据与文本一致（AC16–AC20）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC16 | 机制就绪 | 确定性计价既有测试覆盖；接待只渲染商品源价格，不自行计价：Q01 |
| AC17 | 机制就绪 | 无 free_text 槽位，草稿数字无法进入回复：`publish.ts`、`merchant-reception-publish.test.ts` |
| AC18 | 机制就绪 | 结构化字段权威于模型候选：`merchant-inquiry-reception.test.ts`、Q12/Q14 |
| AC19 | 机制就绪 | CNY/数值边界校验走既有确定性路径：`merchant-handler-accept-validation.test.ts` |
| AC20 | 机制就绪 | 底价不进回复（全局硬门）：Q15、`merchant-reception-active.test.ts`；KNP 摘要走既有 JCS |

### 身份与权限（AC21–AC25）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC21 | 机制就绪 | 匿名可问答；接待不创建 KNP Offer/接受：`engine.ts`（next_step 仅提示发 RFQ） |
| AC22 | 机制就绪 | 既有签名/角色校验：`a2a-signature-auth.test.ts` 等；接待无代理签名能力 |
| AC23 | 部分就绪 | 会话/审批/outbox 按 merchant+主体+context 隔离、跨租户引用拒绝：`merchant-reception-active.test.ts`、`merchant-reception-publish.test.ts`；第二实例隔离待 D16（B.8-5：未部署前不得宣称通过） |
| AC24 | 机制就绪 | 注入文本只作数据、接待无 shell/网络工具、守卫在模型外：Q15 |
| AC25 | 机制就绪 | 既有管理面与凭据测试（`a359-credentials-*` 等）；接待不暴露配置写路径 |

### 审批与协议（AC26–AC30）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC26 | 机制就绪 | 越界还价转审批、不泄露边界/底价：`merchant-reception-active.test.ts`、Q09/Q10 |
| AC27 | 机制就绪 | 批准前重验既有覆盖：`merchant-approval-invalidation.test.ts`、`merchant-policy-runtime.test.ts`、`merchant-source-facts-revalidation.test.ts` |
| AC28 | 机制就绪 | 单次执行/并发批准既有覆盖：`merchant-negotiation-approval.test.ts`；过期不可批准：Q11 |
| AC29 | 机制就绪 | ConditionalOffer 冲突走既有确定性 evaluator（接待不生成条件报价） |
| AC30 | 机制就绪 | accept 仍由买家触发、确定性 fast path 既有覆盖；接待不产生接受动作 |

### 恢复与故障（AC31–AC35）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC31 | 机制就绪 | 模型异常→澄清/结构化事实路径：Q12；30s 硬截止→service_busy：Q13 |
| AC32 | 部分就绪 | token 预算准入/结算：`merchant-reception-budget.test.ts`；6 回合/12 工具已在 `config.ts` 冻结，P0a 引擎单模型调用、无工具循环，天然不超限，完整计数待工具循环落地 |
| AC33 | 机制就绪 | 未知用量按预约额全额结算不记零：`merchant-reception-budget.test.ts` |
| AC34 | 部分就绪 | response_id 幂等 outbox：`reply-outbox.ts`；messageId 级幂等走既有 A2A 覆盖 |
| AC35 | P0b 范围外 | P0a 同步投递即 dispatched，崩溃窗口/第二实例接管属 P0b（outbox 的 unknown 对账面已留） |

### 部署、回归与质量（AC36–AC40）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC36 | 部分就绪 | 健康探针（配置/连接/非空输出）：`probe.ts`、`reception-probe.test.ts`；管理界面展示待 WorkBuddy 侧 |
| AC37 | 机制就绪 | 随主包锁定依赖发布；接待无动态工具加载 |
| AC38 | 机制就绪 | 接待默认关闭（`KIWI_MERCHANT_RECEPTION` 未设=off）；既有 A2A/KNP 回归全绿 |
| AC39 | 部分就绪 | Q15 数据集 + 运行器已建（本文）；真实 provider 60 例×3 次评分待 M6 |
| AC40 | P0b 范围外 | /ops 会话级接管未在 P0a 实现（D09 的操作面待 WorkBuddy 侧落地） |

### 取消与运行边界（AC41–AC45）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC41 | P0b 范围外 | P0a 无 run epoch/取消语义（单次 respond 同步完成） |
| AC42 | 机制就绪 | 无草稿旁路通道；计划先校验后渲染：`publish.ts` |
| AC43 | 部分就绪 | 审批 pending 持久化重启恢复：`negotiation-approvals.ts`；分享撤权场景 P0b |
| AC44 | 机制就绪 | 从 provider usage 采真实用量、未知不记零：`inquiry-interpreter.ts`、`merchant-reception-budget.test.ts` |
| AC45 | 部分就绪 | 配置不经 process.env 切商家（接待 deps 注入）；第二商家并发验证待 D16 |

### 统计、容量与删除（AC46–AC50）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC46 | 部分就绪 | 30s 硬截止实现：Q13；P95 分层报告口径待 M6 统计面 |
| AC47 | P0b 范围外 | episode 对象与等待口径未在 P0a 实现 |
| AC48 | P0b 范围外 | 多商家平台配额调度属 P0b（P0a 单商家实例，B.2） |
| AC49 | 部分就绪 | 预算存储故障→拒绝+降级事件：`merchant-reception-budget.test.ts`；配额权威/许可恢复 P0b |
| AC50 | 部分就绪 | 会话 30 天惰性清理：`conversation-store.ts`（D10）；联系字段 P0a 未收集（config 已冻结口径）；删除作业 P0b |

### 留存、语言与质量（AC51–AC55）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC51 | P0b 范围外 | 删除后重放/墓碑属 P0b（D10：P0a 不做加密擦除） |
| AC52 | P0b 范围外 | 备份恢复删除登记属 P0b |
| AC53 | 机制就绪 | 非中文→中文范围提示；结构化字段不受语言影响：Q14、`merchant-reception.test.ts` |
| AC54 | 部分就绪 | Q15 运行器分母固定、硬门不平均；完整 180 试跑评分口径待 M6 |
| AC55 | 机制就绪 | reply_seq 发布事务内严格递增：`merchant-reception-active.test.ts`、Q07；并发慢前序属 P0b |

### 投递、审批与删除竞态（AC56–AC60）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC56 | P0b 范围外 | P0a 同步投递无排队；unknown 状态枚举已留在 outbox |
| AC57 | 机制就绪 | 15 分钟到期只失效 + 通知链：`reception-m4-approval-sweep.test.ts`、Q11 |
| AC58 | 部分就绪 | approve 过期守卫（等于 deadline 归过期侧）：`merchant-reception-active.test.ts`；跨提交竞态既有覆盖 |
| AC59 | 机制就绪 | ttl 创建时固化 expires_at，不随配置调长溯及：`merchant-reception-active.test.ts` |
| AC60 | P0b 范围外 | 删除封存并发属 P0b |

## 汇总

- 机制就绪：24 条　部分就绪：14 条　P0b 范围外：21 条　**已知缺口：1 条（AC09）**
- 发布前必须处理：AC09 多商品提示（D03 是 P0a 决议，当前实现有静默只取第一项风险）。
- 不得宣称通过：AC23/AC45 的多实例隔离（D16 第二商家未建，B.8-5）；
  AC39/AC54 的质量分（真实 provider 评分未执行）。
