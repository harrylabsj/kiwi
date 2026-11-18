# Kiwi 商家智能体 TOP1-3 设计 v1.0 修订清单与 M0 决策项

- 对应审阅意见：`Kiwi_商家智能体TOP1-3设计_v1.0_审阅意见_2026-11-15.md`（R01–R13）
- 对应设计文档：`Kiwi_商家智能体TOP1-3设计_v1.0_2026-11-15.docx`
- 核对基线：Kiwi `0.12.30`，提交 `366ef681800322446db21bd1b510c1d810964508`
- 日期：2026年11月15日

## 0 使用说明

本文件分三部分：

1. **A 修订清单**：逐条给出 R01–R13 在文档中的修改位置、建议插入或替换的文字、关闭标准。标记为“插入”的段落可直接回填；标记为“替换”的段落建议整段替换。
2. **B M0 决策项**：把 R01–R04 展开为必须在 M0 冻结前拍板的决策，含选项、推荐、证据要求和责任人建议。
3. **C 接口草案**：给出 R01–R04 及其连带接口的拟议 schema、状态机、错误映射和验收补充，供 M0 字段字典直接采用或裁剪。

文中的字段名、错误码和接口名均为拟议值；最终以 M0 冻结的字段字典和 schema 为准。新增接口不改变 KNP wire，不新增对外 action 或错误码。

---

## A 修订清单

### A0 一览

| 编号 | 文档位置 | 动作 | 关键修改 | 关闭标准 |
| --- | --- | --- | --- | --- |
| R01 | §9.1、§22.1 M0/M3、§22.2 M5 | 新增小节与 M0 决策 | 目标宿主主体能力 go/no-go；不能提供时降级 TOP2 P0 | M0 记录决议与证据；§1.1/§22 同步 |
| R02 | §9.2、§10.2、§17.1、§21.2、附录 A | 新增契约与验收 | 确认短语/卡片、回执、删除入口、客户自助 | 确认链可端到端验收；B13–B16 补齐 |
| R03 | §5.1、§5.2、§17.1、§21.1、附录 A | 新增接口 | `learning.submitCorrection` 与 PII 预检 | 商家纠正有唯一入口；A13–A16 补齐 |
| R04 | §7.1、§17.1、附录 A | 新增摘要注入与验收 | 技能摘要、允许加载目录、未绑定拒绝 | 模型可选技能；A17–A20 补齐 |
| R05 | §2 表、§12.1、§18.1、§22.1 M1 | 增补与对齐 | `purge_at` 绝对上限、删除登记、迁移账本 | M1 建表含 `created_at` 与登记表 |
| R06 | §7.2、§8、A05 | 增补 | QuestionSpec 与现有 reason/renderer 的合并规则 | 单一渲染真相；A05 覆盖旧路径 |
| R07 | §6.2、§20.1、M2 验收 | 替换 | 通过单元、分层报告、基线配对 | 评测口径冻结 |
| R08 | §13、§14.3、§18.2、附录 A | 增补 | 投影新鲜度与 `data_incomplete` | C15 补齐 |
| R09 | §13.2、§20.1、附录 A | 增补 | 模板配额/优先级与饥饿处理 | C16 补齐 |
| R10 | §17.1、§21 | 增补 | `memory.list`、`jobs.list`、`binding.link` 等 | 工作台与客户侧只用目录内接口 |
| R11 | 附录 A | 增补 | 6–8 条新验收 | 新用例有输入/预期/证据 |
| R12 | §4.2、§7.1、§10.1、附录 C | 替换/统一 | 字段命名、上限、过期语义 | 字段字典无歧义 |
| R13 | 附录 B、封面、图 1、§22.1 | 修订 | 引用、版本号、图注、工作量 | 文档一致性检查通过 |

### A1 R01 目标宿主主体能力

**位置：** §9.1 末尾新增 9.1.1；§22.1 M0 表新增一行；§22.2 M5 证据清单新增一条。

**插入文本（§9.1.1）：**

