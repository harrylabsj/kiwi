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
| AC02 | 部分就绪 | 本店商品候选搜索 + `compare_products` 只读比较；`recommend_option` 仅允许可验证理由（公开价最低/库存可覆盖）：`merchant-reception-search.test.ts`、`merchant-reception-recommend.test.ts`；用途匹配与商品知识解释仍待 M6/M3 后续 |
| AC03 | 部分就绪 | 会话持久化 + revision 递增 + 重启恢复（重开文件）：`merchant-reception.test.ts`、Q07；指代消解质量待真实模型评分 |
| AC04 | P0b 范围外 | "当前需求/未来意向"区分需要意向建模，P0a 只提取当前 quantity 与 target_price 候选 |
| AC05 | P0b 范围外 | 知识库问答工具未在 P0a 范围 |

### 需求澄清（AC06–AC10）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC06 | 机制就绪 | 单位必须一致、命中 `commerce.unit_aliases`，或按 `commerce.unit_package_factors` 换算；换算保留原数量/单位（need.inputQuantity/inputUnit）并渲染依据；无规则时澄清：`merchant-reception-facts.test.ts`、`profile.test.ts` |
| AC07 | P0b 范围外 | 需求模型无时限槽位，相对日期解析未实现 |
| AC08 | 部分就绪 | 搜索多命中会列出候选并要求买家明确选择（不按价格/模型置信度自动选）：`merchant-reception-search.test.ts`；规格差异比较待商品知识工具 |
| AC09 | 机制就绪 | 多商品请求明确提示并请买家选择（`skus` 候选 + `multiple_skus` 澄清，候选持久化后可用“第一个”选择）；KNP RFQ/offer/counter_offer 多行商品在推进相位前 decline `field_unsupported`，不静默只取 items[0]：`merchant-multi-item.test.ts` |
| AC10 | 机制就绪 | 需求变更 revision 递增：`conversation-store.ts`、Q07；接待侧改数量后旧批准失效（新 pending 取代 approved，数量不匹配不消费）：`merchant-reception-active.test.ts`；KNP 旧许可重验：`merchant-approval-invalidation.test.ts` |

### 事实与履约（AC11–AC15）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC11 | 机制就绪 | 事实快照 + 内容 digest 版本 + 有效期：`publish.ts`、`merchant-reception-publish.test.ts`、Q01 |
| AC12 | 机制就绪 | 库存三态（足/不足/待确认）：`engine.ts` renderFacts、Q01/Q02；库存写接口不存在于接待路径 |
| AC13 | 机制就绪 | 过期事实直接澄清、不报价、不创建审批；Pi facts 工具返回 `facts_stale`：Q08、`merchant-reception-facts.test.ts`；双权威源冲突 P0a 单源不出现 |
| AC14 | 机制就绪 | 仅"预计交期"表述（D11）：Q03、`merchant-delivery-terms.test.ts` |
| AC15 | P0b 范围外 | FulfillmentEvaluator 与替代方案推荐属 P0b（D11） |

### 商务数据与文本一致（AC16–AC20）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC16 | 机制就绪 | 确定性计价既有测试覆盖；接待只渲染商品源价格并按事实声明含税/含运费，未知时明确“待确认、标价不等于应付总额”：Q01、`merchant-reception-facts.test.ts` |
| AC17 | 机制就绪 | 无 free_text 槽位，草稿数字无法进入回复：`publish.ts`、`merchant-reception-publish.test.ts` |
| AC18 | 机制就绪 | 结构化字段权威于模型候选：`merchant-inquiry-reception.test.ts`、Q12/Q14 |
| AC19 | 机制就绪 | CNY/数值边界校验走既有确定性路径：`merchant-handler-accept-validation.test.ts` |
| AC20 | 机制就绪 | 底价不进回复（全局硬门）：Q15、`merchant-reception-active.test.ts`；KNP 摘要走既有 JCS |

