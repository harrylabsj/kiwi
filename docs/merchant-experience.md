# Kiwi Merchant Experience

本文描述 Kiwi 当前已实现的 Merchant Experience。该能力建立在现有 AgentKernel、
WriteApprovalCandidate、Private Vault、Negotiation Ledger 和 KNP/A2A 协议之上，
不改变对外协议和既有审批语义。

状态：In Progress / As-implemented。本文以当前工作区实现为准；仓库中与本升级无关的
预存删除不属于 Merchant Experience 范围。

## 能力矩阵

| 能力 | 状态 | 代码入口 |
|---|---|---|
| Merchant Intelligence | 已实现 | src/agent/merchant/intelligence/ |
| Grounding | 已实现 | src/agent/context/grounding.ts、merchant-grounding.ts |
| 外部数据 fencing | 已实现 | src/agent/context/fencing.ts |
| Host Event | 已实现，可选 | src/agent/host/events.ts、tui-renderer.ts |
| Web/Buddy state renderer | 已实现，框架无关 | src/agent/host/web-renderer.ts |
| Merchant presentation | 已实现，依赖 Host Event | src/agent/presentation/、src/agent/merchant/merchant-presentations.ts |
| Versioned Merchant Skills | 已实现 | skills/merchant/、src/agent/skills/ |
| ui_partial | 已实现，可选 | AgentHarness tool update → Host Event |
| HTTP/SSE Host adapter | 已实现 | src/http/merchant-server.ts |

这些能力只对 role: merchant 生效。Buyer、A2A wire、KNP state machine 和交易
handoff 不依赖该扩展。

## 配置

Merchant profile 可以开启：

~~~yaml
merchant_experience:
  enabled: true
  intelligence: true
  grounding: true
  presentation: true
  skills: true
  max_external_context_chars: 12000
  max_presentation_items: 12
  prompt_cache_retention: short
~~~

字段说明：

- enabled 默认 false，缺省时保持 0.7.x 工具注册面。
- 当 enabled 为 true 时，intelligence、grounding、presentation 默认开启，显式设为 false 可关闭；它们分别提供经营摘要/指标、权威事实预取和结构化 Merchant UI。
- presentation 仅在 Host 提供 eventSink 时挂载；没有 Host Event 时使用对应的文本工具和审批流程。
- skills 默认关闭，只有显式设为 true 才加载本地版本化 SKILL.md 和 load_skill。
- max_external_context_chars 范围为 1000–50000；每轮 memory + grounding 的动态
  briefing 另受 30000 字符代码级总上限约束。
- max_presentation_items 范围为 1–50。
- prompt_cache_retention 可选 `none`、`short` 或 `long`；未配置时保留 provider 默认策略，
  配置后按当前 session 传递给 Pi Agent Core。它只影响 provider 的缓存保留，不改变 prompt
  内容、权限或缓存键中的敏感数据。

该配置只允许出现在 role: merchant profile；unknown field 和越界值会 fail closed。

## Merchant Intelligence

MerchantIntelligenceBackend 提供：

- getBusinessSnapshot：经营摘要和告警数量；
- queryMetric：按日/周/月读取指标序列；
- getCatalogHealth：目录总量、active、paused 和缺货数量；
- getNegotiationDigest：A2A 磋商状态、SKU、数量和公开报价；
- getPendingActions：当前 principal 的待审批候选元数据。
- getCandidatePreview：按当前 principal 读取候选的 allow-list 变更投影，绝不返回原始 arguments、
  preconditions、hash 或私有阈值。

默认实现 DefaultMerchantIntelligenceBackend 从以下权威来源投影：

| 数据 | 来源 |
|---|---|
| 买家触达、磋商数和日序列 | MerchantStatsStore |
| A2A phase、公开报价和更新时间 | LedgerStore |
| 商品与库存 | MerchantClient |
| 人工审核 | MerchantClient.getHumanReviewQueue() |
| 待审批候选 | WriteApprovalCandidateStore |
| 销售/广告/活动指标 | 注入的 MerchantAnalyticsSource 或 HttpMerchantAnalyticsSource |

所有带 merchant_id 的查询会与构造时绑定的 Merchant ID 比较，拒绝跨商户读取。
period 只接受 1d–90d；日点使用 UTC 日期，week 以 UTC 周一为 bucket，month 以月初为
bucket。非法 period 会报错，不会静默回退。指标不可得时返回 null 或 limitation，不使用假零值。当前尚未提供完整销售收入、
广告花费、ROAS 和统一低库存阈值；部署方可以通过 `MerchantAnalyticsSource` 注入正式的
订单/销售/活动数据源。该数据源只由服务端调用，不暴露给模型；返回的指标必须经过格式
校验，和本地权威指标重名时 fail closed。未注入或暂时不可用时返回 `null + limitation`。

Kiwi 提供通用 `HttpMerchantAnalyticsSource`，约定两个只读接口：