> **9.1.1 目标宿主主体能力（M0 决策）**
>
> 跨会话个人记忆的前提是目标买方宿主能够按人签发稳定、可验证、可撤销的 subject binding。M0 必须记录目标宿主、issuer、assurance class、受众绑定、密钥发现与轮换、撤销传播时限和负向测试结果。若宿主只能提供安装级或 token 级标识，则 `subject_kind` 只能登记为 `agent_scope` 或 `organization`，按组织范围披露和使用记忆，不得建立个人档案；个人跨会话记忆顺延为依赖宿主改造的 P1。没有上述证据时，TOP2 的 P0 结果表述调整为“已验证组织/代理范围内可跨会话接续”，并在 M5 证据中注明未启用个人记忆的原因。

**§22.1 M0 表新增行：**

| 工作包 | 主要产物 | 依赖与完成条件 |
| --- | --- | --- |
| M0 契约冻结 | 能力矩阵、48 条验收、字段和权限字典、**目标宿主主体能力决议** | 确认目标部署基线及实际启用模式；**主体来源 go/no-go 与降级方案已记录** |

**关闭标准：** M0 决议记录了“可用/不可用/仅组织范围”三选一、issuer 与撤销证据；§1.1 与 §22.1 M3/M5 的措辞与决议一致。若不可用，附录 A 增加一条“个人记忆未启用时，组织范围记忆仍可用”的验收。

### A2 R02 客户同意、确认与删除通道

**位置：** §9.2 末尾；§10.2 替换“受控确认卡片”一段；§17.1 增补接口；§21.2 增补客户侧通道；附录 A 增补 B13–B16。

**插入文本（§9.2 末尾）：**

> **确认通道。** 服务端创建 `grant_request` 时生成一次性确认短语，格式固定、绑定商家、会话访问权、用途、能力和有效期。接待回复按冻结模板展示拟保存内容、目的、期限和删除入口；客户在同一会话内原样回传短语才创建 grant。自由文本“好的/可以”不构成确认；模型只能创建新的 `grant_request`，不能把客户文本解释成 confirmed。买方宿主支持结构化卡片时，卡片回调必须携带 `grant_request_id` 与服务端签发的 `confirmation_ref`，并与文本路径共用同一校验。确认短语、回执和消费记录按最小控制记录保存。
>
> **删除通道。** 客户可随时通过同一入口请求删除单项记忆或停止跨会话记忆。服务端直接创建 `DeletionJob`，不经过模型判断；回复区分“已停止使用”和“副本仍在处理”，不承诺撤回对方已收到的内容。

**§10.2 替换句：**

> 原文：否则以受控确认卡片请客户确认。
>
> 建议：否则由服务端创建 `grant_request`，按 §9.2 的确认短语或宿主卡片请客户确认；确认前条目保持 `candidate`，不得进入模型可见的 `active` 集合。

**§17.1 增补（放在 `memory.confirm` 附近）：**

| 服务合同 | 关键输入 | 返回及授权 |
| --- | --- | --- |
| memory.grantRequest | purpose capabilities resource_scope ttl | grant_request_id 确认短语 有效期；服务端生成 |
| memory.grantConfirm | grant_request_id confirmation_ref session_proof expected_version | grant_id grant_epoch；一次性消费 |
| customer.deletionRequest | resource_scope expected_epoch | deletion_job_id；客户本人或受信委托 |
| memory.listMine | cursor limit | 当前主体有效记忆的最小字段；不返回其他主体 |

**§21.2 增补：**

> 客户侧入口必须落在目标宿主已支持的通道内：文本通道使用 §9.2 的确认短语与固定指令；结构化卡片通道使用同一 `grant_request_id` 和 `confirmation_ref`。工作台只展示当前商家有权限的客户记忆；客户自助列表只展示本人记忆，二者均不返回正文之外的其他主体信息。

**附录 A 增补：**

| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| B13 | 客户回传确认短语后重放同一短语，或在另一会话使用 | 首次创建 grant；重放与跨会话均拒绝；保留一次性消费记录 |
| B14 | 自由文本“好的/可以”，或模型把客户话解释为同意 | 不创建 grant；只能新建 grant_request；无 confirmed 记忆 |
| B15 | 客户确认前正文被篡改，或卡片回调篡改 grant_request_id/confirmation_ref | 摘要或绑定校验失败；不创建 grant；记录拒绝原因 |
| B16 | 删除请求发生在模型运行或待发草稿期间 | 先封存并递增 epoch；旧运行发布门被阻断；区分已停止与 pending 副本 |

