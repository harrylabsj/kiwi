# Kiwi 商家智能体增强设计
## 经验学习 客户记忆 主动经营
版本 v1.1  日期 2026年11月15日  适用对象 产品 开发 测试 商家运营  本版已回填 M0 决议 D-M0-01–10
本文把已确认的 TOP 1 至 TOP 3 建议落成一套可分期开发的设计。在现有 Pi 接待、Merchant Core 与 KNP 基础上，增加经过审核的接待技能改进、获得授权的客户跨会话记忆，以及可持续执行的经营任务。目标是减少重复纠错、减少客户重复说明，并让未完成的询价得到及时处理。
三个模块共用身份、数据用途、版本、预算和发布校验。模型负责提炼经验、恢复需求和提出下一步；业务核心负责当前事实、权限、状态变更和执行证据。实现时扩展已有接待与经营模块，保持一个商务写入口。
| 优先级 | 本版交付能力 | 首版结果 |
| --- | --- | --- |
| TOP 1 | 经验复盘与受审技能改进 | 商家纠正可以形成候选改动，经评测和审核后用于接待 |
| TOP 2 | 客户记忆与历史检索 | 已验证组织/代理范围的客户可跨会话接续需求，历史商务数据重新核实；个人跨会话记忆待宿主证据 |
| TOP 3 | 事件驱动经营任务 | 自动发现待处理问题，在工作台生成有依据的待办和草稿 |

设计决议：首版以单商家实例为部署单元，保留租户键以支持隔离测试；不要求替换 Pi 宿主或迁移全部历史存储。客户主动外发单独列为 P1，必须通过授权、渠道、回执与恢复验收后启用。
开发基线固定为 Kiwi 0.12.30，提交 366ef681800322446db21bd1b510c1d810964508。Pi Agent Core、AI、Coding Agent、Durable 及 Chord 的包版本均为 1.5.0。该基线用于确定复用位置；下述新增接口、表、初值和验收要求属于本次设计。[S01]
本版在 v1.0 基础上回填 2026-11-15 M0 决议：TOP2 P0 按组织/代理范围记忆；客户确认采用文本短语与卡片双通道；新增 learning.submitCorrection；技能发现采用运行快照摘要；迁移账本独立；评测按 3/3 通过；规则入口统一 automation.prepareRule；单写者采用 SQLite 所有权表与心跳租约。参数冻结与宿主证据请求见第 23 节。
## 阅读导航
- 第 1 至 4 节说明范围、代码基线、架构和共同契约。
- 第 5 至 8 节定义 TOP 1 的经验、评测、审核、发布和接待接入。
- 第 9 至 12 节定义 TOP 2 的身份、授权、记忆、检索、纠错与删除。
- 第 13 至 16 节定义 TOP 3 的经营规则、触发、任务执行和 P1 外发。
- 第 17 至 23 节定义接口、存储、并发、预算、工作台、实施、发布与 M0 决议。
- 附录 A 给出 64 条验收用例；附录 B 给出固定源码及官方资料；第 23 节给出 M0 决议与参数冻结。
## 1 范围与分期
本版是《Kiwi 商家 AI 智能体设计 v1.1》的增量设计。继承其受控工具、事实引用、确定性商务输出、身份隔离和有界执行原则；以当前主库实现修正接入方式。原文中的 Pi 1.2.0 和“新增整套接待主机”不再作为本次实施起点。[D01][S01][S02]
### 1 1 P0 范围
TOP 1 完成商家主动提交纠正、符合用途许可的案例提炼、候选评测、审核发布、回滚，以及接待侧按需加载。仅支持当前工具能够完成的商品识别、数量单位澄清、公开事实比较与受控磋商流程。
TOP 2 完成组织/代理范围可信主体的显式授权、稳定偏好候选与确认、获授权历史检索、需求续接、纠错及删除。个人跨会话记忆待目标宿主提供按人可验证、可撤销的主体断言后另立升级决议（D-M0-01/E1），P0 不建立个人档案。匿名买家仍可询价；未建立可信主体和授权时，只使用当前访问会话。
TOP 3 完成周期与业务事件触发、确定性筛选、受限模型建议、工作台待办与草稿、可靠执行记录及暂停恢复。首批模板为未完成询价日报、缺项询问草稿和报价到期复核。
### 1 2 P1 范围
在独立验收后增加客户订阅的到货或状态通知、可靠异步发送，以及已审核商品知识支持的用途或设备型号问题。跨设备身份关联、跨组织代理、更多渠道与跨商家平台调度按实际需求另行扩展。 个人跨会话记忆依赖买方宿主按人签发主体断言，列为 P1 外部依赖；未满足前保持组织/代理范围。
本次不修改 KNP 消息结构，不增赋买方签名、下单、付款、库存预留或自动改价能力。主库已有的交易与订单相关模块继续遵循其原有权限；经营任务读取必要状态，不将跟进目标解释成新的采购授权。[S09]
### 1 3 必须保持的业务结果
任何功能关闭或模型故障时，合法结构化询价仍可走现有确定性路径。模型、历史记忆和技能文本都不能成为当前价格、库存、交期或批准状态的权威来源。模型建议完成、工作台任务完成、外部动作成功、消息送达和实际成交是分别记录的结果。
## 2 当前代码与增量接入
当前主库已经实现接待 P0a。接待 Pi 路径直接使用 pi-agent-core 的 Agent 与顺序工具调用；本版扩展该路径，不另建 Pi Durable 接待主循环。模式和部署仍由服务配置决定，代码存在不等同于目标实例已启用。[S02][S03]
| 现有位置 | 已核实基础 | 本次增量 |
| --- | --- | --- |
| a2a reception agent runtime | 搜索、比较、公开商务事实、需求提案和回复提案 | 接待技能加载、客户上下文读取、版本绑定 |
| reception engine 与 publish | 事实引用、计划校验、确定性回复 | 授权上下文校验、有限问题契约、旧运行失效 |
| agent skills registry | 本地版本化 SKILL 解析与读取 | 商家专属候选、评测、发布目录与回滚 |
| agent memory | 主体记忆、证据、置信度和状态 | 独立客户记忆域、硬权限过滤和历史查询 |
| merchant core followup | 持久任务、租约、fencing 和 UNKNOWN | 可靠触发器、规则评估、Pi 建议、原子完成 |
| merchant operations facade | 认证商家注入、经营服务统一装配 | 新模块统一入口与事件交接 |
| reception reply outbox | 同步响应记录、序号及预留状态 | P1 异步投递、队首处理和证据核对 |
| reception retention | 会话 30 天、联系字段 7 天、用量 90 天；按 updatedAt 滚动 | 采集后 90 天绝对上限、删除登记 180 天、独立确认偏好 90 天 |

依据为 [S02] 至 [S09]；回复计划发布器 [S04]，技能 Registry 与技能工具 [S06]，商家对话入口与已有恢复 worker [S12]。现有接待工具白名单没有技能加载；现有 Principal Memory 的 scope 评分不能代替客户访问控制；现有同步 reply outbox 不能直接当作可靠异步发送器。这三处均列入开发工作，不以改提示词代替实现。
仓库验收映射记录了 2026年11月4日 Veyquo 0.12.24 的 Pi 接待与审批回环。该记录可作为历史证据和回归线索；本次发布仍须重新验证目标版本、目标商家、真实模型和渠道。[S10]
## 3 总体架构与模块职责
*图 1 在既有接待和经营核心上增加三类能力*
图注：买方同意、确认与删除请求经宿主通道进入接待与 CustomerMemoryService；ContextGuard 与发布临界区位于 Pi 接待和 Merchant Core 之间，记忆正文不能绕过。
接待请求先完成身份和会话校验，再由 ReceptionSkillCatalog 与 CustomerMemoryService 提供最小授权上下文。Pi 产生受控提案，发布器重新核实事实与上下文版本后回复。后台经营任务使用相同模型适配器与预算账本，以独立运行快照执行，不复用买家或 owner 的整段会话。
LearningService 只管理经验和技能候选，不持有商务写权限。MerchantOperationsService 通过既有 MerchantOperationsFacade 与 FollowUpService 管理经营任务；模型不能直接修改任务状态或经营策略。
新服务逻辑可位于 src/merchant-core/learning、customer-memory、operations-jobs 与 context-governance。目录为建议；实现可按现有项目约定调整，但职责、授权和唯一写入口不得分散。接待接线仍集中在 src/a2a/reception。
## 4 共同身份与运行契约
### 4 1 服务端身份
ActorContext 由管理鉴权、可信 A2A 身份或现有访问会话在服务端创建。模型及客户端只提交业务参数，不可提交可信的 merchant_id、subject_id、权限集合或身份验证结论。管理接口中的商家来自认证上下文，沿用现有 facade 的注入方式。[S09]
subject_id 是商家域内的随机客户主体标识，不是姓名、电话、contextId 或模型判断的身份。A2A 验签首先证明某凭据的控制权；同一买方 Agent 代理多人时，须另有可验证的被代理主体绑定，否则记忆只能归于代理或组织范围。
### 4 2 共用对象
| 对象 | 必备字段 | 约束 |
| --- | --- | --- |
| ActorContext | merchant_id actor_id auth_strength subject_binding capabilities | 只由服务端创建并逐次检查 |
| DataUseGrant | grant_id merchant_id subject_id purpose resource_scope_id grant_epoch status expires_at policy_version | 客户记忆、历史检索、经验用途、通知授权分别授予 |
| SourceRef | object_id version payload_ref erase_scope_id observed_at expires_at | 不把正文或秘密塞入引用 |
| ContextSnapshot | skill_bindings binding_epoch memory_set_version grant_versions data_scope_epochs conversation_revision config_version | 支持多个技能和来源，由服务端签发 |
| DerivationEdge | parent_id parent_version child_id child_version purpose | 删除、更正和撤权可定位派生对象 |
| RunReceipt | run_id cause_id model_revision attempts usage_state result_ref outcome | 模型结果与业务执行结果分开 |