### 身份与权限（AC21–AC25）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC21 | 机制就绪 | 匿名可问答；接待不创建 KNP Offer/接受：`engine.ts`（next_step 仅提示发 RFQ） |
| AC22 | 机制就绪 | 既有签名/角色校验：`a2a-signature-auth.test.ts` 等；接待无代理签名能力 |
| AC23 | 部分就绪 | 会话/审批/outbox 按 merchant+主体+context 隔离、跨租户引用拒绝：`merchant-reception-active.test.ts`、`merchant-reception-publish.test.ts`；本轮仅 Veyquo 单商家；多实例隔离不在范围（B.8-5） |
| AC24 | 机制就绪 | 注入文本只作数据、接待无 shell/网络工具、守卫在模型外：Q15 |
| AC25 | 机制就绪 | 既有管理面与凭据测试（`a359-credentials-*` 等）；接待不暴露配置写路径 |

### 审批与协议（AC26–AC30）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC26 | 机制就绪 | 越界还价转审批、批准后买家下一轮一次性消费批准价、不泄露边界/底价：`merchant-reception-active.test.ts`、Q09/Q10 |
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
| AC36 | 机制就绪 | 健康探针（配置/连接/非空输出）已接入 `/ops/v1/reception/status|probe`：`probe.ts`、`reception-probe.test.ts`、`merchant-negotiation-ops.test.ts`；WorkBuddy 页面展示属宿主侧 |
| AC37 | 机制就绪 | 随主包锁定依赖发布；接待无动态工具加载 |
| AC38 | 机制就绪 | 接待默认关闭（`KIWI_MERCHANT_RECEPTION` 未设=off）；既有 A2A/KNP 回归全绿 |
| AC39 | 部分就绪 | Q15 数据集 + 脚本化运行器；真实 provider 已跑 13 场景×3=39 episodes 全过（`reception-q15-real.test.ts`）；完整 60 例×3 待 P0b |
| AC40 | P0b 范围外 | /ops 会话级接管未在 P0a 实现（D09 的操作面待 WorkBuddy 侧落地） |

### 取消与运行边界（AC41–AC45）

| AC | 状态 | 证据 / 说明 |
|----|------|-------------|
| AC41 | P0b 范围外 | P0a 无 run epoch/取消语义（单次 respond 同步完成） |
| AC42 | 机制就绪 | 无草稿旁路通道；计划先校验后渲染：`publish.ts` |
| AC43 | 部分就绪 | 审批 pending 持久化重启恢复：`negotiation-approvals.ts`；分享撤权场景 P0b |
| AC44 | 机制就绪 | 从 provider usage 采真实用量、未知不记零：`inquiry-interpreter.ts`、`merchant-reception-budget.test.ts` |
| AC45 | 部分就绪 | 配置不经 process.env 切商家（接待 deps 注入）；本轮仅 Veyquo 单商家；多商家并发不在范围 |

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
| AC54 | 部分就绪 | Q15 运行器分母固定、硬门不平均；真实 provider 39 试跑已报告；完整 180 试跑口径待 P0b |
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

- 机制就绪：32 条　部分就绪：15 条　P0b 范围外：13 条　已知缺口：0 条
- AC09 已补齐（`merchant-multi-item.test.ts`，2026-11-03）。
- 不得宣称通过：AC23/AC45 的多实例隔离（本轮仅 Veyquo 单商家，B.8-5）；
  AC39/AC54 的完整质量分（真实 provider Q15 子集 39/39 已执行；完整 60 例/180 试跑未执行）。

## 2026-11-03 评审修复记录

- **审批回环（AC26/AC57/AC58）**：商家在 `/ops` 批准后，接待引擎在买家下一轮按
  context + SKU + 数量/单位匹配并要求目标价不高于批准价，一次性消费批准候选，
  以“商家确认价（仅本次）”渲染；重复询问不会继续给批准价。数量/单位变化不消费，
  且新的待批请求会把同磋商同 SKU 的旧 approved 置 expired。