**关闭标准：** 文本与卡片两条路径至少一条可端到端演示；自由文本不被当作确认；B13–B16 有证据。

### A3 R03 商家主动纠正

**位置：** §5.1 第一段后；§5.2 候选内容前；§17.1 `learning.createCase` 前；§21.1 增补入口；附录 A 增补 A13–A16。

**插入文本（§5.1 后）：**

> 商家主动纠正使用独立入口 `learning.submitCorrection` 提交：纠正正文有长度上限，可选关联已授权案例或基线版本；merchant、actor、权限由管理鉴权注入。服务端在入库前拒绝或脱敏客户标识、联系方式、凭据和价格底线；通过后形成 `correction_id` 与 revision，状态为 `DRAFT`。纠正只有在商家确认“形成案例”后才进入候选提炼；未形成案例的纠正不得直接生成候选。商家可编辑、撤回自己的纠正，编辑产生新 revision，旧候选标记 `STALE`。

**§17.1 增补：**

| 服务合同 | 关键输入 | 返回及授权 |
| --- | --- | --- |
| learning.submitCorrection | correction_text issue_tags case_refs? base_release_id? | correction_id revision；管理授权与 PII 预检 |
| learning.listCorrections | status cursor limit | 当前商家纠正摘要；不含原始敏感字段 |
| learning.promoteCorrection | correction_id expected_revision | case_id；商家确认形成案例 |

**§21.1 增补：**

> 经验改进页增加“提交纠正”入口：商家选择问题类型、填写纠正说明、可选关联案例；页面展示预检结果（是否含客户标识、价格底线或凭据）和“形成案例/仅保留草稿”两个动作。候选编辑后必须重新评测，页面明确提示旧评测与旧批准失效。

**附录 A 增补：**

| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| A13 | 纠正正文含手机号、详细地址、底价或凭据 | 入库前拒绝或脱敏；不进入模型；保留最小拒绝记录 |
| A14 | 商家只提交抽象纠正、未关联客户案例 | 可形成 case 与候选；不要求客户记忆或历史授权 |
| A15 | 商家 B 读取/编辑商家 A 的 correction_id | 访问拒绝；不泄露存在性与正文 |
| A16 | 候选已生成后商家编辑纠正 | 新 revision；旧候选 `STALE`；旧评测与批准失效 |

**关闭标准：** 商家纠正只有一个入口；A13–A16 有证据；工作台可完成“纠正→案例→候选”的完整路径。

### A4 R04 技能摘要与发现

**位置：** §7.1 “运行开始时固定 skill_bindings 数组”之后；§7.2 或 §17.1 说明摘要来源；附录 A 增补 A17–A20。

**插入文本（§7.1）：**

> 运行快照除 `skill_bindings` 外，还包含有界的 `skill_summaries`：每项只有 `skill_key`、一句话触发条件、`release_id`、`compiled_artifact_hash`、`generation`、`revocation_epoch` 和依赖契约版本，不含技能正文。摘要由服务端按商家、audience、SKU/类目、工具契约和发布状态过滤生成，最多 5 项、合计不超过 600 个中文字符；超出时按显式优先级截断并在运行记录中标注，不得由模型选择或扩展。模型只能从摘要中选择 `skill_key` 调用 `load_reception_skill`；加载时返回快照中的冻结产物，最多 2 个、正文合计不超过 3,000 个中文字符。未在快照中的 key、已撤回版本或超出上限的加载一律拒绝，不回退到 owner 技能目录。

**附录 A 增补：**

| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| A17 | 买家问题涉及单位歧义，快照含对应技能摘要 | 模型从摘要选择正确 skill_key；加载冻结产物；记录选择理由 |
| A18 | 模型请求未绑定、已撤回或 owner 目录中的技能 | `access_denied` 或 `unsupported_capability`；不读取正文；无目录兜底 |
| A19 | 单轮第 3 次加载，或正文合计超过 3,000 字 | 拒绝加载；不静默截断；记录预算原因 |
| A20 | 技能依赖未在运行白名单中的工具或未注册槽位 | 发布时 `unsupported_capability`；接待端不可加载 |