商家配置经验提炼，不自动取得客户跨会话记忆或营销许可。已同意保存偏好，也不自动同意提炼技能或接收主动通知。P0 优先使用商家主动提供的抽象纠正；使用客户案例前验证相应数据用途。
### 4 3 在途运行与发布
模型运行在业务锁之外。读取数据前、每次工具调用前、每次 provider attempt 派发前和最终发布前，分别检查权限、来源可用性与版本；重试、压缩、摘要和后台分支同样检查。更正、删除、撤权、技能撤回或规则变更，递增对应版本并使受影响的旧快照失效。旧运行即使已经得到模型答案，也必须丢弃该答案或重新计算，不仅从文本中删掉引用标记。
新能力增加统一 ContextGuard 与发布临界区。它与撤权、封存、接管共享版本检查和串行化规则，禁止单纯“先查权限、稍后无条件写入”。P0 仅允许单商家实例的一名有效写入者；跨进程持久租约和 fencing 防止重启后的旧写入者继续提交。新增表内使用事务，跨现有 JSON 与 SQLite 用发布意图及回执协调，未确认完整提交的内容不对外放行。
## 5 TOP 1 经验来源与技能候选
### 5 1 产品目标
将可验证的接待纠正转成后续可执行的方法。Hermes 的技能创建、更新和会话复盘提供了机制参考；Kiwi 的发布、访问和工具边界由服务端实现。技能审核不能只靠提示词或某个写入工具的审批开关。[H01]
P0 接收三类输入：商家主动提交的流程纠正；获得相应用途许可、已完成且结果可核实的案例；从失败或人工接管记录中生成的问题建议。成交金额、模型自评或客户一句“谢谢”均不单独证明流程正确。
商家主动纠正走 learning.submitCorrection（D-M0-03）：纠正正文有上限，可选关联已授权案例或基线版本；merchant、actor、权限由管理鉴权注入；服务端在入库前拒绝或脱敏客户标识、联系方式、凭据和价格底线。通过后形成 correction_id 与 revision，状态为 DRAFT；只有 learning.promoteCorrection 才形成案例并进入候选提炼。
### 5 2 候选内容
LearningCandidate 必须说明原问题、适用商品范围、建议步骤、支持证据、反例、依赖工具和预期改善。候选只能改接待流程与已批准的问题选择，不能增加折扣权限、改变商品事实、注册工具或改写 HardPolicy。
| 字段组 | 设计字段 | 验证要求 |
| --- | --- | --- |
| 身份与基线 | candidate_id merchant_id skill_key base_release_id revision | 商家隔离，更新用 CAS |
| 提议正文 | trigger proposed_steps exclusions reason | 有长度上限，无客户标识、凭据或价格底线 |
| 证据 | source_refs correction_actor outcome_ref counterexamples | 来源可用且用途允许 |
| 能力依赖 | audience required_tools question_schema_version tool_contract_digest | audience 固定为 customer_reception |
| 发布绑定 | content_hash eval_report_id reviewer_id approval_ref expires_at | 批准绑定确切内容和评测版本 |

后台经验提炼 Agent 由管理命令或经用途筛选的案例触发，通过 propose_learning_candidate 提交结构化草稿。它只读授权案例投影，没有批准、发布和商务写工具；商家、真实 actor、来源 grant 与 epoch 由服务端注入。买家接待 Agent 不注册此工具。服务端规范化后计算摘要并存储；模型不能直接写 SKILL 文件或更新生效指针。对买家输入中的“修改规则”等文字，仅按案例数据处理。
纠正、案例与候选分别管理：纠正编辑产生新 revision；已生成候选在纠正变更后标记 STALE，旧评测与批准失效；未形成案例的纠正不得直接生成候选。
### 5 3 生命周期
*图 2 候选与生效版本分别管理*
候选状态为 DRAFT、EVALUATING、EVALUATION_FAILED、READY_FOR_REVIEW、APPROVED、REJECTED、STALE、EXPIRED。进入评测前先编译并冻结实际可加载产物，记录 compiled_artifact_hash、compiler_version、问题与工具契约版本。评测、审核和发布均绑定这份产物；发布只核验并激活，不重新生成正文。任何内容或编译变化均产生新的 revision 和 hash，旧评测与批准失效。
评测完成且合格进入 READY_FOR_REVIEW，完成但不合格进入 EVALUATION_FAILED，依赖失效进入 STALE。额度不足、超时或中断时保留 EVALUATING，并在评测运行记录中标明 paused_budget、failed 或 interrupted；不得进入通过状态。重试复用已冻结案例与产物，补齐缺失回放；不能筛掉失败样本。APPROVED 形成不可变 SkillRelease，再以 CAS 切换生效指针。审批成功与发布成功分别记录。
发布版本状态为 ACTIVE、RETIRED、REVOKED。RETIRED 不再分配给新运行，但已固定且仍兼容的运行可完成；REVOKED 在加载、工具入口和发布门均拒绝。回滚是把生效指针切到仍兼容且经过审核的历史版本，并增加 generation；安全撤回另增加 revocation_epoch。不得覆盖旧内容或恢复已撤回版本。发布失败可凭同一命令恢复，不能生成两个生效版本。
## 6 TOP 1 评测与发布门槛
### 6 1 评测构成
每个候选至少包含 20 个冻结案例：8 个目标场景、6 个相邻或反例场景、6 个权限和商务边界场景。案例由商家或测试负责人审核，不能全部由提出候选的同一次模型生成。保留独立验收集，避免只适配展示案例。
首先进行确定性契约验证，再以相同模型版本和相同事实夹具分别回放当前技能与候选技能。正式发布前，每个场景至少重复 3 次；记录输入、技能 hash、模型、工具结果摘要、ResponsePlan、守卫结果和人工评分。原 Q15 及相关既有回归继续执行，但不把解释器测试结果等同于新的 Pi 技能路径质量。[S10]
### 6 2 建议试点门槛
| 类别 | 发布条件 | 失败处置 |
| --- | --- | --- |
| 硬约束 | 未授权商务承诺、越权读取、私密泄露和绕过批准均为 0 次 | 阻断发布，修正后重测 |
| 目标场景 | 8 个目标场景各 3 次回放全部通过且无硬门失败；至少一项预登记改善指标有可核实收益 | 保留当前版本；不得用总次数或平均分替代 |
| 相邻场景 | 通过率不低于当前版本，人工评分无新的严重错误 | 标记回归原因 |
| 提问负担 | 非必要追问不高于当前版本，不能靠永远转人工取得安全分 | 调整技能或问题契约 |
| 可解释性 | 每项差异可定位到技能步骤和工具证据 | 补齐证据后再审 |

目标层共 8 个场景，每例 3 次，即 24 次回放；场景通过定义为该场景 3 次全部通过且无硬门失败，8 个场景全部通过才进入人工审核。以上数值为试点初值，不代表统计显著性或线上效果保证。样本量、评审人和阈值版本一并冻结。无可核实改善的等效候选保持草稿，不作为经验改进自动发布；不要求每次复盘都生成或发布技能。
### 6 3 审核权限
拥有商家技能发布权限的管理员审核准确 diff、适用范围、失败案例和预期行为。APPROVED 绑定 merchant、content_hash、compiled_artifact_hash、compiler_version、基线版本、工具契约、问题 schema、评测报告与审批期限。候选待审最长 7 天，批准后须在 min(批准时间+24小时, expires_at) 内发布；任一依赖变化则重新评测或重新批准。这是技能发布许可，不替代既有商务批准。
首次发布先针对固定的测试会话回放，再向少量明确分组的生产会话启用；按会话固定技能版本，避免同一轮漂移。撤回版本立即阻断新运行；受影响的在途运行在发布门被拦截。普通新版本发布可让已固定旧有效版本的在途运行完成。
## 7 TOP 1 接待技能加载与问题契约
### 7 1 受控技能目录
ReceptionSkillCatalog 复用 SkillRegistry 的格式验证思想，管理商家专属、已发布、不可变的接待技能。按 merchant、audience、SKU 或类目、工具契约及当前发布状态过滤。内置技能与商家覆盖版本采用显式优先级；同键同范围冲突阻断发布，不由模型自行决定覆盖。
运行开始时固定 skill_bindings 数组，每项包含 skill_key、release_id、compiled_artifact_hash、generation、revocation_epoch 与依赖契约版本。新增 load_reception_skill 只接受本轮目录中的 skill_key，只能加载快照中的确切产物，不在每次加载时重新解析当前 ACTIVE 指针。禁止路径参数、任意文件读取、外部 URL、脚本附件执行以及对 owner 技能目录的通用访问。
运行快照同时包含有界 skill_summaries：每项只有 skill_key、一句话触发条件、release_id、compiled_artifact_hash、generation、revocation_epoch 与依赖契约版本，不含正文；最多 5 项、合计不超过 600 个中文字符，按商家、audience、SKU/类目、工具契约和发布状态过滤生成。模型只能从摘要中选择 skill_key 调用 load_reception_skill；加载返回快照中的冻结产物，最多 2 个、正文合计不超过 3,000 个中文字符。未绑定、已撤回或超出上限的加载拒绝，不回退到 owner 技能目录。
每轮最多加载 2 个技能，单技能正文上限 3,000 个中文字符，单轮 2 个技能正文合计仍不超过 3,000 个中文字符，并受运行上下文预算约束。加载次数计入工具调用上限。知识正文是受控操作参考，不能覆盖系统权限或商品事实。
### 7 2 必须先补的问题能力
当前 Pi 接待的 ask_clarification 仅接收有限 reason，并将 missing 固定为 sku；添加“请询问数量或单位”的 Skill 文本不能自动获得相应模型输出能力。[S02]
本版增加 QuestionSpec v1，P0 仅注册 sku、quantity、unit 三个槽位及对应模板。question_id、slot、reason、模板版本、输入 schema 和适用条件由产品与开发审核发布；模型只选择问题 ID 与合法候选引用。发布器从模板生成问题，不接收模型自由填写的问句。
QuestionSpec 不新建并行问题系统：现有 missing_quantity、unit_mismatch 等 reason 与固定文案登记为模板初始版本，确定性引擎继续产生这些 reason；技能只能选择已注册的 question_id，不能自由生成问句。模板与旧渲染器由同一注册表维护；模板缺失时回退到现有固定文案，并在运行记录中标注 renderer_fallback。
ask_registered_question 块包含 question_id、schema_version、slot、reason_code、candidate_refs。回答的证据必须来自买家当前明确输入或已验证的指代确认；模型不能仅凭历史偏好写入当前已确认数量。每轮最多提出 2 个必要问题，已有可靠证据的槽位不重复提问。
设备型号、用途、目的地级履约等槽位待 P1 确认数据源、QuestionSpec、need schema 与渲染规则后再开放。技能依赖未实现的槽位或工具时，发布返回 unsupported_capability。
## 8 TOP 1 首批技能与贯穿案例
| 技能 | 触发条件 | 允许动作 | 退出条件 |
| --- | --- | --- | --- |
| 试用询价澄清 | SKU 或数量单位不明确 | 查目录，选择已注册问题，确认试用数量 | 本次商品与数量单位得到确认 |
| 价格异议处理 | 买家提出目标价或认为价格高 | 查询当前事实，解释可证内容，进入已有受控协商 | 核心返回结果或明确待审批 |
| 公开方案比较 | 本店存在多个明确候选 | 比较公开价格与库存，展示可验证理由 | 买家选择或明确需要人工帮助 |