- **多商品序号**：`multiple_skus` 澄清时持久化候选列表，买家可用“第一个/第二款/选2”
  选择；选定后清空候选。KNP RFQ/offer/counter 的多行商品校验前移到相位推进之前，
  被拒请求不再改写 active offer/相位。
- **结构化主题**：KNP inquiry 的 `questions[].code` 映射为 price/stock/delivery，
  接待只渲染被问到的主题；验签标记 `identityVerified` 已透传到接待引擎。
- **测试**：新增审批消费/改数量失效/序号选择/结构化主题/验签透传/RFQ·offer·counter
  多行商品顺序校验用例；reception + negotiation 相关 16 个文件 215 条全绿。

## 2026-11-03 M5 接入与 M2 第一片

- `/ops` 新增 `GET /ops/v1/reception/status`（模式、日预算已用/上限、降级事件、
  审批计数）与 `POST /ops/v1/reception/probe`（配置/连接/正文非空三层）；
  loopback + Bearer 鉴权沿用既有门。
- M2 第一片：`MerchantProductSource.searchProducts` 按本店公开商品标题/SKU
  做候选搜索；唯一命中直接按事实回答，多命中列出候选并持久化，买家可用
  “第一个”继续；零命中/搜索失败回固定追问，不编造商品。
- 测试：`merchant-reception-search.test.ts` 4 条、`merchant-negotiation-ops`
  接待端点 1 条；reception/negotiation 相关 17 个文件 222 条全绿。
- 未启用：watch 生产开关、WorkBuddy 独立推送、Pi 工具循环与商品比较/推荐。

## 2026-11-03 M2 第二片：Pi 工具循环

- 新增 `src/a2a/reception/agent-runtime.ts`：`KIWI_RECEPTION_RUNTIME=pi` 时启用
  受控工具循环（`search_products` → `get_commercial_facts` → `propose_need_patch`
  → `propose_reply`）；工具白名单、参数上限、propose_reply 后禁止再调用；
  超时/无计划自动回退确定性解释器路径。
- 事实只以 `fact ref` 进入 ResponsePlan，发布器仍校验租户/版本/可见性/有效期；
  模型没有改价、改库存、发协议或批准的能力。
- 默认仍为 `deterministic`；fake provider 下强制确定性并告警。
- 测试：`reception-agent-runtime.test.ts`（脚本化 fake provider 完整工具链、
  block 白名单、引擎使用 agent 计划）；reception/negotiation 18 个文件
  225 条全绿。
- 未完成：Pi usage 接入日预算、工具级指标、真实 provider Q15 评分。

## 2026-11-03 M2 收尾

- Pi 用量接入：每个模型回合 `turn_start` 申请预算 lease、`turn_end` 按实际
  output tokens 结算；超时/中止未结算的 lease 按未知用量保留（不记零）。
  工具级指标（步数、各工具调用次数、usage、quotaRejected）写入
  `<dataDir>/a2a/reception-agent-metrics.jsonl`。
- 工具预算：`maxToolAttempts=12`（config 冻结值）在 beforeToolCall 强制。
- 字段证据：`ReceptionNeed.evidence` 记录 sku/quantity/unit 的
  `source_message_id`、`observed_at`、`source=structured|model`；只在买家本轮
  明确给出字段时签发，跨轮沿用未变更字段。
- 留存作业：`runReceptionRetention` 清理 30 天会话与 90 天用量记录，节点启动
  与每 6 小时执行；联系字段 P0a 未收集（0）。
- 测试：agent runtime 5 条（工具链/预算拒绝/批准跳过/指标）、retention 3 条、
  evidence 1 条；reception/negotiation 18 个文件 196+ 条全绿。
- M3/M6 仍未完成：商品比较/推荐理由、税费运费、真实 provider Q15 评分、部署。

### M2 收尾补充