~~~text
GET /v1/merchant/analytics/metrics?merchant_id=<id>&period=7d
→ { ok: true, merchant_id, metrics: [...], limitations?: [...] }

GET /v1/merchant/analytics/series?merchant_id=<id>&metric=roas&period=7d&granularity=day
→ { ok: true, merchant_id, series: MetricSeries }
~~~

远端服务必须回显完全匹配的 `merchant_id`；远程 URL 要求 HTTPS（loopback 开发环境可用
HTTP），响应禁止重定向并受大小/超时限制。具体订单、广告平台只需实现该契约。

Business snapshot 当前还会投影 `distinct_buyers`、`agreements_reached`、
`agreement_rate`、`human_review_count`、`pending_action_count`、`active_negotiations`
和 `top_sku_contacts`。`distinct_buyers` 明确表示认证身份去重，不等同于真实自然人数量。

## Merchant 工具

新增只读工具：

- get_business_snapshot
- query_merchant_metric
- get_negotiation_digest
- get_pending_actions
- get_catalog_health

新增展示工具：

- present_merchant_digest
- present_metrics
- present_catalog
- present_negotiations
- present_human_review
- present_change_preview
- present_suggestions

展示工具通过 `PresentationRegistry` 和 `runPresentation()` 统一执行。模型只提交组件所需的
筛选条件、候选 ID 或短文案；组件再从 `MerchantIntelligenceBackend`、`MerchantClient` 和
当前 principal 绑定的 candidate store 读取权威数据，最后经过结构化 sanitation 后发送 `ui`
事件。`present_change_preview` 始终优先使用 backend 的 `getCandidatePreview`，只有未配置
Intelligence 时才使用同一 store 的本地兼容投影。当前 Presentation MVP 已提供以上七个组件。

模型只提供 ID、排序、标题和简短说明；真实商品、指标、Ledger 状态和 before/after
由服务端补全。present_change_preview 不会批准或执行候选，也不会展示 Vault 明文、
私有底价、成本和凭据。

既有工具名称保持兼容：

~~~text
list_catalog_products
get_catalog_product
get_inventory_snapshot
list_incoming_consultations
get_human_review_queue
create_product
update_product
update_inventory
pause_or_resume_listing
draft_product_change
list_a2a_negotiations
~~~

既有 Merchant 只读外部结果现在也经过 fencing；写入仍然必须经过 routeWriteCandidate()
和 executeApprovedCandidate()。

## Grounding

当前 Merchant grounding 每轮最多执行两个去重的只读域，规则如下：

| 问题类型 | 首次只读 |
|---|---|
| 待审批、批准、执行 | get_pending_actions |
| 磋商、询价、报价、还价 | get_negotiation_digest |
| 人工、审核、转人工 | get_human_review_queue |
| 库存、缺货、补货 | get_catalog_health |
| 商品、目录、SKU | list_catalog_products |
| 经营、销售、指标、收入 | get_business_snapshot |

Grounding 不允许选择写工具。读取失败时向模型说明权威数据不可用，不将失败解释成
空结果或零值。grounding 只应用于 Merchant 本地对话，不改变 A2A/KNP 状态机。

## 外部数据 fencing

sanitizeModelText() 和 fenceModelPayload() 会处理：

- Unicode NFKC；
- zero-width、bidi、format control 和 C0/C1 控制字符；
- 伪造的 system:、assistant:、user:、human: marker；
- tool/transcript/function 标签；
- fence marker；
- 长度限制。

原始 KNP payload 必须先完成签名、digest、schema 和 Ledger 处理，fencing 只处理进入
模型或 UI 的副本，不修改协议事实。

Fencing 是全局安全行为，不受 merchant_experience.enabled 控制。旧 profile 保持工具面
兼容，但模型可见的 Merchant 外部读取结果会增加 fence 包装。Principal Memory 写入拒绝
fenced 外部原文，读取 briefing 时再次 sanitize 并放入固定 kiwi_memory_data fence，
防止外部指令跨轮复活。

## Merchant Skills

当前已发布：

~~~text
skills/merchant/performance-insights/SKILL.md
skills/merchant/catalog-operations/SKILL.md
skills/merchant/inventory-operations/SKILL.md
skills/merchant/negotiation-review/SKILL.md
skills/merchant/human-review/SKILL.md
skills/merchant/change-approval/SKILL.md
~~~

Skill frontmatter 至少包含 name、description；version、role、required_tools 可选。required_tools 只列出所有宿主都能使用的核心工具，依赖 Host Event 的展示工具不作为必需工具。
加载器拒绝非法名称、错误角色、超长正文、缺失 frontmatter 和目录逃逸路径。
system prompt 只注入 skill catalog，正文由 load_skill 按需加载。

Skill 不能：

- 注册新工具；
- 改变权限或 profile；
- 修改 HardPolicy；
- 绕过审批、幂等、Ledger 或 Handoff gate。

NPM 发布包已包含 skills/，scripts/verify-package.sh 会在 production-only 安装后
加载 performance-insights 进行校验。