**关闭标准：** 模型能仅凭摘要选择技能；摘要与正文预算可测；A17–A20 有证据。

### A5 R05 留存与迁移账本

**位置：** §2 表新增“留存与删除”行；§12.1 增补 `purge_at` 公式；§18.1 指定迁移账本；§22.1 M1 增补产物。

**§2 表新增行：**

| 现有位置 | 已核实基础 | 本次增量 |
| --- | --- | --- |
| reception retention | 会话 30 天、联系字段 7 天、用量 90 天；按 `updatedAt` 滚动 | 采集后 90 天绝对上限、删除登记 180 天、独立确认偏好 90 天 |

**§12.1 增补：**

> 每条内容记录保存 `created_at` 与 `purge_at`，`purge_at = min(会话关闭时间 + 分类期限, 采集时间 + 90 天)`；后台读取、重试、摘要和索引更新不得延长 `purge_at`。迁移在现有 `state.sqlite` 中进行，客户记忆与删除登记使用独立迁移账本或明确分配的版本段；不得与 `merchant_ops_schema_migrations` 的版本号混用。

**关闭标准：** M1 建表含 `created_at`、`purge_at`、删除登记与备份登记；留存作业按绝对上限测试通过。

### A6 R06 QuestionSpec 与现有渲染

**位置：** §7.2 第一段后；§8 或 A05。

**插入文本：**

> QuestionSpec 不新建一套并行问题系统。P0 将现有 `missing_quantity`、`unit_mismatch` 等 reason 与固定文案登记为模板的初始版本，确定性引擎继续产生这些 reason；技能只能选择已注册的 `question_id`，不能自由生成问句。模板与旧渲染器由同一注册表维护：模板缺失时回退到现有固定文案，并在运行记录中标注 `renderer_fallback`。新增槽位必须同时注册 reason、模板、输入 schema 和证据规则。

**关闭标准：** 同一缺项只有一条渲染路径；A05 同时覆盖旧引擎路径与新模板路径。

### A7 R07 评测口径

**位置：** §6.2 替换“目标场景至少 22 次通过”一段；§20.1 增补分层报告。

**替换文本：**

> 场景通过定义为该场景 3 次回放全部通过且无硬门失败；目标层 8 个场景全部通过为合格，任一场景 1/3 或 2/3 通过均不计为通过。若需要保留失败余量，应在 M0 预登记“允许 1 个目标场景 2/3 通过”的例外及原因，不得在结果出来后调整。基线比较按场景配对：候选在任一预登记改善指标上优于基线且没有场景回退，才进入人工审核。分层报告目标/相邻/边界三类场景的分子、分母和失败例；不以总次数或平均分替代。

**关闭标准：** M2 评测报告按场景给出 3 次结果、硬门和配对比较；例外在 M0 预登记。

### A8 R08 投影新鲜度

**位置：** §13 模板表后；§14.3 评估结果；§18.2；附录 A 增补 C15。

**插入文本：**

> 接待 JSON 到 state.sqlite 的投影必须记录 `source_version`、`observed_at` 和最大允许延迟。规则评估在读取投影前检查新鲜度；投影缺口、延迟超限或游标不一致时，结果为 `data_incomplete`，附原因和缺失范围，不得记为 `no_change`。`data_incomplete` 可以生成确定性异常待办，但不调用模型编造完整日报；补读完成后按新 occurrence 重新评估。

**附录 A 增补：**

| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| C15 | 投影延迟超过上限、窗口内部分询价未投影 | 结果为 `data_incomplete`；日报标注缺失范围；不记为 no_change；补读后可重评 |

### A9 R09 预算分配

**位置：** §13.2 或 §20.1；附录 A 增补 C16。

**插入文本：**

> 每日后台 run 预算按模板分配：数据异常与未完成询价日报优先，缺项询问草稿次之，报价到期复核再次；每个模板有独立子上限和可借用的剩余额度。额度耗尽时任务保持 `PENDING` 并记录 `budget_exhausted`，工作台显示预计恢复时间和可执行的确定性降级；不得静默丢弃。前台接待的保留额度不得被后台任务占用。