- 新增 `compare_products` 工具（最多 3 个 SKU，只读公开价格/库存/交期），
  模型可在选择前比较候选；仍不能生成 `recommend_option` 的推荐理由块
  （AC02 保持部分就绪）。
- Pi 工具预算在 `beforeToolCall` 强制 `maxToolAttempts`（config 12）；指标
  记录各工具调用次数。
- 配置新增 `KIWI_RECEPTION_RUNTIME=pi`（默认 deterministic），配置测试覆盖。

## 2026-11-03 M3 第一片：事实时效、单位与税费

- **事实时效（AC13）**：商品 `valid_until` 过期时接待直接澄清“商品数据已过期”，
  不报价、不登记审批；Pi 的 `get_commercial_facts` 同样返回 `facts_stale`。
- **单位/包装（AC06）**：买家单位必须与商品源单位一致，或命中商家声明的
  `commerce.unit_aliases`；否则澄清“该商品按 X 售卖”，不做盒=件猜测。
  包装倍率仍未建模（需要商家声明换算规则）。
- **税费/运费（AC16）**：商品源未声明含税/含运费时，回复明确“税费信息待确认”
  “运费信息待确认，标价不等于应付总额”；声明时按事实表达，不再把商品小计
  说成应付总额。
- 测试：`merchant-reception-facts.test.ts` 5 条；reception/negotiation 20 个
  文件 236 条全绿；Q08 更新为“过期事实澄清”。
- 仍未完成：包装倍率换算、`recommend_option` 推荐理由、真实 provider 评分、部署。

## 2026-11-03 M3 收尾

- **包装换算**：`commerce.unit_package_factors`（如 `{ 箱: 12 }`）显式声明后，
  接待把 2 箱换算为 24 piece，并在回复中写明“原 2 箱，按 1 箱 = 12 piece 换算”，
  同时持久化 `need.inputQuantity/inputUnit`；未声明倍率时仍澄清，不猜。
- **推荐块**：`recommend_option` 只允许 `lowest_public_price` / `in_stock`，发布器
  校验被推荐快照与比较快照；无法证明时整块拒绝（`unverified_claim`）。
  `compare_products` 为每个候选注册 fact ref，模型可据此构造推荐。
- 测试：`merchant-reception-facts.test.ts` 7 条、`merchant-reception-recommend.test.ts`
  4 条、`profile.test.ts` 新增包装字段校验；reception/negotiation 22 个文件
  288 条全绿。
- M3 仍未完成：目的地级履约（D11 明确放 P0b）、商品用途/知识解释、真实 provider
  评分与部署。

## M6-A 真实 provider Q15 评分（2026-11-03）

- 范围：仅 Veyquo 单商家；真实 DeepSeek interpreter + 确定性接待引擎。
- 执行：13 个可执行场景 × 3 次 = 39 episodes；Q12/Q13 依赖故障注入，真实
  provider 下跳过（脚本化 Q15 已覆盖）。
- 结果：**39/39 通过**，六层全部达标：
  - 理解/解释 9/9、澄清 9/9、多轮/时间 6/6、受控协商 6/6、故障/待批 3/3、
    注入/越界 6/6。
- 过程中发现并修复：模型偶发漏抽中文数量（“十盒”），已加确定性中文数量
  兜底（不把“98 一件”误判为数量）。
- 边界：这是 Q15 子集，不是文档 60 场景全量；Q12/Q13 的故障注入仍以脚本化
  用例为准。多实例隔离（AC23/AC45）不在本轮 Veyquo 单商家范围。

### M6 真实 Pi 路径冒烟

- `KIWI_RECEPTION_RUNTIME=pi` 的真实 provider 冒烟通过：模型经
  search → facts → propose_reply 工具循环输出公开价 110.00 CNY，未泄露底价。
- 命令：`KIWI_RECEPTION_REAL_E2E=1 npx vitest run tests/reception-agent-real.test.ts`。
- 范围：仅 Veyquo 单商家；第二商家/多实例隔离不在本轮。