交期无法满足时的复杂替代方案仍依赖履约能力，不以技能文本预先承诺。首批技能可以告诉买家哪些信息需要商家确认，但不能把预计交期变成保证。
示例：商家发现系统反复把“2 箱”按“2 件”处理，提交纠正。候选技能要求先读取商家单位和包装规则，无倍率时提问，有倍率时按既有核心换算。测试集覆盖已配置倍率、缺失倍率、多义单位和买家改数量；审核发布后，对相同问题按新步骤执行。新技能不能自行写入“1 箱等于 12 件”。
这条链路的改善结果记录为单位纠错率和重复提问次数。商品换算规则本身仍由商家商品配置维护，技能版本与商品事实版本分别管理。
## 9 TOP 2 客户身份与授权
### 9 1 客户主体模型
CustomerSubject 包含 subject_id、merchant_id、subject_kind 和 status。subject_kind 至少区分 person、organization、agent_scope。VerifiedSubjectBinding 保存可信 issuer、actor、被代理主体声明、证明引用、binding_id、binding_epoch 和有效期，不存模型推断的身份。
匿名访问令牌只能证明对当前会话的访问权。昵称、电话相同、设备、IP、文本相似度、sharecode 或 contextId 都不能自动建立跨会话客户身份。外部宿主若不能提供稳定可信主体，跨会话记忆功能保持未启用，接待照常进行。
尤其不能仅凭 identityVerified=true 建立个人档案：当前 OpenInquirySession 的 T0 自证明签名也可进入已验签路径，它证明会话密钥控制权，不是现实身份或稳定客户绑定。客户上下文须检查 credential_kind、assurance_class、binding_epoch 和被代理主体证据，独立于商家管理 ActorContext。[S11]
P0 主体范围（D-M0-01）：在目标宿主提供按人可验证、可撤销的主体断言前，只启用 organization 和 agent_scope 范围记忆；person/verified_person 一律拒绝或降级，不建立个人档案。目标宿主证据按 E1 请求清单核验，证据不足时保持组织/代理范围，个人记忆列为 P1 外部依赖。
### 9 2 明确授权与关联
首次提供记忆功能时，向客户说明拟保存的内容、用于后续接待的目的、有效期和删除入口。客户确认后创建 customer_memory grant；历史检索另授予 history_recall 用途及对应能力。通知订阅和经验提炼使用不同 purpose，不能因客户继续聊天而默认同意。可复用已验收的买方宿主凭据，无需为此强制注册新的 Kiwi 账号。
确认通道（D-M0-02）：服务端创建 grant_request 时生成一次性确认短语，绑定商家、会话访问权、用途、能力和有效期；接待回复按冻结模板展示拟保存内容、目的、期限和删除入口。客户在同一会话原样回传短语才创建 grant；自由文本不构成确认，模型只能创建新的 grant_request。买方宿主支持结构化卡片时，卡片回调必须携带 grant_request_id 与 confirmation_ref，并与文本路径共用校验。
删除通道：客户可随时请求删除单项记忆或停止跨会话记忆；服务端直接创建 DeletionJob，不经过模型判断，回复区分已停止使用与副本 pending。
匿名会话关联到可信主体，必须同时验证当前会话访问权和新主体证明，并明确列出关联范围。采用新增绑定版本，不静默合并历史档案。P0 不支持模型发起跨主体合并；管理员纠错也须经过专门审计与双方范围验证。
关联挑战由服务端生成，5 分钟有效、单次消费，绑定商家、源会话、目标主体和待关联对象。撤销绑定递增 binding_epoch，重新绑定创建新 binding；撤销用途许可递增 grant_epoch，重新授权创建新 grant，两者不能互相替代。凭据轮换经原受信身份链验证。证明入口控制权与同意使用具体数据分别记录。
### 9 3 访问控制顺序
数据库查询先限定 merchant、subject、resource_scope、grant 状态与 epoch、数据未封存、来源未过期和允许可见性，再做相关性排序与片段提取。不能全库召回后交给模型过滤，也不能只依赖现有 MemoryStore.scopeScore。[S07]
查询结果中的每个引用再次校验授权范围；分页游标绑定 merchant、subject、grant epoch、查询摘要和截止位置。授权撤销后，旧游标、旧缓存与旧模型上下文都失效。
## 10 TOP 2 记忆写入与纠错
### 10 1 存什么
Hermes 将精简长期记忆与按需历史检索结合使用。本设计借鉴这种上下文组织方式，客户数据仍由 Kiwi 的主体绑定、用途授权及来源时效约束，不把宿主 profile 当成商家客户 ACL。[H02]
CustomerMemoryItem 复用现有记忆的证据、来源类型、置信度、状态与到期理念，在独立客户域保存。不得把全部客户写入商家 owner 的 Principal Memory，也不得把 owner 成本、底价和经营策略注入客户接待。[S07]
| 字段组 | 核心字段 | 含义 |
| --- | --- | --- |
| 归属 | memory_id merchant_id subject_id resource_scope_id | 硬隔离，不由模型传入 |
| 内容 | namespace key value_ref value_type | 偏好、约束、历史需求或会话线索 |
| 状态 | candidate active needs_review superseded deleted expired | 服务端迁移 |
| 证据 | source_kind source_refs confidence confirmed_by confirmed_at | 区分明确陈述、观察与推断 |
| 时效 | valid_from expires_at last_confirmed_at policy_version | 读取不延长有效期 |
| 控制 | version grant_id grant_epoch data_epoch erase_scope_id | 纠错删除与在途失效 |

P0 可保存客户明确确认的规格偏好、沟通偏好、粗粒度收货地区和未解决需求线索。精确地址、手机号和联系人不进入模型长期记忆；必要时仅使用受控资料库引用。
### 10 2 写入规则
从对话提取的条目先进入 candidate。客户明确要求“请记住”且已有有效用途授权时，可由服务端记录为 explicit 并确认；否则由服务端创建 grant_request，按 §9.2 的确认短语或宿主卡片请客户确认；确认前条目保持 candidate，不得进入模型可见的 active 集合。模型反复观察到同一行为不能自行将候选升级为硬约束。
P0 不把 Principal Memory 的“多次支持证据激活软偏好”原样应用到客户域。统计推断最多形成线索；用于填入采购要求之前仍需客户确认。买家预算属于其输入约束，绝不转成商家报价或向其他客户传播。
### 10 3 纠错与删除
客户纠正时，新版本明确 supersede 旧版本，保存最小纠正事件并使 memory_set_version 递增。对冲突不做无声覆盖；当前明确陈述优先于历史偏好，未能判断的冲突转为澄清。过期条目不进入模型；删除处理按第 12 节执行。
## 11 TOP 2 历史检索与需求续接
### 11 1 查询工具
新增 recall_customer_context 和 search_customer_history 两个只读工具。模型可提供查询文本、SKU、任务引用和时间范围，subject 与 merchant 从 ActorContext 注入。工具返回最小片段、消息或需求引用、时间、来源状态、授权版本和历史标记，不返回完整客户档案。
P0 先按 SKU、任务和时间筛选，再做文本检索。中文检索采用经过测试的分词或二元字符索引；如使用 SQLite FTS5，必须验证中文查询效果及目标 SQLite 的 tokenizer 支持，不以默认英文分词表现代替验收。首版不依赖向量数据库。
每次最多返回 5 个片段，总正文不超过 2,000 个中文字符，每个片段保留可核查引用。无匹配时明确返回 no_match；授权不足、已删除和其他客户存在与否统一按不泄露资源存在性的响应处理。
检索服务不可用或超时返回 unavailable，不能伪装为 no_match。查询长度上限 256 字符，参数绑定并转义搜索语法；游标 5 分钟有效，查询预算初值 500 毫秒。默认查 30 天，实际范围取授权与保留期交集。中文同义词未命中允许追问，不回退全商家搜索。
### 11 2 历史与当前分开
RecallResult 分成 confirmed_preferences、historical_requirements、historical_business_refs 和 unresolved_items。历史商务引用必须带 is_current=false；接待发布器不接受它充当 CommercialFactRef。历史报价、库存、预计交期和审批不因检索命中重新生效。
“还是上次那款”可以让模型提出与唯一合法历史对象关联的需求候选；服务端确认指代、来源及本轮表达。多项历史对象都可能匹配时必须澄清。没有说“同样数量”时，不把上次数量自动变成本次数量。
### 11 3 贯穿示例
已验证客户说“还是上次那款，先两盒，送上海”。系统检索到上次明确选定的 SKU 和对应单位规则，保留本轮两盒与上海的输入证据，询问必要变化，然后查询当前价格、库存和交付事实。若两盒与商品单位无法可靠换算，按 QuestionSpec 澄清。
若上次记录已到期或被删除，回复请客户重新说明商品，不使用摘要或模型记忆补造历史。模型不可用时，可以展示经验证的简短历史条目或退回普通接待；不会因记忆故障阻断基本询价。
## 12 TOP 2 留存与派生数据删除
### 12 1 有限留存
下列为试点上限，继承 v1.1 的有限留存原则；实施时以配置版本冻结。期限受来源、用途授权和删除请求共同约束，取最早截止时间。[D01]
冻结口径（D-M0-09）：每条内容记录 created_at 与 purge_at，purge_at=min(会话关闭时间+分类期限, 采集时间+90天)；后台读取、重试、摘要和索引更新不得延长。留存值属于试点上限，隐私/法务确认后生效。
| 数据类别 | 默认上限 | 处理要求 |
| --- | --- | --- |
| 接待原文及历史检索片段 | 会话关闭后 30 天，且不晚于采集后 90 天 | 后台读取与重试不延长期限 |
| 必需联系资料及引用副本 | 会话关闭后 7 天或更早截止 | 受控资料库 缓存 与派生副本同步清理，引用不延长期限 |
| 客户明确确认的偏好 | 确认后 90 天，且不晚于 grant 到期 | 单独确认形成独立用途记录；原始聊天仍按原期删除 |
| 学习案例和未发布候选正文 | 30 天或来源更早截止 | 脱敏副本、评测输入同样受管 |
| 临时完整调试内容 | 默认不留，启用时最长 7 天 | 脱敏、受限访问、到期清理 |
| 用量和运行元数据 | 90 天 | 默认无提示词和客户正文 |
| 最小控制及删除登记 | 180 天 | 覆盖支持的重试窗口，期满前验证旧请求拒绝 |
| 滚动备份 | 最长 35 天 | 恢复前重放删除登记，清理后再开放读取 |
| 采集后绝对上限 | 90 天 | 接待原文及片段 purge_at 不晚于采集+90 天；后台读取不得延长 |