**附录 A 增补：**

| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| C16 | 同日日报与大量草稿同时 eligible，额度不足 | 按优先级生成；其余保持 PENDING 并显示 budget_exhausted；前台额度未被占用 |

### A10 R10 接口目录

**位置：** §17.1 增补只读与自助合同。

**增补表：**

| 服务合同 | 关键输入 | 返回及授权 |
| --- | --- | --- |
| memory.list | subject_scope cursor limit | 当前商家有权限的记忆摘要；分页绑定 grant epoch |
| jobs.list | status cursor limit | 任务摘要；按商家隔离 |
| jobs.get | task_id | 触发原因、产物、审批与发送状态；不返回内部 token |
| binding.linkChallenge | source_session target_subject_assertion scope | challenge_id 5 分钟有效；一次性 |
| binding.linkConfirm | challenge_id proof | binding_id binding_epoch；双方范围验证 |
| customer.deletionRequest | resource_scope expected_epoch | deletion_job_id；客户本人或受信委托 |

**关闭标准：** §21 工作台与客户侧只使用目录内接口；没有临时旁路。

### A11 R11 验收补充

**位置：** 附录 A。建议新增 B13–B16、C15–C16、A17–A20、X11。

**X11 建议：**

| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| X11 | 回退到不识删除登记/封存记录的旧二进制 | 旧二进制禁止读取相关数据或先安装兼容补丁；删除与权限仍有效；记录冻结/补丁证据 |

### A12 R12 字段与上限

**统一建议：**

- `CustomerMemoryItem` 统一使用 `value_ref`；若允许内联值，另设 `inline_value` 并标为受限类型，不混用 `value`。
- `DataUseGrant` 增加 `merchant_id`，唯一约束为 `merchant_id + subject_id + purpose + resource_scope_id + grant_epoch`。
- 附录 C3 统一为 `context_snapshot_ref`；§4.2 对象名与字段字典一致。
- 明确 3,000 字是**单技能正文上限**；单轮 2 个技能合计仍为 3,000 字，超出时拒绝加载而不是截断。
- §6.3 的 24 小时发布期限改为 `min(批准时间 + 24h, expires_at)`；到期即 `approval_expired`。

### A13 R13 引用、版本、图与工作量

- 在 §2 回复计划发布器处补 `[S04]`；§7.1 SkillRegistry 处补 `[S06]`；§16.3 商家对话入口/恢复 worker 处补 `[S12]`。
- 封面改为“增量 v1.0（基于《Kiwi 商家 AI 智能体设计 v1.1》）”或升为 v1.2。
- 图 1 增加“买方宿主确认通道”与“ContextGuard/发布临界区”两条标注；否则读图会以为记忆直接进入接待。
- §22.1 增补粗粒度人日区间或“排期另行给出”，并标出 M3 的外部依赖（R01）。

---

## B M0 决策项

### B1 D-M0-01 目标宿主主体能力（R01）

| 项 | 内容 |
| --- | --- |
| 决策问题 | 目标买方宿主能否按人签发稳定、可验证、可撤销的 subject binding？ |
| 选项 A | 能：启用个人跨会话记忆；M3 按个人 subject 验收 |
| 选项 B | 只能提供组织/安装级标识：TOP2 P0 降级为组织/代理范围记忆 |
| 选项 C | 都不能提供：TOP2 P0 仅保留当前会话，个人记忆列为 P1 外部依赖 |
| 推荐 | 先按 A 做证据验证；验证不通过则选 B，不选“把共享标识当个人” |
| 必要证据 | issuer、受众绑定、assurance class、密钥发现/轮换、撤销传播时限、负向测试 |
| 责任人 | 产品 + 安全 + 宿主集成 |
| 关闭标志 | §1.1、§22.1 M3/M5 与决议一致；附录 A 有对应验收 |

**决议记录模板：**

> D-M0-01 决议：选择 A/B/C。目标宿主：____。issuer：____。assurance_class：____。撤销传播：____ 分钟。证据：____。若选 B/C，TOP2 P0 结果改为：____。

### B2 D-M0-02 客户确认通道（R02）