## Host Event

Host 通过 buildChatKernel(profile, dataDir, catalog, eventSink) 注入事件接收器。对于需要
终端 fallback 的宿主，可使用 `TuiEventSink`；它只消费事件，不改变 `KernelReply` 或业务状态：

~~~ts
interface AgentEventSink {
  emit(event: AgentHostEvent): void | Promise<void>;
}
~~~

`TuiEventSink` 会将 `ui` payload 渲染为可读文本面板，并在输出前剥离终端控制字符；它是
独立的可选 renderer，不会自动改变既有 CLI 的输出字节。

Web/Buddy 宿主可使用 `MerchantWebEventRenderer` 把同一个 session 的 SSE 中的 `AgentHostEvent` 折叠成有界、
可序列化的 `MerchantWebViewState`。每个 session 应使用独立 renderer；它会忽略重复/乱序 sequence，记录 replay gap，清洗
消息、工具参数、UI payload 和审批预览；宿主只需把该 state 映射到自己的 React、原生或
Buddy 组件，不需要访问 Kiwi 内部 DB。

当前事件包括：

~~~text
message
text_delta
tool_call
tool_result
grounding_started
grounding_completed
ui
ui_partial
candidate_update
turn_complete
error
~~~

`text_delta` 来自 AgentHarness 的真实 `message_update`/`text_delta` 事件；`ui_partial` 来自
工具执行的增量更新，不通过解析 stdout 伪造。事件是展示投影，不是业务状态权威。sink 失败不会阻止 candidate、Ledger 或业务写入。
异步 sink 由 SerializedEventSink 串行投递；tool_call/tool_result 数据在进入 sink 前会
剔除 credential/token/authorization 等字段并限制到 4000 字符。Web 宿主必须把这些值按纯文本
或结构化数据渲染，不得把未转义的模型文本交给 innerHTML 等 HTML 注入接口。

当前已提供 createMerchantHttpServer()：

| 路由 | 作用 |
|---|---|
| POST /v1/merchant/sessions | 创建独立 Merchant session |
| GET /v1/merchant/sessions/:id | 查询 session 和 pending action 元数据 |
| POST /v1/merchant/sessions/:id/messages | 将一条消息串行交给 Kernel |
| GET /v1/merchant/sessions/:id/events | SSE 事件流，支持 after 和 Last-Event-ID replay |
| POST /v1/merchant/sessions/:id/approvals/:candidate_id | 调用现有 approve/reject candidate |
| DELETE /v1/merchant/sessions/:id | 关闭 session |

Adapter 要求注入 authenticate(request)，不信任请求 body 中的 merchant_id；认证主体
必须属于 profile owner。每个 HTTP session 使用独立 Kernel 和 data directory，事件缓冲
默认保留最近 200 条。默认最多 100 个 session，空闲 30 分钟后在下一次请求时清理；活跃
SSE subscriber 不会被空闲清理。Web、Buddy 或 Portal 可以直接消费该 Adapter，也可以自行注入
AgentEventSink。

## 安全与审批边界

四类审批必须保持隔离：

1. catalog write；
2. inventory write；
3. negotiation decision；
4. transaction handoff。

Merchant Experience 不新建审批状态机。商品和库存写入继续使用 WriteApprovalCandidate；
A2A 协商继续使用 KNP policy gate；Handoff 继续使用独立的 handoff authorization。
预览不等于批准，聊天中的“同意”不等于 /approve。

本文所称 HardPolicy 是设计概念，指 profile 私有阈值、clampHintsToHardPolicy() 与
write/negotiation gates 的组合，不是独立导出的类型。

## 开发与验证

~~~bash
npm run lint
npm run typecheck
npm run build
npm test
npm run verify:package
~~~

新增测试：

~~~text
tests/agent-fencing.test.ts
tests/agent-host-events.test.ts
tests/agent-tui-renderer.test.ts
tests/agent-kernel.test.ts
tests/merchant-grounding.test.ts
tests/merchant-intelligence.test.ts
tests/merchant-skills.test.ts
tests/merchant-http.test.ts
tests/merchant-presentation.test.ts
tests/http-analytics-source.test.ts
~~~

当前代码已通过 lint、typecheck、build、全量测试和生产包 smoke。具体视觉组件和 Buddy/Web
产品集成仍需由宿主应用实现；通用 HTTP Analytics adapter 已实现，具体订单/广告平台只需
按约定接口提供服务。

工具结果状态语义：blocked 表示 policy/gate 明确阻止调用；unavailable 表示数据源缺失、
未接线或临时失败。两者都不是成功，也不能把 unavailable 解释为空数据。

Prompt cache 已提供显式 opt-in 配置 `prompt_cache_retention`。`none` 可用于关闭缓存，
`short`/`long` 由 provider 映射到其支持的保留策略；不支持对应策略的 provider 会按其
自身兼容实现处理。Kiwi 不把业务数据写入独立缓存，也不把 token/Vault 明文放入缓存键。