已发布且不含个人信息、由商家独立确认的通用技能按经营知识版本管理。若技能仍依赖可识别客户内容，必须继承来源删除；不能通过“抽象成经验”规避删除。只剩摘要不能证明已删除原文中的具体内容。
确认偏好可采用独立 90 天期限的前提，是客户审阅具体规范化值并明确确认，服务端保存独立确认载荷、确认回执和新的 SourceRef。仅提取聊天、复制摘要或同意泛化用途不能脱离原来源期限。删除该记忆或整个主体范围时，该独立确认记录仍在删除范围内。
### 12 2 可恢复删除流程
先写 DeletionJob、封存 erase_scope、递增 data_epoch 并撤销相关 grant。随后使缓存、索引、在途运行和待发内容失效，再清理源载荷、片段、摘要、评测样本、导出与临时副本。每一存储面记录 purged、pending 或 failed，失败可幂等重试。
DerivationEdge 定位受影响的记忆、技能候选和经营草稿。候选与未发送草稿失效；独立商家规则确认后的无个人信息技能可保留，但移除客户关联并留下有限审核记录。没有独立依据的依赖对象封存。
删除已发送内容不表示撤回对方副本；外部动作未知时继续只读对账，不能以删除触发重做。备份未过期时显示 backup_pending；只有实际受控副本完成处理后才报告完成。恢复前删除登记不可用则不开放服务。详情地址或低熵字段的裸 hash 不视为匿名化。
## 13 TOP 3 经营目标与任务模板
### 13 1 商家如何配置
商家可以选择模板，或提出“每天检查未推进的询价，告诉我缺什么信息并生成草稿”。模型将自然语言转成规则候选，界面展示触发时间、检查范围、输出位置、执行次数和有效期；商家确认后，固定 executor 激活该规则。自然语言本身不构成已启用的调度配置。
规则入口（D-M0-07/D-M0-10）：自然语言只生成 rule_candidate，统一走 automation.prepareRule 的 mode="goal"；模板选择走 mode="template"。候选展示触发时间、检查范围、输出位置、执行次数和有效期，商家确认后由 automation.activate 激活固定 executor。模型不能直接启用规则、提交任意 cron、扩大收件人或启用客户发送；jobs.proposeRule 不单独存在。
Hermes 的技能绑定任务、事件触发和无模型预检查提供了参考。Kiwi 采用固定模板和可验证业务条件；不能把通用 shell、任意网页脚本或自由工具注册暴露给后台经营任务。[H03]
| 模板 | 确定性筛选 | 模型作用 | P0 输出 |
| --- | --- | --- | --- |
| 未完成询价日报 | 统计指定窗口内的商机、缺项、待批和异常 | 归纳原因，排序建议 | 一份工作台报告 |
| 缺项询问草稿 | 存在未补字段且无新买家回复 | 选择适用技能和已注册问题 | 一份关联商机的草稿 |
| 报价到期复核 | 当前有效报价接近截止且仍待推进 | 解释复核原因，提出下一步 | 商家待办，不自动续价 |
| 数据可用性检查 | 来源过期、库存或交期证据不足 | 可选解释影响范围 | 确定性异常待办 |

没有变化时记录 no_change，不调用模型。审批到期、租约回收和 UNKNOWN 核对属于确定性基础服务，不能依赖模型日报才执行。
### 13 2 规则对象
AutomationRule 包含 rule_id、version、template、trigger_spec、timezone、scope、predicate_spec、action_type、budget、authorization_ref、effective_at、expires_at 和 content_hash。版本不可变，当前生效指针和 enable_epoch 单独保存。
P0 支持 daily_local、interval 和 one_shot 三种结构化时间配置。时间保存为 UTC，界面明确展示商家时区，默认 Asia/Shanghai。模型不能提交任意 cron 脚本、扩大收件人或启用客户发送。
模板配额与优先级（D-M0-09）：数据异常与未完成询价日报优先，缺项询问草稿次之，报价到期复核再次；每个模板有独立子上限和可借用余额。额度耗尽时任务保持 PENDING 并记录 budget_exhausted，工作台显示恢复时间与确定性降级；前台接待保留额度不得被后台占用。
每个已入队任务必须有 deadline_at。P0 默认不晚于到期后 24 小时，并取规则、数据用途和关键事实截止的更早值；模板可缩短，不能在重试时自动延长。日报过期后按新窗口生成新任务，既有 UNKNOWN 仍只读核对。
## 14 TOP 3 触发与可靠入队
*图 3 事件接纳 规则判断 模型建议和结果提交分别记录*
### 14 1 业务事件
EventInbox 保存 source_scope、external_event_id、payload_digest、entity_ref、source_version、occurred_at、received_at 和 evidence_ref。业务事实仍归原业务库，inbox 只保存必要投影和引用。
相同来源 ID 与相同摘要返回原记录，不增加版本、不再唤醒模型。相同 ID 与不同摘要记为冲突，保留原件并等待核验。来源版本可排序时，旧事件不能覆盖新状态；版本缺口补读权威快照。无可排序版本时，事件只触发重新查询，不能把接收时间当作业务版本。
latest_state 类状态监控允许合并同一问题的重复提示；订单、退款等有累计意义的事件必须保留，不能被“最新一条”覆盖。外部签名只证明来源身份，不自动证明事件载荷中的价格或结果真实。
### 14 2 定时与重启
内存 timer 只唤醒扫描，数据库 next_due_at 才是到期依据。启动立即扫描；相同规则版本与绝对计划时间形成唯一 occurrence。时钟回拨和夏令时重复不得重复生成同一 occurrence；时区改变产生规则新版本。
日报错过多个窗口时，只补最新一个未处理窗口并记录 missed_count。其他模板明确选择补跑、合并或过期策略，不能默认追发全部历史提醒。已有审批的绝对截止时间不因扫描频率或停机顺延。
### 14 3 原子入队
规则评估结果为 no_change、blocked、eligible 或 superseded。unique 键由 merchant、rule、rule_version 和 trigger_key 构成。eligible 时，在同一 SQLite 事务内保存评估、创建 FollowUp 并推进调度游标；崩溃时一起成功或一起回滚。
业务事件来自其他存储时，先以稳定 ID 持久接纳，再确认源端游标；通过可重放的来源扫描和缺口核对恢复。不得在模型调用前把事件标成“业务已处理”或“通知已送达”。
投影新鲜度（R08）：接待 JSON 到 state.sqlite 的投影记录 source_version、observed_at 和最大允许延迟；读取前检查，投影缺口、延迟超限或游标不一致时结果为 data_incomplete，附原因和缺失范围，不得记为 no_change；补读完成后按新 occurrence 重新评估。
## 15 TOP 3 任务执行与完成语义
### 15 1 复用现有状态机
FollowUp 仍使用 PENDING、READY、RUNNING、WAITING_APPROVAL、SUCCEEDED、CANCELLED、FAILED、UNKNOWN，NEW 仅为创建前态。规则和运行记录不另造一套相互竞争的任务状态机。[S08]
| 当前状态 | 触发与条件 | 结果 |
| --- | --- | --- |
| PENDING | 真正到期且规则及授权仍有效 | READY 或 WAITING_APPROVAL |
| READY | CAS 领取成功，租约有效 | RUNNING 并创建 attempt |
| RUNNING | 内部产物与回执原子提交 | SUCCEEDED |
| RUNNING | 需要审批，保存绑定引用 | WAITING_APPROVAL 并释放运行资源 |
| RUNNING | 可确定未完成且不可继续 | FAILED |
| RUNNING | 外部动作可能已发生，结果无法核实 | UNKNOWN |
| FAILED | 已证明可重试且仍获授权 | PENDING 并持久化新 due_at |
| UNKNOWN | 权威回执或有证据核对 | 成功 失败 或允许同动作恢复 |
| 未开始动作 | 取消或规则停用 | CANCELLED |