| 项 | 内容 |
| --- | --- |
| 决策问题 | 客户如何明确同意记忆，如何删除？ |
| 选项 A | 纯文本一次性短语；改动最小，适配现有 wire |
| 选项 B | 买方宿主结构化卡片；体验好，但依赖宿主改造 |
| 选项 C | A + B 双通道，共用 `grant_request_id` 与 `confirmation_ref` |
| 推荐 | C；若宿主改造未就绪，先交付 A 并把 B 列为 P1 |
| 必要证据 | 短语生成/消费/过期、重放拒绝、跨会话拒绝、卡片回调校验、删除回执 |
| 责任人 | 产品 + 接待后端 + 宿主集成 |
| 关闭标志 | B13–B16 有证据；自由文本不创建 grant |

### B3 D-M0-03 商家纠正入口（R03）

| 项 | 内容 |
| --- | --- |
| 决策问题 | 商家主动纠正走新接口还是复用 `createCase`？ |
| 选项 A | 新增 `learning.submitCorrection`，再 `promoteCorrection` 形成案例 |
| 选项 B | 扩展 `createCase` 接受 `correction_text` |
| 推荐 | A；职责清晰，PII 预检和状态机有独立挂载点 |
| 必要证据 | PII/底价/凭据预检、权限隔离、revision 与 STALE、工作台入口 |
| 责任人 | 商家工作台 + 学习服务 |
| 关闭标志 | A13–A16 有证据；纠正只有一个入口 |

### B4 D-M0-04 技能发现方式（R04）

| 项 | 内容 |
| --- | --- |
| 决策问题 | 模型如何知道可加载的技能？ |
| 选项 A | 运行快照注入 `skill_summaries`（推荐） |
| 选项 B | 增加只读 `list_reception_skills` 工具 |
| 选项 C | 预加载全部绑定技能（不推荐，违反按需与预算） |
| 推荐 | A；摘要小、无额外工具调用；B 可作为调试工具但不应成为主路径 |
| 必要证据 | 摘要生成与过滤、优先级截断、未绑定拒绝、两技能/3,000 字上限 |
| 责任人 | 接待运行时 + 技能目录 |
| 关闭标志 | A17–A20 有证据；模型能仅凭摘要选择技能 |

### B5 其他 M0 决策

| 编号 | 决策 | 推荐 |
| --- | --- | --- |
| D-M0-05 | 留存迁移账本归谁 | 客户记忆/删除登记使用独立账本或明确版本段，不与 ops 混用 |
| D-M0-06 | 评测“场景通过”定义 | 3/3 通过且无硬门；例外须 M0 预登记 |
| D-M0-07 | NL→规则候选入口 | 只返回候选并绑定商家确认；不直接启用 |
| D-M0-08 | 单写者所有权机制 | 明确使用独占锁/租约/DB 所有权之一，并纳入 M1 测试 |

---

## C 接口草案

### C1 主体断言与绑定（R01）

**宿主 → 服务端的断言：**

```json
{
  "schema_version": 1,
  "assertion_id": "asr_example",
  "issuer": "https://buyer-host.example",
  "audience": "merchant:merchant_example",
  "subject_ref": "opaque_person_ref",
  "subject_kind": "person",
  "assurance_class": "verified_person",
  "issued_at": "2026-11-15T02:00:00Z",
  "expires_at": "2026-11-16T02:00:00Z",
  "binding_epoch": 3,
  "proof": {
    "type": "jws",
    "key_id": "host-key-2026-11",
    "jws": "base64url..."
  },
  "delegation": {
    "agent_id": "agent_example",
    "on_behalf_of": "opaque_person_ref"
  }
}
```

**服务端合同：**

| 合同 | 输入 | 返回 | 规则 |
| --- | --- | --- | --- |
| `subject.bindVerified` | assertion、session_access_proof | binding_id、binding_epoch、subject_id、assurance_class | 校验 issuer/audience/签名/时间/撤销；只绑定声明范围 |
| `binding.revoke` | binding_id、expected_epoch、reason | 新 binding_epoch | 递增 epoch；撤销相关 grant 与上下文 |
| `subject.resolve` | 内部调用 | 有效 subject 或 anonymous | 无有效绑定时不建立个人档案 |