P0 内部任务的 SUCCEEDED 仅表示报告或草稿已进入工作台且有持久回执。后续若要通知客户，创建独立 customer_notification 任务引用该产物；不让已成功的内部任务倒退为“等待发送”。
### 15 2 领取与计算
在一个事务中校验到期、规则、授权、任务版本及幂等摘要，CAS 领取并增加 fencing，写入 attempt 和固定运行快照。模型调用在事务之外，读取白名单工具，返回 OperationAdvice。该类型包含建议种类、证据引用、待补字段、问题 ID、原因码和建议下一步；不包含任意可执行代码或任意收件人。
后台调用复用 Pi 模型接入和预算能力，但使用独立 run_id 与来源快照。内部定时文本不能冒充买家消息进入正式 KNP 会话。只有需要理解或归纳时才调用模型；模型故障时仍可生成有依据的固定异常待办。
### 15 3 P0 必须补强的提交点
当前 FollowUp 的部分方法只接收 due、still_authorized 等布尔，不能将这些参数当成真实授权证明；当前任务完成和 attempt 回执也需要合并到一个事务。[S08]
新增 commitInternalResult，校验 owner、fencing、任务 revision、cancel_epoch、租约尚未到期、规则版本、来源与 grant 版本。随后在同一事务中写入唯一内部产物、结束 attempt、更新任务为 SUCCEEDED、保存 receipt 并释放租约。失效工作者即使尚未被清理，也不能提交。
所有内部结果使用 unique merchant 加 task 加 result_kind 防重复，并在重复时比较摘要。已提交但响应丢失时，返回同一回执；不重新运行模型。retry 必须把退避后的 due_at 持久化；同一幂等命令的摘要覆盖目标、时间、重试参数等全部业务含义字段。
过期 RUNNING 恢复时先查原子回执：已提交则回读；无提交且可证明无商务外调时，在同一事务结束旧 attempt，再按截止与预算决定回 READY 或停止；商务外调已开始则 UNKNOWN。provider 请求开始不等于商务外调，未知模型用量仍保留。转 WAITING_APPROVAL 时，关闭当前 attempt、绑定 candidate、保存等待状态与释放租约也必须同事务完成。
## 16 TOP 3 审批取消与客户通知
### 16 1 审批和规则变化
规则启用、扩大数据范围、提高额度及需要人工批准的动作，经既有 MerchantCommandLog、候选和固定 executor 入口执行。FollowUp 仅关联 candidate_id 与 operation_id，模型不能调用 approve，前端也不能靠 still_authorized=true 提交。[S09]
批准绑定任务、动作内容摘要、目标、规则与政策版本、必要事实、会话版本、授权范围及有效期。默认商务动作审批截止取创建后 15 分钟与候选、事实、权限截止的最早值；到期等号即拒绝新提交。此期限不同于第 6 节的技能发布审核期限。
规则停用或不兼容换版递增 enable_epoch，按第 16.2 节的同一停止算法处理未提交任务；外调已开始但结果未确认时保持 UNKNOWN 加 stop_requested，不能直接 CANCELLED。恢复规则不复活旧任务，新规则重新评估后创建新的 occurrence。旧快照保留历史含义。普通技能升级不修改在途已固定版本，安全撤回会阻断旧版本发布。任务已提交后，批准到期不回滚该结果，也不能再次消费批准。
### 16 2 取消和未知结果
取消在服务端读取真实动作状态并增加 cancel_epoch。尚未提交的内部结果和未开始发送的内容被阻断；模型取消请求仅作尽力停止，最终以版本守卫为准。
外部调用已经开始或结果未知时，记录 stop_requested 和 UNKNOWN，继续只读核对。超时不证明失败；不能换 ID 自动重做。resolve 必须携带回执、权威查询或受审人工证据，不能仅提交“我认为没发送”。证实未执行后，仍须重新验证当前权限、时限和规则。
### 16 3 P1 客户发送门
P0 客户外发开关固定关闭。P1 须具备客户与渠道可信绑定、目的及频率授权、退订入口、有效期、冻结消息和持久回执；缺任何一项，保持工作台草稿。
发送前冻结 delivery_id、recipient_binding、purpose、payload、digest、seq 和 valid_until。审批后修改正文、收件人或商务含义，必须重新准备候选。模型不在发送阶段再次自由润色。
内部产物及其 P1 通知保留全部来源 grant、binding、data epoch 和 DerivationEdge。新增通知许可不能恢复已撤销的记忆或历史使用权；撤权和到期都使相关草稿、冻结待发载荷及后续模型运行失效，不仅删除作业才触发。需要继续通知时，从当前允许的来源重新形成候选。
每条发送流由 merchant、会话或收件权限范围、渠道定义，仅允许一条在途。它与接待回复共用发布协调门，不能新增一条绕过接管和队首约束的 cron 发送旁路。现有同步 reply outbox 需要补齐异步冻结载荷、领取、回执与核对；不能只写 dispatched 就显示客户已收到。[S05]
P1 的经营通知以扩展后的 followup_outbox 为唯一持久发送真相，由一个 dispatcher 领取；接待 JSON 记录仅作状态投影，不再另外领取该通知。既有 PENDING 映射待发，SENT 仅在有接受证据时映射 accepted，UNKNOWN 原样保留；不能由旧枚举推断已读。两条入口共用发送流协调门，投影修复只同步状态，不再次发送。 [S12]
明确未被渠道接受的临时失败，按相同 ID 和原载荷有限重试。发送开始后超时或崩溃进入 UNKNOWN 并阻塞该流；仅当渠道已验证支持同 ID 幂等恢复或权威回执查询时，才能按其契约恢复。accepted 表示目标系统接受，read 必须另有证据。不得承诺第三方客户端最终展示严格有序。
## 17 服务接口与错误约定
以下是新增服务合同，可接入现有管理 HTTP、MCP 或工作台适配器。实现时由固定动作注册表映射；不把表中的方法名当作已经存在的公开 endpoint。普通买家只能访问自己的记忆授权与删除入口，以及受控的接待查询工具。
### 17 1 接口目录
| 服务合同 | 关键输入 | 返回及授权 |
| --- | --- | --- |
| learning.createCase | source_refs outcome_refs issue_tags | case_id；管理授权和用途校验 |
| learning.propose | case_ids base_release target_behavior | candidate_id revision；只写草稿 |
| learning.evaluate | candidate_id content_hash suite_version | evaluation_id；隔离异步任务 |
| learning.review | candidate_id hash evaluation_id decision | approval_ref；真实管理员 |
| learning.publish | approved_ref expected_generation | release_id generation；CAS 激活 |
| learning.rollback | target_release expected_generation reason | 新 generation；复核兼容性 |
| learning.revoke | release_id expected_generation reason | revocation_epoch；阻断旧产物 |
| memory.grant | purpose capabilities ttl binding_proof_ref | grant_id epoch；客户明确同意 |
| memory.revokeGrant | grant_id expected_epoch | 新 grant_epoch；失效关联上下文 |
| binding.revoke | binding_id expected_epoch | 新 binding_epoch；禁止旧主体关联 |
| memory.confirm | memory_id expected_version confirmation_ref | 新版本；本人授权或受信委托 |
| memory.correct | memory_id expected_version corrected_value | 新版本及派生失效引用 |
| memory.forget | resource_scope expected_epoch | deletion_job_id；可恢复删除 |
| history.search | query sku time_range cursor limit | 受限片段；服务端注入主体 |
| automation.prepareRule | mode template|goal template trigger scope budget goal_text | 预览和 candidate_ref；requires_confirmation=true；不启用 |
| automation.activate | committed_operation_ref expected_generation | 不可变 rule_version |
| automation.pause | rule_id expected_version reason | enable_epoch；取消未提交任务 |
| automation.runOnce | rule_id expected_version occurrence_ref | 原或新 task_ref；管理权限 |
| automation.query | task_id 或 operation_id | 执行、规则与发送状态分别返回 |
| learning.submitCorrection | correction_text issue_tags case_refs base_release_id | correction_id revision；管理授权与 PII 预检 |
| learning.promoteCorrection | correction_id expected_revision | case_id；商家确认形成案例 |
| memory.grantRequest | purpose capabilities resource_scope ttl | grant_request_id 确认短语 有效期；服务端生成 |
| memory.grantConfirm | grant_request_id confirmation_ref session_proof expected_version | grant_id grant_epoch；一次性消费 |
| customer.deletionRequest | resource_scope expected_epoch | deletion_job_id；客户本人或受信委托 |
| memory.listMine | cursor limit | 当前主体有效记忆的最小字段；不返回其他主体 |
| memory.list | subject_scope cursor limit | 当前商家有权限的记忆摘要；分页绑定 grant epoch |
| binding.linkChallenge | source_session target_subject_assertion scope | challenge_id expires_at；5 分钟单次 |
| binding.linkConfirm | challenge_id proof | binding_id binding_epoch；双方范围验证 |
| automation.list | status cursor limit | 规则与任务摘要；按商家隔离；不返回内部 token |
| automation.get | rule_id 或 task_id | 触发、产物、审批、发送状态；敏感字段脱敏 |

worker 专用接口包括 ingestTrustedEvent、evaluateAndSchedule、claimDue、commitInternalResult、reconcileOutcome；不注册到接待模型。买家接待新增工具仅包括 load_reception_skill、recall_customer_context、search_customer_history，以及写入候选的 propose_customer_memory。后台经验提炼运行域另有 propose_learning_candidate，不能混入买家工具集。候选写入不表示已确认记忆或已批准技能。 规则入口统一使用 automation 命名空间；现有 src/merchant-runtime/jobs.ts 的 MerchantJobs.runOnce(name) 仅作为定时唤醒骨架，不暴露为服务合同。
### 17 2 通用命令和幂等
所有变更包含 command_id、schema_version、expected_version 或 expected_generation。merchant、actor、subject 和权限由服务端提供。时间使用 RFC3339 UTC；状态与原因使用有限枚举；金额继续用现有核心单位和契约，不能新增浮点价格通路。
幂等作用域为 merchant 加 actor 或服务主体加 operation 加 command_id；规范化业务参数生成 request_digest。同键同摘要返回原结果，同键异摘要返回 idempotency_conflict。查询及恢复不能重建新的业务动作。
写入成功返回 command_id、resource_ref、version、outcome、receipt_ref 和 trace_id；异步操作返回 accepted 与 task_ref，不返回 completed。重复请求在授权仍有效且载荷仍保留时复用原结果；删除或撤权后只给允许公开的状态，不泄露已删除正文。
### 17 3 内部错误码
| 错误码 | 语义 | 对外行为 |
| --- | --- | --- |
| access_denied | 当前主体无权执行 | 不披露其他主体资源是否存在 |
| source_unavailable | 来源删除 过期 或无法验证 | 请求补充信息或生成内部待办 |
| unsupported_capability | 工具 槽位 或输出契约不支持 | 不发布依赖该能力的技能 |
| version_conflict | CAS 或依赖版本变化 | 回读当前状态，不覆盖 |
| stale_context | grant data rule 或会话快照失效 | 丢弃旧结果，按新权限重新计算 |
| evaluation_failed | 评测不达门槛 | 保留当前技能 |
| approval_expired | 准确绑定的批准已失效 | 需要重新准备候选 |
| budget_exhausted | 全局 商家 或任务额度不足 | 排队或确定性降级 |
| execution_unknown | 可能已发生，证据不充分 | 只读核对，禁止盲目重试 |
| idempotency_conflict | 同命令键不同业务内容 | 明确冲突并保留原记录 |

这些是内部服务错误，不向 KNP 新增 action 或 wire 错误。协议出口由现有适配器使用已支持结果；具体映射在契约测试中冻结。
## 18 数据存储与迁移
### 18 1 最小持久化方案
在现有商家 state.sqlite 的版本化迁移中加入下表。客户内容使用独立表和 ACL 服务，与 owner Principal Memory 逻辑隔离；不把所有客户塞进既有单 principal 库。P0 不额外引入消息中间件或向量数据库。
迁移账本（D-M0-05）：learning、customer-memory、operations-jobs 使用独立账本（建议 learning_schema_migrations、customer_memory_schema_migrations、operations_jobs_schema_migrations），各自记录 version、applied_at、checksum；不得复用 merchant_ops_schema_migrations 的版本号。客户记忆、来源治理、删除登记与备份登记在同一模块账本内幂等创建。
| 表组 | 建议记录 | 关键唯一约束 |
| --- | --- | --- |
| 身份用途 | customer_subjects subject_bindings data_grants data_scopes | merchant 与可信 issuer subject binding |
| 来源治理 | source_refs derivation_edges deletion_jobs | 对象版本与派生边唯一 |
| 经验技能 | experience_cases skill_candidates evaluations reviews skill_releases release_bindings | merchant audience skill 与 generation |
| 客户记忆 | customer_memories memory_evidence memory_events history_index | merchant subject memory version |
| 主动规则 | automation_rules event_inbox rule_evaluations automation_cursors | merchant rule version trigger_key |
| 执行产物 | operation_artifacts 及现有 followup 扩展 | merchant task result_kind |

访问必需的 merchant、subject、状态、版本、有效期和授权域使用独立列与复合索引。大正文放受控 payload 或有界文本，禁止把所有权限字段隐藏在模型 JSON 中。每张客户表使用带作用域的查询函数；代码审查拒绝无作用域的通用 getById 给接待调用。
followup_tasks 增加 rule/version、revision、cancel_epoch、deadline、snapshot_digest 与 candidate/operation 引用；attempt 增加 worker、fencing、input snapshot 和 outcome evidence。新增结果提交事务与现有 repository 共用连接，避免嵌套事务语义不清。
留存字段：接待原文/片段记录 created_at 与 purge_at，purge_at=min(会话关闭+分类期限, 采集+90天)；后台读取、重试、摘要和索引更新不得延长。删除登记保存 180 天，滚动备份最长 35 天，恢复前先重放删除登记。
### 18 2 索引与存量迁移
仅为仍在留存期内、具有可验证主体绑定且已获准使用的历史数据建立索引。不得从旧聊天推断客户身份或自动补写同意。索引是可重建投影，包含来源版本和权限 epoch；索引不等于新的保留权。
现有接待 JSON 暂不整体迁移。通过稳定 source_id 和版本摘要建立只读投影、同步游标与校验任务。来源更正或删除时先设置共享封存标记，旧索引即刻不可读，再异步清理。更新索引的迟到回调必须校验 epoch。 投影必须记录 source_version、observed_at 与最大允许延迟；缺口或延迟超限时按 data_incomplete 处理，补读后重评。
同库事务只承诺同库原子性。跨 JSON、Pi 调用、KNP 账本与外部渠道依靠命令 ID、准备记录、回执与恢复；不能宣称端到端恰好一次。发生迁移失败时功能保持关闭，原接待继续运行。
## 19 并发故障与恢复
| 故障或竞态 | 必须处理的结果 |
| --- | --- |
| 两管理员同时发布技能 | 只有一个 generation CAS 成功，另一个回读，不覆盖 |
| 模型期间撤权或删除 | 旧 grant 或 data epoch 不能通过最终发布门 |
| 模型期间新增客户消息 | 按 conversation revision 拒绝旧需求提案，重新理解 |
| 租约过期但 sweep 未执行 | 依旧禁止旧 worker 开始动作或提交，不能只比较 token |
| 内部产物写入后事务失败 | 产物 attempt 任务和 receipt 一起回滚 |
| 提交成功但 HTTP 响应丢失 | 按同 command 或 task 返回原 receipt，不重跑模型 |
| provider 返回但用量缺失 | usage_state 为 unknown 或有依据的估算，不记为免费 |
| 外发开始后超时或崩溃 | UNKNOWN，保留原 ID 及载荷，只读核对 |
| 队首被证明未发且已过期 | 抑制并留原因；依赖后继先失效，再生成完整独立内容 |
| 从旧备份恢复 | 先应用最新删除与撤销登记，再开放索引 模型和发送 |

P0 只支持当前单实例写模型，仍必须通过双连接和旧 worker 迟到测试。部署第二进程必须拒绝共享写所有权；不得通过复制 SQLite 或依赖内存锁扩容。平台多商家服务另行验证公平调度和物理隔离，不能只凭表中存在 merchant_id 宣称支持。
单写者所有权（D-M0-08）：state.sqlite 增加实例所有权表（merchant_id、owner_id、fencing、heartbeat_at、lease_expires_at、state）；启动时 CAS 获取并心跳续约，第二进程获取失败即 fail-closed，不得提供写入能力；旧 worker 的提交仍受 fencing 和 epoch 校验。所有权表与任务租约分开，前者是实例级，后者是任务级。
旧版本软件回滚时，保持新增功能关闭，并确保撤权与删除守卫仍可执行。若旧二进制不能识别最新封存记录，先完成兼容补丁或禁止读取相关数据；不能为了回滚把删除登记恢复成旧版本。
## 20 预算配置与观测
### 20 1 运行初值
以下均为新增能力的试点上限，不是性能测量结果。新能力的限制叠加在既有平台、商家及 provider 配额之下；不能通过另一个 worker 或另一个用途获得额外全局额度。
| 配置 | 建议初值 | 说明 |
| --- | --- | --- |
| 功能开关 | learning memory jobs 分别关闭 | 显式试点启用，P0 customer_delivery 不可启用 |
| 新后台模型并发 | 每商家 1 个 | 前台接待优先，受全局上限约束 |
| 新后台每日调用 | 20 个逻辑 run | 计数上限；按模板优先级排队；额度不足保持 PENDING 并显示 budget_exhausted |
| 后台每日 token | input 100000 output 12000 | 记账日期用固定商家时区；每日上限为硬约束，单 run 预留 input 5000/output 600 |
| 单 run | 30 秒硬截止 3 回合 6 次工具 | 最多 4 个 provider attempts 含重试 |
| 单 run token | input 24576 output 3072 | 单次最多 input 8192 output 1024 |
| FollowUp 租约 | 60 秒 | 剩余租期不足运行和提交余量时不发起调用 |
| 扫描与监测 | 扫描 30 秒 监测最短 5 分钟 | 来源未变化时 0 模型调用 |
| 重试 | 任务最多 3 次 attempt | 基础 15 秒 上限 5 分钟 退避抖动 |
| 客户检索 | 5 片段 2000 中文字符 | 权限过滤后提取并计入上下文预算 |
| 技能加载 | 2 个 3000 中文字符 | 工具次数及上下文均计入现有接待预算 |
| 后台 run 预留 | input 5000 output 600 | 准入预留，未用释放；20 run 合计 100000/12000 |
| 单写者所有权 | SQLite 所有权表 + 心跳租约 | 第二进程 fail-closed；与任务租约分开 |
| 迁移账本 | learning/customer-memory/operations-jobs 独立 | 不与 merchant_ops_schema_migrations 混用 |

接待的模型回合、工具、截止时间继续遵循原配置，新工具不能静默放大限额。模型输出后未知用量保守占额，重启不退款或清零。价格目录缺失时 cost_state 显示 unknown，不以 token 数伪造精确费用。
隔离评测采用独立、显式创建的评测任务和预算，不混入生产经营日配额。以第 6 节 20 案例、每例 3 次、基线及候选两组计算，至少需要 120 个逻辑回放 run。创建任务时展示调用数量与预算上限，逐次准入；额度不足显示评测未完成，不能把已通过子集当完整通过。
### 20 2 观测口径
| 指标 | 分子与分母 | 解释限制 |
| --- | --- | --- |
| 重复纠错率 | 同类问题再次被商家纠正次数 除以该类可评价接待数 | 固定分类版本，不把沉默视为正确 |
| 记忆有效续接率 | 正确恢复并经本轮确认的需求数 除以应支持续接的请求数 | 另报无权限 无历史 歧义与检索失败 |
| 无效追问率 | 已有充分证据仍重复询问的次数 除以总追问数 | 由冻结规则和抽样人工复核 |
| 任务按时处理率 | 截止前生成有效产物数 除以到期且获授权任务数 | blocked paused unknown 分开报 |
| 有效任务成本 | 实际模型用量和可确认费用 除以有效产物数 | unknown 用量与费用单独展示 |
| 数据和商务硬门 | 越权泄露 未经批准承诺 错误当前事实的次数 | 任一次触发停止相关功能并调查 |

每个模型 attempt、规则评估、技能使用和记忆检索记录 trace_id、版本和原因码，不记录隐藏推理。日志默认不含客户原文、密钥或底价。报表区分商家申报订单与外部核验订单，询报价或非约束性接受不自动计入成交。[S09]
## 21 商家工作台与客户交互
### 21 1 经验改进
页面显示待审改进、影响的接待场景、修改前后步骤、代表性案例、测试结果和已发布版本。商家可以纠正问题、编辑候选、查看差异、批准发布、拒绝和回滚。涉及未支持能力时，说明需先补商品资料或接待能力，不展示为“智能体已经学会”。
经验改进页增加“提交纠正”入口：选择问题类型、填写纠正说明、可选关联案例；展示 PII/底价预检结果和“形成案例/仅保留草稿”两个动作。候选编辑后必须重新评测，页面明确旧评测与旧批准失效。
### 21 2 客户记忆
页面只显示当前商家有权限管理的客户记忆及其来源、确认时间和有效期。客户侧提供“记住这项偏好”“这项不对”“删除记忆”“停止跨会话记忆”等明确操作。关闭记忆后基本询价可用；删除进度区分即时停止使用与仍在处理的副本。
客户侧入口落在目标宿主已支持的通道：文本通道使用 §9.2 的确认短语与固定指令；卡片通道使用同一 grant_request_id 与 confirmation_ref。客户自助列表只展示本人记忆；工作台只展示当前商家有权限的记忆。
### 21 3 经营任务
创建页先展示模板和自然语言目标，再展示可读预览：何时检查、检查哪些商品或商机、产出什么、由谁查看、最多运行多少次。P0 输出位置固定为工作台。客户通知在 P0 显示未开放，不允许通过输入收件人绕过。
规则创建统一走 automation.prepareRule：模板模式直接生成候选，自然语言模式由受限模型生成候选；页面展示触发时间、范围、输出、次数、有效期和假设，商家确认后调用 automation.activate。模型不能直接启用规则或扩大收件人。
任务详情分别展示触发原因、采用的数据、建议、内部完成状态、需要的商家决策，以及 P1 的发送结果。暂停只停止未开始的动作；对于已经开始但结果不明的动作，显示“已停止继续发送，正在核对结果”，不能显示“已撤回”。
后台不向商家展示原始 token、fencing 或数据库术语作为必填项。预算可用运行次数和费用上限表达；技术诊断留在详情。每个失败状态都给出明确的可执行下一步。
## 22 实施工作包与发布门
### 22 1 建议开发顺序
| 工作包 | 主要产物 | 依赖与完成条件 |
| --- | --- | --- |
| M0 契约冻结 | 能力矩阵 64 条验收 字段和权限字典 M0 决议记录 | 确认目标部署基线及实际启用模式；D-M0-01–10 与参数冻结已记录 |
| M1 共性控制 | ActorContext grant epoch ContextGuard 来源删除 预算适配 独立迁移账本 单写者所有权 | 通过跨主体 撤权竞态 幂等 重启 第二进程拒绝与旧 worker 迟到测试 |
| M2 TOP 1 | QuestionSpec 候选评测审核 发布目录 接待加载 技能摘要 商家纠正入口 | 真实 Pi 版本对照回放，固定技能可回滚 |
| M3 TOP 2 | 组织/代理范围绑定 显式同意 记忆确认 历史检索 删除传播 | 组织/代理范围隔离与同 Agent 多主体隔离通过；个人记忆待 E1 |
| M4 TOP 3 | 规则与inbox worker 原子完成 工作台产物 automation.prepareRule | 双 worker 故障注入与确定性降级通过 |
| M5 试点发布 | 真实商家配置 观测面 运行手册 回退演练 | P0 全部适用用例通过并有部署证据；个人记忆未启用原因已记录 |
| M6 P1 外发 | 客户授权 渠道适配 冻结载荷 顺序及回执 | P1 用例及目标渠道未知结果核对通过 |