**准入规则：**

1. `issuer` 必须在商家/运营配置的可信列表中；模型和客户端不能提交 issuer。
2. `audience` 必须等于当前 merchant；跨商家断言拒绝。
3. 只有 `subject_kind=person` 且 `assurance_class=verified_person` 才启用个人记忆；`organization`/`agent_scope` 仅启用共享范围记忆；`session_only` 仅当前会话。
4. 断言过期、撤销、epoch 回退、签名失败均按 `access_denied` 处理，不泄露资源存在性。
5. 断言、绑定和撤销进入审计；原始断言按最小控制记录保存。

### C2 确认与删除（R02）

**`grant_request` 响应：**

```json
{
  "grant_request_id": "gr_example",
  "purpose": "customer_memory",
  "capabilities": ["read", "write", "confirm"],
  "resource_scope": "merchant:merchant_example/subject:subject_example",
  "expires_at": "2026-11-15T02:10:00Z",
  "confirmation_phrase": "确认记忆 A7K2",
  "channel": "a2a_text"
}
```

**`memory.grantConfirm` 输入：**

```json
{
  "schema_version": 1,
  "command_id": "cmd_example",
  "grant_request_id": "gr_example",
  "confirmation_ref": "sha256:...",
  "session_proof": "opaque_session_binding",
  "expected_version": 0
}
```

**规则：**

- 短语由服务端生成，绑定 `grant_request_id`、merchant、session、purpose、capabilities 和有效期；客户原样回传（仅允许去空白和统一标点）才创建 grant。
- 短语一次性消费；重放、跨会话、跨商家、过期均拒绝；失败不创建 grant，保留最小拒绝记录。
- 自由文本“好的/可以/同意”不创建 grant；模型只能调用 `memory.grantRequest` 生成新的请求。
- 卡片回调必须携带 `grant_request_id` 和 `confirmation_ref`，与文本路径共用校验；回调内容被篡改时拒绝。
- 删除请求直接创建 `DeletionJob`，不经过模型；回复区分“已停止使用”和“副本 pending”。

**错误映射：**

| 场景 | 内部错误 | 对外行为 |
| --- | --- | --- |
| 短语错误/过期/重放 | `access_denied`（reason: confirmation_invalid） | 提示重新发起，不透露其他主体 |
| 断言/会话不匹配 | `access_denied` | 不建立 grant |
| epoch 变化 | `version_conflict` | 回读当前状态 |
| 删除请求重复 | 幂等返回原 `deletion_job_id` | 不创建第二个作业 |

### C3 商家纠正（R03）

**`learning.submitCorrection` 输入：**

```json
{
  "schema_version": 1,
  "command_id": "cmd_example",
  "expected_version": 0,
  "correction_text": "买家说两箱时，系统按两件处理；应先读商家包装倍率再换算。",
  "issue_tags": ["unit", "quantity"],
  "case_refs": [],
  "base_release_id": "rel_example",
  "consent_basis": "merchant_abstraction"
}
```

**规则：**

- `correction_text` 上限建议 2,000 字符；空文本、超长、含客户标识/联系方式/凭据/价格底线时拒绝或脱敏。
- `case_refs` 可空；只有 `promoteCorrection` 后形成案例，才进入候选提炼。
- `merchant_id`、`actor_id`、`capabilities` 由管理鉴权注入；商家不能提交其他商家 ID。
- 返回 `correction_id`、`revision`、`status=DRAFT`；重复 `command_id` 同摘要返回原结果。
- 编辑产生新 revision；已生成候选标记 `STALE`，需重新评测与批准。

**状态机：**

```
DRAFT --promote--> CASE_READY --propose--> CANDIDATE_DRAFT
  |                     |
  +--edit--> DRAFT      +--reject--> REJECTED
```

### C4 技能摘要与加载（R04）

**运行快照中的摘要：**

```json
{
  "skill_summaries": [
    {
      "skill_key": "trial-unit-clarification",
      "release_id": "rel_example",
      "compiled_artifact_hash": "sha256:...",
      "generation": 3,
      "revocation_epoch": 0,
      "description": "单位或包装不明确时，先查倍率再澄清",
      "trigger_hint": "SKU 或数量单位不明确",
      "required_tools": ["get_commercial_facts"],
      "question_schema_version": 1
    }
  ]
}
```

**`load_reception_skill` 输入/输出：**

```json
{
  "schema_version": 1,
  "skill_key": "trial-unit-clarification"
}
```

返回冻结产物：

```json
{
  "skill_key": "trial-unit-clarification",
  "release_id": "rel_example",
  "compiled_artifact_hash": "sha256:...",
  "generation": 3,
  "body": "受控操作参考正文...",
  "required_tools": ["get_commercial_facts"],
  "question_schema_version": 1
}
```

**规则：**

- 摘要最多 5 项、合计 ≤600 中文字符；超出按显式优先级截断并记录，不由模型决定。
- 加载最多 2 个、正文合计 ≤3,000 中文字符；超出拒绝，不静默截断。
- 只接受快照中的 `skill_key`；未绑定、已撤回、已过期或依赖未实现能力均拒绝。
- 技能正文是操作参考，不能覆盖系统权限、工具白名单或商品事实；`required_tools` 必须是运行白名单子集。
- 加载计入工具调用上限；技能摘要不计入技能正文预算，但计入上下文预算。

### C5 连带接口（R10）

| 合同 | 输入 | 返回 | 备注 |
| --- | --- | --- | --- |
| `memory.list` | subject_scope、cursor、limit | 记忆摘要 | 分页绑定 grant epoch；不返回正文之外的其他主体 |
| `jobs.list` | status、cursor、limit | 任务摘要 | 商家隔离；不返回内部 token |
| `jobs.get` | task_id | 触发、产物、审批、发送状态 | 敏感字段脱敏 |
| `binding.linkChallenge` | source_session、target_subject_assertion、scope | challenge_id、expires_at | 5 分钟、单次消费 |
| `binding.linkConfirm` | challenge_id、proof | binding_id、binding_epoch | 双方范围验证 |
| `customer.deletionRequest` | resource_scope、expected_epoch | deletion_job_id | 不经过模型 |

---

## D 回填顺序与验收补充

### D1 回填顺序

1. **M0 文档冻结前**：先补 A1（R01）、A2（R02）、A3（R03）、A4（R04）的正文和 §17.1 合同；同步 A11 的新验收编号。
2. **M1 建表前**：补 A5（R05）的 `created_at`/`purge_at`/删除登记和迁移账本；补 A10（R10）的只读合同。
3. **M2 评测前**：补 A7（R07）的通过定义；补 A6（R06）的模板合并规则。
4. **M4 前**：补 A8（R08）的投影新鲜度和 A9（R09）的预算分配。
5. **文档修订**：A12、A13 统一字段与引用。

### D2 验收编号建议

| 编号段 | 用途 |
| --- | --- |
| A13–A16 | 商家纠正与 PII 预检 |
| A17–A20 | 技能摘要、发现、预算与未支持能力 |
| B13–B16 | 确认短语、卡片、重放、删除竞态 |
| C15–C16 | 投影缺口、预算优先级 |
| X11 | 旧二进制守卫兼容 |

新增用例保持与现有 48 条相同的证据要求：版本、输入、实际结果、trace、持久对象和回执；未执行标 `pending`。

### D3 关闭证据包

每条修订关闭时至少附：

- 文档位置与 diff；
- 对应 schema/字段字典版本；
- 至少一条真实或夹具验收证据（按用例编号）；
- 若改变了接口或表，附迁移与回退说明；
- 若未采用建议，记录原因与替代方案。

---

## E 建议的 M0 会议议程

1. D-M0-01 目标宿主主体能力（15 分钟，带宿主证据）。
2. D-M0-02 确认通道（10 分钟，选 A/B/C）。
3. D-M0-03 纠正入口（5 分钟）。
4. D-M0-04 技能发现（5 分钟）。
5. D-M0-05/06/07/08 其他冻结项（10 分钟）。
6. 确认 §1.1、§22.1、附录 A 的同步修改责任人与截止日。

会议输出直接写入设计文档的“M0 冻结记录”，不要只留在会议纪要里。