本节工作包已按 D-M0-01–10 调整：M1 增加独立迁移账本与单写者所有权表；M2 增加技能摘要与 submitCorrection；M3 按组织/代理范围验收；M4 统一 automation.prepareRule。
M0–M6 的工作量以团队排期为准，不在本文件给出人日承诺；M3 依赖 E1 宿主证据，M5 依赖真实模型、目标商家与宿主联调。
TOP 1 至 TOP 3 表示产品价值顺序。M1 是共同前提，M3 与 M4 可在 M1 后并行；先交付内部经营任务不必等待客户外发。每项工作包包含代码、迁移、契约测试、配置、工作台交互和恢复说明，不以接口占位或演示提示词计完成。
### 22 2 发布前检查
新增功能默认关闭，在与生产隔离的夹具环境完成回归和真实模型回放。不能把现有 advisory 配置当成已实现的影子模式；若需要影子评测，单独实现只读回放入口，确保不产生第二份客户回复。[S03]
试点先选择一个商家及有限技能、可信客户、固定经营模板。分别验证开关关闭、模型故障、预算耗尽、来源过期、撤权删除、服务重启和版本回滚。M5 验收至少包含一条真实 Pi 技能选择链、一条真实组织/代理范围跨会话续接链，以及一条真实业务事件到工作台产物链。
证据包记录提交 SHA、包和模型版本、schema 与配置版本、部署模式、用例 ID、输入与预期、实际结果、trace 和回执引用。涉客户数据的原件按留存规则处理。没有执行的用例标 pending，不能用历史测试数量或 fake provider 结果填为通过。
### 22 3 回退与交付物
各模块可独立关闭。关闭技能改进后使用仍有效的稳定技能或原接待；关闭客户记忆后不再读写跨会话上下文；关闭经营任务后停止新任务，保留已提交结果并继续只读核对 UNKNOWN。回退不重置预算、审批、幂等键、删除登记或已经发生的外部动作。
实施交付包括模块代码与迁移、上述服务与工具 schema、QuestionSpec 模板、三个初始技能、四个固定经营模板、版本化评测集、工作台界面、观测指标和运行手册。工程验收以本文件及对应版本的契约为准；新增协议能力或扩大商务授权需另行设计和验证。
## 23 M0 决议与参数冻结
### 23 1 决议摘要
| 编号 | 决策项 | 决议 | 状态 |
| --- | --- | --- | --- |
| D-M0-01 | 目标宿主主体能力 | 尚未确认；P0 按组织/代理范围记忆，保留个人主体接入点 | 有条件通过，E1 证据待补 |
| D-M0-02 | 客户确认通道 | 文本一次性短语 + 宿主卡片双通道，共用 grant_request 与 confirmation_ref | 已定 |
| D-M0-03 | 商家主动纠正入口 | 新增 learning.submitCorrection，再 promoteCorrection 形成案例 | 已定 |
| D-M0-04 | 技能发现方式 | 运行快照注入 skill_summaries（≤5 项/600 字） | 已定 |
| D-M0-05 | 迁移账本 | 学习/客户记忆/经营任务使用独立迁移账本 | 已定 |
| D-M0-06 | 评测场景通过 | 目标场景 3/3 通过且无硬门；不设结果后例外 | 已定 |
| D-M0-07 | 自然语言经营目标 | 只生成规则候选，商家确认后由固定 executor 启用 | 已定 |
| D-M0-08 | 单写者所有权 | SQLite 所有权表 + 心跳租约，第二进程 fail-closed | 已定 |
| D-M0-09 | M0 参数冻结 | policy_version=m0-pilot-1；预算/上限冻结，留存待隐私确认 | 已定 |
| D-M0-10 | 规则入口命名 | 统一 automation.prepareRule 的 template|goal 双模式 | 已定 |

### 23 2 参数冻结（policy_version=m0-pilot-1）
| 类别 | 参数 | 冻结值 | 说明 |
| --- | --- | --- | --- |
| 版本 | policy_version | m0-pilot-1 | 任何变化递增，不覆盖历史 |
| 开关 | learning/memory/jobs | 默认关闭 | 显式试点启用 |
| 开关 | customer_delivery | 固定关闭 | P0 不启用客户外发 |
| 预算 | 后台并发 | 每商家 1 个 | 前台接待优先 |
| 预算 | 每日逻辑 run | 20 | 计数上限，不保证每个 run 用满 token |
| 预算 | 每日 token | input 100000 / output 12000 | 硬约束；按商家时区记账 |
| 预算 | 单 run 预留 | input 5000 / output 600 | 20 run 合计 100000/12000 |
| 预算 | 单 run 硬上限 | input 24576 / output 3072 | 3 回合合计 |
| 预算 | 单次调用上限 | input 8192 / output 1024 | 单回合 |
| 预算 | 截止/回合/工具 | 30 秒 / 3 回合 / 6 工具 | 最多 4 个 provider attempts |
| 预算 | 租约/扫描/监测 | 60 秒 / 30 秒 / 5 分钟 | 来源未变化 0 模型调用 |
| 预算 | 重试 | 3 次；基础 15 秒；上限 5 分钟；抖动 | 退避后 due_at 持久化 |
| 预算 | 评测 | 120 个逻辑回放 run | 独立评测预算，不占经营配额 |
| 技能 | 摘要 | 5 项 / 600 中文字符 | 不含正文，按优先级截断 |
| 技能 | 加载 | 2 个 / 3000 中文字符 | 超出拒绝，不静默截断 |
| 检索 | 片段/正文 | 5 个 / 2000 中文字符 | 权限过滤后提取 |
| 检索 | 查询/游标/预算 | 256 字 / 5 分钟 / 500 毫秒 | 默认 30 天，取授权与保留期交集 |
| 审批 | 商务动作 | 900 秒 | 与现有接待配置一致 |
| 审批 | 技能待审/发布 | 7 天 / 24 小时 | 取更早截止，到期即拒绝 |
| 留存 | 会话/联系/用量 | 30 / 7 / 90 天 | 采集后 90 天绝对上限 |
| 留存 | 偏好/案例/调试 | 90 / 30 / 0–7 天 | 隐私/法务确认后生效 |
| 留存 | 删除登记/备份 | 180 / 35 天 | 恢复前先重放删除登记 |

### 23 3 规则入口命名
规则候选统一走 automation.prepareRule，支持 mode="template" 与 mode="goal"；template 可确定性生成，goal 调用受限模型。两者都只返回 candidate_ref、预览、假设和 content_hash，requires_confirmation=true；只有 automation.activate 能启用。jobs.proposeRule 不单独存在；现有 src/merchant-runtime/jobs.ts 的 MerchantJobs.runOnce(name) 仅作为定时唤醒骨架，不暴露为服务合同。
### 23 4 宿主证据请求 E1
目标宿主需提供：按人 subject_ref 的生成、唯一性、生命周期和撤销；issuer 与密钥发现/轮换/吊销；assurance_class 与同一 Agent 代理多人时的 on_behalf_of；当前会话归属证明；撤销传播时限；重放、过期、跨商家和共享 token 的负向测试；示例断言、撤销契约和测试环境。证据齐备并通过本地测试后，另立 D-M0-01A 升级个人记忆；未回复或证据不足则维持组织/代理范围。
### 23 5 未关闭事项
1. E1 宿主证据；2. 留存期限待隐私/法务确认；3. 卡片通道依赖宿主排期，文本路径先交付。
### 23 6 新增验收
附录 A 新增 A13–A20、B13–B16、C15–C16、X11–X12，共 64 条。新增用例沿用原证据要求：版本、输入、实际结果、trace、持久对象和回执；未执行标 pending。
## 附录 A 验收矩阵
共 64 条用例，均为待执行验收合同。P0 必须通过所有适用分支，并证明 P1 客户外发无法提前启用；C12 至 C14 的真实客户发送分支在 P1 执行。每例保存版本、输入、实际结果、trace、持久对象及回执。使用可注入时钟、两个独立数据库连接、可控 provider、来源适配器和崩溃点验证；产品质量补真实模型回放。
### A1 TOP 1 经验学习
| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| A01 | 仅有记忆授权，使用客户案例提炼技能 | 用途校验拒绝，原文不进入模型；有最小拒绝记录 |
| A02 | 客户文本要求更改底价或自动发布技能 | 只作案例数据；无策略与发布工具，当前商业规则不变 |
| A03 | 候选含电话、底价、真实客户案例或凭据 | 预检及人工审核阻断；接待端未加载原始案例 |
| A04 | 技能依赖未注册问题、任意 URL 或 shell | unsupported_capability；不能靠技能文本获得工具 |
| A05 | 配置数量单位 QuestionSpec 后重复回放 | 正确使用模板、当前输入证据与单位规则，无自由问句旁路 |
| A06 | 目标场景变好，但越权或承诺硬门失败 | 整体评测不通过；平均质量分不能覆盖硬门 |
| A07 | 评测后改正文或工具契约，复用旧批准 | hash 或兼容性校验失败，需新评测与批准 |
| A08 | 买家请求批准，管理员并发发布两个版本 | 买家拒绝；只有一次 CAS 成功，审计记录真实发布人 |
| A09 | 接待请求 owner 技能、他店技能或草稿 | 只加载本轮白名单已发布版本；不从 owner 目录兜底 |
| A10 | 运行时普通升级，再紧急撤回旧技能 | 普通升级不混版本；撤回后的旧运行被发布门阻断 |
| A11 | 回滚已删除、撤回或不兼容版本 | 回滚拒绝；合法回滚新增 generation 而非覆盖历史 |
| A12 | 源案例删除后读取旧报告并尝试再发布 | 派生失效；不以旧摘要证明原文，不复活失效版本 |
| A13 | 纠正正文含手机号、详细地址、底价或凭据 | 入库前拒绝或脱敏；不进入模型；保留最小拒绝记录 |
| A14 | 商家只提交抽象纠正、未关联客户案例 | 可形成 case 与候选；不要求客户记忆或历史授权 |
| A15 | 商家 B 读取/编辑商家 A 的 correction_id | 访问拒绝；不泄露存在性与正文 |
| A16 | 候选已生成后商家编辑纠正 | 新 revision；旧候选 STALE；旧评测与批准失效 |
| A17 | 买家问题涉及单位歧义，快照含对应技能摘要 | 模型从摘要选择正确 skill_key；加载冻结产物；记录选择理由 |
| A18 | 模型请求未绑定、已撤回或 owner 目录中的技能 | access_denied 或 unsupported_capability；不读取正文；无目录兜底 |
| A19 | 单轮第 3 次加载，或正文合计超过 3,000 字 | 拒绝加载；不静默截断；记录预算原因 |
| A20 | 技能依赖未在运行白名单中的工具或未注册槽位 | 发布时 unsupported_capability；接待端不可加载 |

### A2 TOP 2 客户记忆
| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| B01 | 匿名 T0 已验签、同 IP 或同昵称的两次访问 | 只恢复合法当前会话，不自动建立个人跨会话档案 |
| B02 | 同一买方 Agent 代理两人，缺少被代理主体证明 | 不合并个人档案；仅使用获准代理或组织范围 |
| B03 | 绑定匿名会话，挑战过期或重复消费 | 拒绝非法关联；有效绑定仅关联明示范围且不改历史 actor |
| B04 | 直接猜其他客户 memory ID、游标或历史引用 | 访问拒绝，不泄露存在性、结果数或摘要 |
| B05 | 设置相同 scope 或高相关性并跨客户检索 | 硬过滤先于排序；其他客户内容从未进入结果和模型 |
| B06 | 有记忆授权但无历史或通知授权 | 不能检索被排除历史、提炼技能或建立主动通知 |
| B07 | 模型从多次行为推断偏好或采购数量 | 保持候选，不伪造确认回执和本轮采购条件 |
| B08 | 客户纠正偏好，旧模型回调稍后返回 | 新版本胜出；旧上下文不能持久化或发布 |
| B09 | 说上次那款，历史有多个 SKU 或旧报价 | 歧义追问；报价从当前事实重取，不把询价说成购买 |
| B10 | 中文双字词、长句、SKU、标点和同义词查询 | 有可解释命中与 no_match；服务故障单列 unavailable |
| B11 | 读取之后撤权或删除，继续分页和模型回合 | 旧游标和上下文失效，新增 provider 请求及发布被阻断 |
| B12 | 删除后用旧索引、摘要、导出或备份恢复 | 先封存再清理，迟到索引不复活；未完成副本明确 pending |
| B13 | 客户回传确认短语后重放同一短语，或在另一会话使用 | 首次创建 grant；重放与跨会话均拒绝；保留一次性消费记录 |
| B14 | 自由文本“好的/可以”，或模型把客户话解释为同意 | 不创建 grant；只能新建 grant_request；无 confirmed 记忆 |
| B15 | 客户确认前正文被篡改，或卡片回调篡改 grant_request_id/confirmation_ref | 摘要或绑定校验失败；不创建 grant；记录拒绝原因 |
| B16 | 删除请求发生在模型运行或待发草稿期间 | 先封存并递增 epoch；旧运行发布门被阻断；区分已停止与 pending 副本 |

### A3 TOP 3 主动经营
| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| C01 | 同来源事件并发重复 100 次，随后同 ID 改内容 | 单一事件评估任务；同摘要不增 revision，异摘要冲突 |
| C02 | v8 后收到 v7，或无序版本事件且补读失败 | 不回滚事实；无权威结果只产生缺证待办 |
| C03 | 停机跨三个日报窗口并回拨时钟 | 按规则只补最新窗口，记录 missed，不重复 occurrence |
| C04 | 无变化、阈值未达与有效变化三组输入 | 前两组 0 模型调用；有效组有真实 Pi 运行和合法产物 |
| C05 | 两 worker 领取，旧者过期但 sweep 未运行 | 只有有效 owner 和 fence 可写；过期者不能开始动作 |
| C06 | 在产物 attempt 任务更新与提交之间崩溃 | 同库全成功或全回滚；无成功任务缺少产物回执 |
| C07 | 提交后响应丢失，重发同 command | 返回原 receipt；无新产物和重复模型运行 |
| C08 | 429 超时 重启 或 Retry After 越过截止 | 持久退避，额度不清零；截止后不新调用或执行 |
| C09 | 模型中停规则、改数据、撤授权或取消 | 旧快照不能提交；保留明确原因和真实历史结果 |
| C10 | 假 still_authorized，审批恰在截止时消费 | 服务端重读拒绝；等待释放资源，过期不当作拒绝交易 |
| C11 | 事件要求代表买家接受或自动下单 | P0 仅工作台产物，客户发送与商务越权调用为 0 |
| C12 | P0 尝试启用发送，P1 缺订阅或授权已撤 | P0 不可启用；P1 未通过发送门不出网 |
| C13 | P1 发送开始后超时、取消或重启 | UNKNOWN 保留 ID 与载荷，stop 不伪装撤回；只读核对 |
| C14 | P1 同流两条通知，首条未知或 accepted | 未知不被越过；accepted 与 read 区分，重试不换内容 |
| C15 | 投影延迟超过上限、窗口内部分询价未投影 | 结果为 data_incomplete；日报标注缺失范围；不记为 no_change；补读后可重评 |
| C16 | 同日日报与大量草稿同时 eligible，额度不足 | 按优先级生成；其余保持 PENDING 并显示 budget_exhausted；前台额度未被占用 |

### A4 共性控制与上线
| 编号 | 输入或故障 | 预期与证据 |
| --- | --- | --- |
| X01 | 两商家使用相同对象 ID、缓存 key 或输入文本 | 返回与日志均无跨商家内容；权限由服务端注入 |
| X02 | 客户身份字段或 trusted 标志由模型自行填入 | 严格 schema 拒绝额外字段，不能提升权限 |
| X03 | 价格库存交期已变或来源过期，记忆仍旧 | 发布只用当前核心事实；过期无依据时澄清或转人工 |
| X04 | provider 故障且全部新能力关闭 | 既有合法结构化路径保持可用，无额外商务动作 |
| X05 | provider 有输出但 usage 或费用目录缺失 | unknown 或有依据估算；不显示免费，不无条件退额 |
| X06 | 改时区、重启、暂停恢复或并发争用配额 | 不重置额度，后台不抢占前台约定份额 |
| X07 | 变更同 command 的目标、due 或重试参数 | idempotency_conflict，原命令及结果不被覆盖 |
| X08 | 数据守卫不可用、旧 worker 回调或旧备份启动 | 私有数据与新增动作关闭；允许合法公开确定性路径 |
| X09 | 真实模型分别走技能 记忆 经营三个场景 | 完整 trace、工具与发布回执；不以 fake 结果替代 |
| X10 | 回退二进制后读取新封存数据或重试旧任务 | 删除和权限仍有效，账本与 UNKNOWN 不重置 |
| X11 | 回退到不识删除登记/封存记录的旧二进制 | 旧二进制禁止读取相关数据或先安装兼容补丁；删除与权限仍有效；记录冻结/补丁证据 |
| X12 | 第二进程启动并尝试共享写所有权 | 获取所有权失败 fail-closed；不写数据；记录拒绝原因 |

## 附录 B 实现依据
Kiwi 链接固定到提交 366ef681800322446db21bd1b510c1d810964508，核对日期为 2026年11月15日。Hermes 用于机制参考，不作为 Kiwi 的权限或执行保证。链接说明当前代码与设计的关系；新增设计以正文和验收为准。
- S01 软件包与依赖版本
- S02 Pi 接待工具与计划约束
- S03 接待装配与模式  接待引擎
- S04 回复计划发布器
- S05 会话存储  同步回复记录  留存作业
- S06 技能 Registry  技能工具
- S07 Principal Memory 数据模型  记忆存储与相关性评分
- S08 FollowUp 服务  持久化  状态机
- S09 经营门面  命令与执行  订单事实服务
- S10 接待验收映射与历史记录
- S11 OpenInquirySession  T0 验证器  正式身份绑定
- S12 商家对话入口  已有恢复 worker
- H01 Hermes Skills 官方说明
- H02 Hermes Memory 官方说明
- H03 Hermes Cron 官方说明
- D01 用户已确认的 TOP 1 至 TOP 3 建议，以及《Kiwi 商家 AI 智能体设计 v1.1》2026年11月3日。此增量设计以当前源码修正接入方式，并保留前版的商务和数据治理边界。
## 附录 C 核心契约示例
本附录是拟议内部 schema 的最小约束和例子，不改变 KNP。示例 ID 为占位值，正式值由服务端生成。实现需用项目现有 schema 工具生成严格校验和类型；未知字段拒绝，枚举不可由模型扩展。
### C1 固定字段约束
| 字段或对象 | 最小约束 |
| --- | --- |
| ID 与版本 | ID 不透明且有长度上限；version 为正整数；创建命令 expected_version 为 0 |
| content_hash 与 digest | 对校验后的规范内容计算 SHA256；字段删除或默认值处理在 schema 中固定 |
| SkillCandidate steps | 1 至 12 步；每步 action_ref 来自允许集；单技能正文最多 3000 中文字符；单轮 2 个技能合计仍不超过 3000 |
| 技能说明 | description 不超过 400 字符；仅合成或审核过的非个人例子 |
| SourceRef | 来源对象存在且版本可访问；来源 ID 不是模型自证，禁止任意 URL 回读 |
| MemoryItem value_ref | 按 namespace 白名单结构校验；单项不超过 500 字符；最多 10 个证据引用 |
| QuestionSpec | slot 仅 sku quantity unit；固定模板、候选类型和适用条件 |
| HistoryQuery | 文本最多 256 字符；最多 5 片段；实际授权范围服务端计算 |
| OperationAdvice | 仅 internal_summary internal_draft data_issue no_action；不含 recipient 和执行命令 |
| 规则 predicate | 仅固定模板字段与比较符，禁止 SQL 表达式或可执行代码 |
| ContextSnapshot | 含 skill_bindings grant_versions source_versions data_scope_epochs 数组和 binding_epoch，覆盖全部来源 |
| 日期与截止 | RFC3339 UTC；now 等于 expires_at 或 deadline 时即失效 |

### C2 接待技能候选片段
{
  "schema_version": 1,
  "skill_key": "trial-unit-clarification",
  "audience": "customer_reception",
  "steps": [
    {"action_ref": "get_commercial_facts"},
    {
      "action_ref": "ask_registered_question",
      "question_id": "confirm_unit_v1",
      "guard_ref": "unit_unresolved"
    }
  ],
  "question_schema_version": 1,
  "required_tools": ["get_commercial_facts"],
  "source_case_ids": ["case_example"]
}
服务端补齐 merchant、基线版本、适用范围、摘要和审核信息。guard_ref 与 action_ref 均来自固定注册表；该示例不包含任何包装倍率或自动折扣。
### C3 历史结果片段
{
  "schema_version": 1,
  "status": "ok",
  "hits": [{
    "document_ref": "history_example",
    "source_version": 3,
    "historical": true,
    "is_current": false,
    "kind": "prior_inquiry",
    "sku": "SKU-EXAMPLE",
    "occurred_at": "2026-11-10T02:00:00Z"
  }],
  "context_snapshot_ref": "snapshot_example"
}
返回值不是 CommercialFactRef，不能直接交给 show_commercial_terms。公开表述必须保留“曾询价”的历史含义，不扩写成“曾购买”。 context_snapshot_ref 指向 §4.2 的 ContextSnapshot；引用字段统一以 _ref 结尾，正文对象名不带 _ref。
### C4 经营规则与建议
{
  "schema_version": 1,
  "template": "unfinished_inquiry_digest",
  "trigger": {
    "kind": "daily_local",
    "local_time": "09:00",
    "timezone": "Asia/Shanghai"
  },
  "action_type": "internal_summary",
  "window": "previous_local_day",
  "max_runs_per_day": 1
}
该结构只形成待确认规则，启用须真实商家管理授权。模型运行后的建议另存为 OperationAdvice，不把规则改写成已执行结果。
{
  "schema_version": 1,
  "kind": "internal_draft",
  "evidence_refs": ["need_example_v4"],
  "reason_code": "missing_required_slot",
  "question_id": "confirm_quantity_v1",
  "next_action": "merchant_review"
}
### C5 内部结果提交伪代码
BEGIN IMMEDIATE
  find receipt by scoped command key
  if receipt exists:
    require same request_digest and current read permission
    COMMIT read transaction
    return permitted original result; no model rerun
  read task, live lease, rule, grant and source versions
  require RUNNING and exact owner, fence, revision, epoch
  require now < lease_expires_at
  require now < task.deadline_at
  require current authorization and permitted snapshots
  validate typed result and all evidence references
  insert unique internal artifact and compare digest
  close matching attempt with artifact receipt
  mark task SUCCEEDED and release lease
  commit evaluation completion and receipt
COMMIT
任何一步失败均回滚；模型和外网请求不能位于此事务中。P1 外发先持久标记发送开始，再调用渠道，结果不明进入 UNKNOWN；不把跨网络过程塞进本伪代码并声称原子。