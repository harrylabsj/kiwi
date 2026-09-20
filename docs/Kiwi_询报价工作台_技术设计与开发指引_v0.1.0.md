# Kiwi 询报价工作台
## 技术设计与开发指引 v0.1.0

**定位：先服务现实中的询盘与报价，不以 AI 买家网络成熟为前提。**

文档日期：2026-09-19。设计状态：开发基线提案。代码核查基线：`harrylabsj/kiwi`，提交 `866dbe69583e3330198696861380043ccc721116`，`package.json` 版本 `0.10.0`。本设计版本与 Kiwi 软件版本分别管理，不能将 v0.1.0 理解为 Kiwi 的降级版本。

交付对象：产品负责人、Kiwi Core 开发者、shopping-cli 维护者、WorkBuddy 接入开发者和测试人员。本文及同版交接包提供设计、候选契约、参考算例和验收规格，不是已完成的业务系统，也不是平台审核通过证明。

## 阅读导航

01 决策与范围；02 当前代码事实；03 首版用户任务；04 架构与信任边界；05 端到端流程；06 数据与证据；07 计价；08 状态机；09 审批与发布；10 存储与恢复；11 服务接口；12 WorkBuddy 接入；13 模型与技能；14 展示与导出；15 安全；16 协议及移交；17 部署；18 开发拆分；19 测试与验收；20 试点与停止条件；21 决策记录；22 交接清单与来源。

# 01　决策摘要与范围冻结

## 1.1 这一次究竟开发什么

开发一个商家侧、有人监督的询报价工作台：经营者将已经收到的客户询盘交给它，它整理需求、定位商品、读取有出处的经营事实、执行确定性计价、生成带版本的报价材料，并把正式对外版本交给商家批准。客户仍然可以通过原有微信、邮件或电话沟通；首版不要求客户注册 Kiwi，也不要求客户使用任何 AI Agent。

价值命题不是“AI 会谈判”，而是“已有询盘能更少返工地转成正确、完整、可追溯的报价”。该命题仍待真实任务对照验证，不能用协议功能、离线用例数量或演示对话替代。

此前商品资料整理／批量改品曾是候选突破口。本次单独冻结“现实询报价验证分支”，不把两条业务主线捆绑开发；商品维护仅作为数据前置，通过已有 shopping-cli 完成。本次设计也不自动授权修改现网拓扑、开通管理端口、发布平台产品或变更公共协议。

## 1.2 最小闭环与不可突破的边界

**首版闭环：导入询盘 → 人工确认关键字段与 SKU → 读取权威事实 → 确定性报价 → 预览与批准 → 导出人工发送 → 保存客户反馈与移交材料。**

| 首版必须做 | 首版明确不做 |
| --- | --- |
| 单商家实例、一个明确的经营主体、具名操作者 | 共享公共网关集中托管多商家私密经营数据 |
| 粘贴文本、UTF-8 CSV 询盘导入与来源定位 | 自动读取个人微信全部历史、自动群发、电话录音自动接入 |
| 已有 SKU、明确计量单位、CNY、正整数数量 | 任意行业 CPQ、复杂 BOM、浮动汇率、多币种混算 |
| 已确认的含税／未税口径、行级优惠、单项运费 | 自动决定适用税率、自动提供融资或信用承诺 |
| 报价版本、人工审批、只读 PDF／文本导出 | 自动接受订单、付款、预留／扣减库存 |
| 人工记录“已发送”并保留证据等级 | 把“已导出”显示为“客户已收到” |
| 生成移交材料，区分人工记录与目标系统回执 | 未经目标系统确认即显示“已成交／已移交” |

PDF 与 XLSX 的输入解析、企业邮箱读取、报价自动发送、采购侧多供应商比价、A2A 报价执行桥，均列为后续可选项，不影响首版闭环。首版不新增向量数据库，不训练专有模型，不建设完整 CRM／ERP。

## 1.3 五条架构决定

D1：Merchant Core 继续独立持有流程、策略、审批、审计与恢复；WorkBuddy 是操作入口而不是状态权威。

D2：公共目录网关继续只负责目录身份与公开资料；不持有商家实例地址或凭据，不代理实例工具，不参与 A2A 磋商。当前仓库对此已有明确决定。[S03]

D3：经营事实仍经 shopping-cli 和 `CommerceDataSource` 读取；不在 Kiwi 再造 ERP 连接层或第二个商品主库。[S08]

D4：新增人工询盘聚合 `RfqCase` 和不可变 `QuoteRevision`，它们不是新增 KNP wire 对象。人工来源不能伪装成已验证的 A2A 消息。[S07][S09]

D5：先完成 Core、CLI／管理页闭环和契约门，再接入实例私有 MCP；完整 Buddy 上架在宿主实机与试点门之后，不以 UI 开发倒逼放宽权限。

# 02　当前代码事实、冲突与复用路线

## 2.1 核查方法与证据边界

本次通过 GitHub 连接器读取固定提交下的代码与文档，并核对 WorkBuddy 官方接入文档。没有在本次环境中运行 Kiwi 的 `npm run verify`、连接生产实例、执行真实商家报价或操作 WorkBuddy 客户端。

因此，下面的“已存在”表示源码存在对应实现，不表示本设计已经集成通过。“需新增”表示本设计要求的增量；不依据一个搜索片段就断言全仓库不存在其他实现。开发者在 M0 必须做全仓库复用检索并记录映射。

## 2.2 可复用资产

| 位置／组件 | 本次核实的能力 | 本设计处理 |
| --- | --- | --- |
| `package.json` | 0.10.0，Node.js ≥22，TypeScript，Ajv，MCP SDK；已有 verify 脚本 | 保持现有工具链，不为了新工作台整体升级依赖 [S01] |
| `src/merchant-core/service.ts` | 包装工作台 facade、两轨磋商列表、命令入口、私密阈值管理面 | 在同一 Core 内增加 RFQ 子服务；不把逻辑放入 MCP handler [S05] |
| `src/merchant-core/commands.ts` | prepare、固定执行器、确认凭证、前置版本重验、执行后回读、恢复 | 扩展报价发布执行器，保持原有商品操作语义 [S04] |
| `src/merchant/workbench-service.ts` | 租户校验、公开字段白名单、错误映射、数据源失败关闭 | 复用原则；新增客户报价投影，不直接复用包含库存的操作者视图 [S06] |
| `src/merchant-core/negotiation-adapters.ts` | A2A 与 shopping 两轨保留 source_protocol 和 source_id | 保持两轨契约；人工询盘使用外层关联，不硬加第三个 wire 协议 [S07] |
| `src/commerce/data-source.ts` | 商品、库存、价格、来源权威；唯一经营事实入口是 shopping-cli | 扩展快照元数据与完整性契约时同步 shopping-cli [S08] |
| `src/mcp/merchant-tools.ts` | 工具协议适配、结构化结果、超时及响应大小保护 | 新 RFQ 工具使用分页／作业，不沿用截断业务 JSON 的做法 [S10] |
| `contracts/negotiation/1.0/schema.json` | KNP envelope、Money 最小单位整数、报价与非绑定协议语义 | 保持不变；仅在后续桥接中做显式映射 [S09] |

## 2.3 必须在 M0 处理的差异

**版本说明漂移。** 当前 `package.json` 是 0.10.0，但 README 的版本括注仍为 0.8.0；旧实机检查单也保留旧版本组合。以固定提交、包元数据、锁文件和实际能力探测为准，不复制旧文档中的版本上限。[S01][S02][S11]

**网关路由已经暂缓。** 0.10.0 变更记录与部署说明开头明确“网关不碰实例”。部署说明后续仍有“网关经 loopback 调用实例”的历史文字，不能据此恢复旧路由。本设计优先遵守最新明确边界，并要求先修正文档冲突。[S03]

**A2A 人工处理执行面不能当作现成能力。** 当前 `prepareReviewResolve` 遇到 `source_protocol: a2a` 明确返回 unavailable。首版人工询报价不依赖此函数；A2A 后续接入必须有独立实现和测试，不能借 shopping 轨绕过去。[S05]

**金额存在两种读取类型。** facade 的公开商品视图含 `price: number`，而 `CommerceDataSource` 明确 `price_minor`／`amount_minor`。新报价引擎只接受最小货币单位整数，不能猜测旧 number 究竟表示元还是分。[S06][S08]

**超时不等于取消。** 现有 MCP 超时包装会提示底层仍可能完成。新变更操作必须先持久化幂等键与作业编号，再返回可查询结果，不能要求模型盲重试。[S10]

**公共展示资源不等于完整 MCP Apps。** 旧清单中的 `kiwi-merchant://presentation/*` JSON 资源，不能直接视作已验证的 HTML 交互应用。新 UI 必须按宿主协商结果与 MCP Apps 资源契约另行验收。[S11][S14]

# 03　用户、任务与验收对象

## 3.1 目标商家

优先验证已有稳定商品或服务目录、重复接收询盘、报价需要查询多个事实但不依赖复杂工程设计的商家。产品不是要证明“所有商家都需要”，而是找到可重复且错误成本可观察的一类任务。

试点实施约束：一个实例对应一个商家；一个具名 owner 负责批准。多个销售员、多级授权、跨门店共享、代理批准在本版不承诺。数据结构保留 actor 与 principal 的区别，避免未来只能用共享密码审计。

## 3.2 五个高频任务

| 编号 | 用户说法 | 必须交付的结果 |
| --- | --- | --- |
| U01 | “客户这段话究竟要什么，还缺什么？” | 结构化需求、原文定位、缺失项、待确认项；未知值保持未知 |
| U02 | “这几个规格对应哪个 SKU？” | 候选及依据、单位换算来源；关键 SKU 由人确认 |
| U03 | “按当前条件出一版报价。” | 有数据时点、价格口径、有效期、运费和交期的完整报价 |
| U04 | “客户改了数量／地址，重新报。” | 新版本、与旧版的逐项差异、旧审批失效说明 |
| U05 | “这版可以发给客户了。” | 可信管理页确认后的固定文件；导出状态不冒充发送状态 |

## 3.3 明确区分三类“写”

会话辅助写：保存询盘、字段修订、SKU 选择、草稿。需要认证与幂等，但不产生对外商业承诺；允许模型提出并记录为未批准工作成果。

业务发布写：将一个冻结报价版本激活为可对外导出的正式版本，或生成正式移交包。必须走可信人工确认。

外部系统写：发邮件、推 ERP、创建 checkout、订单、库存或支付操作。本版不执行；后续每一种操作单独引入权限和验收。

# 04　总体架构与职责

## 4.1 分层结构

```text
商家操作者
  ├─ 原有渠道：微信／邮件／电话（首版手工摘录）
  ├─ CLI／独立管理页（先验证）
  └─ WorkBuddy 专家／Buddy（后置接入）
           │ 私有实例 MCP；只读与准备动作
           ▼
    Merchant Core / RfqService
      ├─ 询盘与证据管理
      ├─ SKU 对齐与事实快照
      ├─ 确定性计价与策略校验
      ├─ QuoteRevision / ReleaseCoordinator
      ├─ 既有 CommandLog / 审批与恢复
      └─ SQLite / 不可变产物存储
           │                         │
           ▼                         ▼
    shopping-cli 数据入口        可信管理页确认
      └─ 现有商品库／ERP          （不经模型批准）

公共目录网关 ── 公开资料／身份（与上述私有流程隔离）
A2A 接待服务 ── 既有 KNP／Ledger（本版不改协议）
```

## 4.2 责任矩阵

| 层 | 拥有的责任 | 禁止的责任 |
| --- | --- | --- |
| WorkBuddy／模型 | 澄清、提取建议、解释差异、调度已授权工具 | 价格算术权威、最终审批、保存唯一状态、接触底价 |
| MCP／CLI adapter | 鉴权、参数验证、调用 Core、结果投影 | 自建报价状态机、拼接数据库 SQL、决定硬策略 |
| Merchant Core | 业务状态、计价、审批、幂等、审计、恢复 | 绕过经营事实权威，伪造渠道回执 |
| shopping-cli | 商品及经营字段的权威接入、上游版本与来源 | 持有 WorkBuddy 会话状态、替模型批准报价 |
| 公共目录网关 | 商家身份、可公开资料和目录服务 | 读取客户询盘、底价、库存明细、私有报价 |
| 外部交易系统 | 后续业务受理与正式交易 | 被 Kiwi 的本地状态冒充“已确认” |

## 4.3 一次编排，只调用一个确定性业务核心

WorkBuddy 调用 `RfqService` 时不得再启动 Kiwi 自由聊天模型来重复理解同一请求。Core 的提取建议可以由宿主模型提供，也可在独立 CLI 中由可选模型提供，但计价、权限与状态转移由相同确定性代码处理。

失去 WorkBuddy 连接后，已保存的询盘、待批准报价与审计仍可在商家管理页／CLI 读取；Merchant 的原有 A2A 服务继续独立运行。这是 Merchant Independence Gate 的本次具体化。

# 05　端到端流程

## 5.1 正常报价

步骤一：操作者粘贴询盘，并指定来源类型、客户显示名称和可选外部引用。Core 保存原始材料摘要、接收时间、来源定位与权限声明，不自动拉取任何私人会话。

步骤二：模型提出 `RfqExtractionProposal`，每个关键字段关联原文位置。Core 执行类型、范围和冲突校验。数量、单位、SKU、币种、交付地点、税口径及需要承诺的交期必须由人确认或来自明确授权的结构化记录。

步骤三：搜索商品并逐个核实 SKU。结果有歧义、商品列表不完整、单位换算缺依据时进入 NEEDS_CLARIFICATION，不用最高相似度强行选中。

步骤四：通过 `CommerceDataSource` 读取价格与库存；税口径、运费和交期来自已配置权威字段或本次操作者明确确认。不同字段分别保留来源；冲突不静默择优。

步骤五：Core 生成 `PricingInput`，引用服务端快照，不接受模型直接提交的最终金额。计价与策略引擎输出不可变 `QuoteRevision`；模型仅可生成受约束的说明建议。

步骤六：`prepare_release` 渲染最终客户文件但暂不开放下载，绑定报价内容、文件哈希、模板版本、收件对象显示信息、策略版本和事实指纹，登记审批候选。

步骤七：操作者进入实例的可信管理页，看到固定版本与阻断项。批准时 Core 再读事实与权限、消费一次性确认凭证，并原子激活已生成的同一文件。原文变更或策略版本变化必须重新准备审批。

步骤八：操作者下载后通过既有渠道人工发送。系统只显示“已批准／已导出”；只有操作者提交发送记录后才显示“用户记录已发送（未验证送达）”。

## 5.2 客户修改条件

客户的新消息创建新的来源记录和 RFQ revision。数量、SKU、单位、税口径、交期、地址、运费、付款条件或报价有效期任一变化，均生成新 QuoteRevision。旧版本不可原地修改。

旧待批准候选变为 SUPERSEDED；已导出旧文件保留原始审计，但禁止当作当前版本再次导出。系统提醒“旧文件可能已在客户手中，需要人工说明替代关系”，不能声称已撤回客户手中的文件。

## 5.3 数据异常与人工介入

价格缺失、库存不可得、来源冲突、运费未知、交期无依据时可保存草稿和澄清问题，但不可激活完整正式报价。模型可以建议替代商品，却不能把“建议”转换为商家的承诺。

首版仅允许所有报价行满足条件后整体发布。不提供未经设计的“部分行偷偷成功”；需要部分报价时，操作者明确移除或标记不报价行并产生新版本，客户文件列出未报价项。

# 06　数据契约与证据体系

## 6.1 聚合与记录

| 对象 | 核心用途 | 关键约束 |
| --- | --- | --- |
| `SourceRecord` | 原始询盘、客户变更、人工依据 | 原文／文件摘要、来源、定位、接收时点；按授权保存 |
| `RfqCase` | 一个现实询盘的长期工作记录 | case_id 稳定；revision 单调；商家归属服务端确定 |
| `FactSnapshot` | 本次报价使用的字段事实 | 每个字段记录权威、时间、版本、完整性和可见性 |
| `PricingInput` | 可重算的计价输入 | 货币最小单位整数；税口径显式；无模型总额 |
| `QuoteRevision` | 一版冻结报价 | 输入与输出、依据、报价有效期、内容摘要不可变 |
| `ReleaseRequest` | 对外版本批准申请 | 绑定 quote、artifact、对象、模板、主体和有效期 |
| `DeliveryRecord` | 导出后的发送记录 | 用户自述、渠道回执与未知状态分别标注 |
| `HandoffRecord` | 材料移交及回执 | 包已生成不等于目标系统已受理 |

同版包的 `02_contracts/` 是上述八种对象的候选 JSON Schema。持久化对象 Schema 与工具输入 Schema 分开：模型工具绝不能因为记录中存在 merchant_id，就被允许自行决定租户。

## 6.2 来源与关键字段

每条询盘来源至少保存 `source_id`、`kind`、`content_sha256`、`received_at`、`locator`。文本 locator 使用 Unicode code point 的 [character_start, character_end) 半开区间，不是 UTF-8 字节偏移；CSV locator 为文件摘要、1起算数据行号和列名。相同文件的重传使用内容摘要去重，但不同客户、不同 RFQ 的相同文本不能自动合并。

字段证据至少记录：字段路径、原始值、规范化值、证据 source_id、提取方式、确认状态、确认 actor 和时点。模型置信度仅用于提醒，不作为合法授权或正确性的证明。

客户名称、收件渠道、SKU 及地址必须在确认页展示。日志使用伪名化客户键；不把联系方式、原始聊天和完整报价内容放进公共 telemetry。

## 6.3 权威、版本与新鲜度

沿用现有 `LOCAL_AUTHORITATIVE`、`UPSTREAM_PROXY`、`READ_ONLY` 来源标记，同时新增“本次是否可用于报价”的独立判断。READ_ONLY 不天然代表不可靠，UPSTREAM_PROXY 也不天然代表最新；关键是配置中的字段权威与读取证据。[S08]

建议初始阈值：库存 60 秒、价格 300 秒、交期／运费规则 24 小时。这些是可调整试点参数，不是行业事实。缺 `verified_at`／源版本且无法重新读取的关键事实，在正式发布时阻断。人确认的条件有单独的确认时点和有效范围，不能伪装为实时 ERP 数据。

事实指纹只包含业务值、权威来源和源版本；`fetched_at` 不进入内容指纹，避免单纯重读时间变化使每次审批必然失效。新鲜度仍单独检查。源值或源版本变化即失效；前置校验与本地提交间不能锁住外部 ERP，因此对外文件必须保留“数据截至时间、有效期、不代表库存预留”的明确边界。

## 6.4 单位、SKU 与完整性

首版规范数量是正整数，规范单位是明确的商业计数单位。允许“箱→件”等有商家维护证据的正整数换算；不得根据常识猜一箱有多少件。重量、长度等非整数报价进入未支持状态，而不是四舍五入后发布。

商品搜索返回 `items / next_cursor / complete / snapshot_at / source_version`。到达上游数量上限时 `complete=false`；“当前页无匹配”不等于“全库不存在”。现有数据接口的 limit 能力不构成完整目录保证，新契约需要与 shopping-cli 联合实现。[S08]

# 07　确定性计价与策略引擎

## 7.1 算术规范

首版仅 CNY，金额单位为分。JSON 金额使用 0 至 1,000,000,000,000 的安全整数；单个报价总额也不得超过该上限。数量为 1 至 100,000 的整数，每份询盘最多 100 行。内部乘法与税额用 BigInt 或等价精确整数运算，禁止用二进制浮点先算元再乘 100。

每行输入：`quantity`、`unit_price_minor`、`discount_minor`、`tax_basis`、`tax_rate_bps`。优惠只接受该行总优惠金额，不同时开放折扣率、满减与多层优惠。单位价与优惠必须来自经授权的价格规则或操作者确认，不能由模型凭空决定。

税率以 basis points 表达：1300 表示 13%。这里只是计算参数，不能据此决定商家真实适用税率；税率必须由业务权威提供。`tax_basis` 为 EXCLUSIVE 或 INCLUSIVE，UNKNOWN 不能进入计价 Schema。

定义 B = quantity × unit_price_minor − discount_minor，r = tax_rate_bps。

未税价：net = B；tax = HALF_UP(B × r / 10000)；gross = net + tax。

含税价：gross = B；tax = HALF_UP(B × r / (10000 + r))；net = gross − tax。

逐行舍入到分后再求和，不在总额层重新计算税额。运费按同样规则视作独立金额项，有独立税口径与税率。自提可明确配置 0 运费；未知运费不是 0。

## 7.2 固定算例

SKU-A：10 件 × 12,900 分，行优惠 1,000 分，未税、税率参数 1300。货品未税 128,000 分，税 16,640 分，含税 144,640 分。另运费 1,000 分，未税、税率参数 0。最终未税合计 129,000 分、税合计 16,640 分、应付报价 145,640 分，即 1,456.40 元。

同版包包含参考实现和更多舍入／优惠／边界算例。参考实现只证明数学契约的一致性，不证明商家输入价格、税率或库存正确。

## 7.3 硬策略

每一份报价至少校验：商家归属、商品可售、数量与起订量、单位、货币、已授权价格、价格有效期、交付区域、交期依据、运费、服务／付款条件白名单、报价有效期以及所有关键事实的新鲜度。

底价、成本、利润和私有策略阈值只在 Core 的受控策略面读取，不进入模型、客户文件、公开目录、错误详情或普通日志。对外只返回 `POLICY_REQUIRES_REVIEW` 等理由码，不泄露“还差多少钱可通过”。任意价格反复试探应受限流和审计，避免拒绝接口成为底价探测器。

首版审批不能越过硬底线。确需修改策略，先走现有独立策略变更与批准流程，再重新生成报价；不得在“批准报价”按钮中隐藏修改底价动作。

## 7.4 计价职责与扩展点

`PricingEngine.calculate(input)` 为纯函数，只执行算术和输入界限检查；`QuotePolicy.validate(context)` 读取当前授权与策略；`FactResolver` 负责获取事实。三者不能混成一个让模型自由补字段的函数。

新增的阶梯价、客户协议价、非整数数量、外币、运费 API 等必须各自增加版本化契约和算例。缺能力就显式拒绝，不以字符串备注暗中承载可执行商业条件。

# 08　状态机与不可变版本

## 8.1 不把所有状态揉成一个 status

`RfqCase.stage` 表达需求准备程度；报价 lifecycle 表达版本可用性；delivery 表达发送证据；handoff 表达目标系统受理。它们分别维护，避免“已批准”自动变成“已发送／已成交”。

| 状态域 | 状态 | 进入条件／退出动作 |
| --- | --- | --- |
| RFQ | NEW → NEEDS_CLARIFICATION → READY → PRICED → CLOSED | 需求、SKU、计价字段齐备才 READY；报价成功才 PRICED |
| RFQ | CANCELLED | 用户显式取消；保留既有审计与已导出版本 |
| 报价 | DRAFT → VALIDATED → PENDING_APPROVAL | 通过确定性校验，并登记冻结内容的候选 |
| 报价 | APPROVED → EXPORTED | 可信批准使产物可下载；实际成功读取产物才 EXPORTED |
| 报价 | REJECTED／SUPERSEDED／EXPIRED | 拒绝、前置变化／新版本替代、超期；不可再次放行 |
| 发送 | NOT_SENT／REPORTED_SENT／RECEIPT_VERIFIED／DELIVERY_UNKNOWN | 本版只能人工记录 REPORTED_SENT；不伪造渠道回执 |
| 移交 | PACKET_READY／OWNER_RECORDED／TARGET_VERIFIED／REJECTED／UNKNOWN | 文件已生成、人工自述、目标方受理分别存证 |

内部 quote 内容不可变，生命周期变化通过事件／投影表维护。`rfq_revision` 与 `quote_revision` 不可共用同一个计数器。一份 RFQ 可有多版报价，但同时只允许一个 current_quote_revision。

## 8.2 转移前置条件

READY 要求所有必填字段已确认、没有关键冲突。VALIDATED 要求价格、单位、税、运费和交期有依据且可重算。PENDING_APPROVAL 要求正式产物已渲染、摘要固定、审批候选落盘。APPROVED 要求可信主体批准、一次性凭证有效、事实与策略重验通过、当前版本一致。EXPORTED 要求用户成功取走已批准的固定产物，而非仅生成下载入口。

从任意状态更新关键需求，必须先创建 RFQ 新 revision，再使相关旧审批失效。对已 EXPORTED 的历史版本不删除文件、不重写历史、不假装客户已经知晓替代。

## 8.3 必须维持的不变量

I01：一条记录只有一个服务端认证的商家归属。

I02：正式报价每一项价格、数量、税、运费和交期都有已确认输入及证据。

I03：模型输出不是审批凭证；prepare 永远不产生对外正式发布。

I04：批准的报价摘要、文件字节摘要与最终提供下载的内容一致。

I05：新版本不能复用旧批准，旧客户也不能复用新客户的批准。

I06：EXPORTED、REPORTED_SENT、TARGET_VERIFIED 不能相互推导。

I07：数据源不可用不会降级为演示价；未知不变成零。

I08：报价不是订单、付款或库存预留。

I09：人工询盘不伪造 buyer 身份、KNP 消息或双方 Agreement。

I10：关闭 WorkBuddy 不丢失 Core 的持久状态。

# 09　可信审批与正式产物发布

## 9.1 复用既有能力，但不能“只加一个 approve 字段”

现有 `MerchantCommandLog` 已具备固定执行器、前置重验与确认凭证机制。本设计新增报价发布执行器，复用其候选及审计体系，不新建第二套批准数据库。[S04]

现有命令路径中可见 `risk: write_catalog`，不应把报价发布冒充商品修改。开发时扩展明确的报价风险语义，并全量核查 risk 的枚举、序列化与旧客户端兼容；本文建议内部名称 `release_quote`，不声称它已存在。[S04]

生产 RFQ 执行路径必须要求 confirmation store，不能依赖当前接口中“可选 confirmations”的宽松调用方式。保持老调用方兼容，不意味着新工具可以在无可信确认配置时执行。

## 9.2 三阶段发布

A. prepare：读取当前 quote、需求与事实；渲染最终客户文件到私有临时产物库；计算文件哈希与客户投影哈希；登记候选和 ReleaseRequest。文件未批准前不通过下载接口提供。可以展示带水印预览，但批准页必须能核对最终文件内容。

B. confirm：独立管理页登录后，生成并消费短期一次性确认凭证。绑定 candidate_id、quote_revision、public_projection_digest、artifact_sha256、merchant、principal、recipient_ref、action、expires_at。建议确认凭证有效期 5 分钟，审批候选最长 15 分钟，且不晚于报价 valid_until；这是本版参数，不是平台要求。

C. activate：Core 重新验证当前 owner 权限、RFQ／quote revision、策略版本、事实值指纹与新鲜度。在同一商家写事务中记录审批结果和可下载状态。激活之前的任何失败都不开放文件；激活之后不得重新渲染或用模型润色同一正式文件。

## 9.3 人、模型和实例 principal 的映射

现有 Core 使用 profile／commandPrincipalId，不能直接把模型参数中的 user_id 当作可信操作者。M0 必须画清楚 OAuth subject、商家 owner、实例 principal、审批 store principal 的映射，并为单商家 owner 固定配置。审计同时保存真实会话 actor 与命令授权 principal。[S04][S05]

首版不支持销售员 A 创建、老板 B 跨主体批准，除非显式实现授权委托模型并测试。不要通过把所有人硬编码成同一个 principal 来假装已经支持多人审批。

## 9.4 管理页安全

批准／拒绝只在认证的管理页 HTTP 路由执行，不作为模型可调用的 RFQ MCP tool。管理页使用独立 HttpOnly 会话、CSRF 防护、明确操作按钮和一次性凭证；GET 请求无副作用。模型看到的只是 candidate_id、摘要与管理页入口，不包含确认凭证。

MCP Apps 内的“去批准”只负责打开可信管理页。只有后续证明宿主能够提供服务端可验证的人类操作证据，才考虑内嵌批准；工具 annotations、一个布尔值或一句“老板已经同意”均不足以取代该证据。

## 9.5 失败与竞态

并发批准与需求修改必须通过 revision CAS 串行化。只有一个操作能成功。失败返回明确 `VERSION_CONFLICT` 或 `APPROVAL_STALE`，不自动替用户批准新版本。

现有恢复逻辑会把崩溃时 executing 的候选标为 superseded，避免重复副作用；不能把这理解为“外部操作已撤销”。RFQ 产物激活尽量限定为本地事务；仍遇到结果不明时先查询 release 状态与文件摘要，再人工处理，不盲重试。[S04]

# 10　存储、并发、幂等与恢复

## 10.1 存储方案

首版沿用商家独立实例的 SQLite，不引入 PostgreSQL、Kafka 或分布式锁。新增表使用 `rfq_` 前缀，接入现有状态库与单 owner 写入机制。不同商家不共享同一个 SQLite 文件。

下列是新增逻辑表，不是对当前数据库结构的描述：

| 表 | 主要字段／约束 |
| --- | --- |
| rfq_cases | case_id PK；merchant_id；current_revision；stage；version |
| rfq_case_revisions | case_id + revision 唯一；确认后的规范字段与证据引用 |
| rfq_sources | source_id；case_id；内容摘要；locator；存储引用 |
| rfq_fact_snapshots | snapshot_id；源版本；内容指纹；验证时点；加密存储引用 |
| rfq_quote_revisions | quote_id + revision 唯一；case_revision；pricing_input/output；digest |
| rfq_release_requests | release_id；quote_id + revision；candidate_id；artifact_digest；status |
| rfq_artifacts | artifact_id；内容摘要；模板版本；私有路径；激活状态 |
| rfq_delivery_records | delivery_id；quote 版本；证据等级；渠道；操作者 |
| rfq_handoffs | handoff_id；原始对象；packet_digest；receipt 与验证等级 |
| rfq_idempotency | merchant + principal + command + key 唯一；request_digest；结果引用 |
| rfq_jobs | job_id；operation；状态；进度；checkpoint；error_code |
| rfq_audit_events | 单调序号；actor；operation；对象摘要；结果；trace_id |

业务原文、客户信息与产物保存在商家私有目录，禁止 public gateway 读取。数据库模式迁移使用编号迁移和 schema_version；升级前备份、升级后运行 smoke、回滚不直接丢弃已批准记录。

## 10.2 事务策略

M0 检查现有 `WriteApprovalCandidateStore` 是否支持传入同一 SQLite 事务。若不支持，增加内部 `UnitOfWork`／transaction port，再接入 RFQ，不能用两次独立提交假装原子。

prepare_release 的候选、release request、产物哈希引用要么一起提交，要么一起不存在。文件可先写私有临时目录，数据库事务引用其摘要；失败后由有界清理任务回收未引用文件。正式激活以 DB 权限状态为准，不靠“文件存在”作为批准依据。

产物下载校验商家归属、登录主体、激活状态、当前权限和文件摘要。外部文件路径由服务端 artifact_id 映射，不接受模型传入绝对路径或 `../`。

## 10.3 幂等契约

所有持久变更要求 `idempotency_key`。作用域是 merchant_id + principal_id + operation + key；同键同请求摘要返回同一结果；同键不同摘要返回 IDEMPOTENCY_CONFLICT。摘要按版本化 canonical serializer 生成，不能靠字符串拼接字段；哈希函数与现有 `contentHash` 的兼容由契约测试确认。

RFQ 的内容摘要使用 `rfq-canonical-json-v1`：对象键限定 ASCII、按字典序排序，UTF-8、无多余空白、禁止浮点和非有限值；字符串内容原样保存，不做隐式 Unicode 归一。对应参考函数见交接包。它不是 KNP 的 JCS，禁止把此摘要直接替换现有 wire digest。报价摘要不包含生命周期 status；客户投影另有 public_projection_digest，正式文件另有 artifact_sha256，三者不能混用。生产 PublicQuoteView 增加商家／客户显示字段和数据截至时点时，也必须先冻结版本并绑定同一批准。

CAS 使用 `expected_revision`。不得把客户端提供的完整记录覆盖写入；每次变更使用字段白名单和领域命令。先写作业及幂等记录，再执行可重试任务；超时后查询原 job，不创建新编号。

建议幂等记录保留 30 天，已批准 release 的关键幂等与审计记录跟随报价保留策略。保留时长需在试点中与商家确认；不能把清理后的旧键承诺为永久幂等。

## 10.4 后台作业语义

需超过单次交互预算的导入、渲染任务在约 2 秒内返回 job_id，持久状态为 QUEUED／RUNNING／SUCCEEDED／FAILED／CANCELLED／UNKNOWN。客户端轮询，服务重启后按 checkpoint 恢复。此为待开发系统的作业机制，不是本次文档交付在后台执行开发。

取消任务只终止尚未激活的工作；不能把取消 job 映射为撤销已经下载的客户文件。所有任务运行时限、最大输入和并发数受部署配置约束。

# 11　服务接口与 MCP 工具契约

## 11.1 Core 服务面（新增提案）

以下名称均为建议新增，不是现有导出函数。实现时与源码完成冲突检索后冻结。

```typescript
interface RfqService {
  ingest(ctx: AuthContext, cmd: IngestCommand): Promise<JobOrCase>;
  revise(ctx: AuthContext, cmd: ReviseCommand): Promise<RfqCase>;
  getCase(ctx: AuthContext, caseId: string): Promise<RfqCaseView>;
  searchProducts(ctx: AuthContext, q: ProductQuery): Promise<ProductPage>;
  confirmItems(ctx: AuthContext, cmd: ConfirmItemsCommand): Promise<RfqCase>;
  refreshFacts(ctx: AuthContext, cmd: RefreshFactsCommand): Promise<FactView>;
  price(ctx: AuthContext, cmd: PriceCommand): Promise<QuoteView>;
  compare(ctx: AuthContext, a: QuoteRef, b: QuoteRef): Promise<QuoteDiff>;
  prepareRelease(ctx: AuthContext, cmd: ReleaseCommand): Promise<ApprovalView>;
  getRelease(ctx: AuthContext, releaseId: string): Promise<ReleaseView>;
  recordDelivery(ctx: AuthContext, cmd: DeliveryCommand): Promise<DeliveryView>;
  prepareHandoff(ctx: AuthContext, cmd: HandoffCommand): Promise<ApprovalView>;
}
```

`AuthContext` 由传输层验证后注入；至少包含 merchant、principal、actor、scopes、trace_id 和 capability set。未经验证的模型字段不能构造 AuthContext。

## 11.2 首版工具清单

| MCP tool（建议名称） | 关键输入 | 权限与结果 |
| --- | --- | --- |
| kiwi_merchant_rfq_ingest | source、client_ref、idempotency_key | workflow prepare；保存未批准询盘 |
| kiwi_merchant_rfq_get | case_id | read；当前需求及阻断项 |
| kiwi_merchant_rfq_revise | case_id、expected_revision、changes、key | prepare；产生新 revision |
| kiwi_merchant_rfq_match | case_id、line_id、query、cursor | read；商品候选，不自动确认 |
| kiwi_merchant_rfq_confirm_items | case_id、expected_revision、selections、key | prepare；记录具名人工确认或可信结构化选择 |
| kiwi_merchant_rfq_refresh_facts | case_id、expected_revision、key | prepare；建立新事实快照 |
| kiwi_merchant_rfq_price | case_id、expected_revision、snapshot_id、key | prepare；Core 计算，不收模型最终金额 |
| kiwi_merchant_rfq_compare | from_quote_ref、to_quote_ref | read；字段级差异与失效原因 |
| kiwi_merchant_rfq_prepare_release | quote_ref、recipient_ref、expected_revision、key | prepare；只生成批准候选与预览 |
| kiwi_merchant_rfq_get_release | release_id | read；批准／导出状态和授权产物引用 |
| kiwi_merchant_rfq_record_delivery | quote_ref、channel、evidence_ref、key | prepare；只记 REPORTED_SENT |
| kiwi_merchant_rfq_prepare_handoff | quote_ref、target_ref、intent_evidence_ref、key | prepare；只准备移交包的批准 |
| kiwi_merchant_rfq_get_job | job_id | read；作业状态 |

确认关键 SKU 的工具不能相信模型自报 human_confirmed；首版通过独立表单写入确认，再由工具读取其 confirmation_ref。为避免宿主限制阻塞，CLI 具名交互也可以实现同一确认命令，但必须绑定认证上下文。

`06_host/tools.json` 是工具设计契约，不是 WorkBuddy 可直接导入的官方 manifest。平台资源 ID、真正的 MCP URL、授权端点和回调必须在私有环境补齐并实测，交接包不编造这些值。

## 11.3 响应与错误

统一响应：schema_version、trace_id、data 或 error、warnings、completeness。读列表必须有 complete／next_cursor，不能把被截断的 JSON 当完整事实提供给模型。结构化 content 为权威，文本摘要不得声称更多。

| 错误码 | 语义 | 是否可直接重试 |
| --- | --- | --- |
| AUTH_REQUIRED／FORBIDDEN | 身份或权限不足 | 否，重新认证／授权 |
| TENANT_MISMATCH | 对象不属于当前商家 | 否，不泄露对象存在性 |
| NEEDS_CLARIFICATION／SKU_AMBIGUOUS | 关键需求未确认 | 否，先补字段 |
| SOURCE_UNAVAILABLE／SOURCE_CONFLICT | 事实缺失或权威冲突 | 前者可有界重读，后者须人工解决 |
| FACT_STALE | 超过新鲜度阈值 | 刷新事实再生成版本 |
| PRICING_INVALID／UNSUPPORTED_TERM | 金额或条款超出契约 | 否，修正输入 |
| POLICY_REQUIRES_REVIEW | 不符合授权价格／硬策略 | 否，不返回私密阈值 |
| VERSION_CONFLICT／APPROVAL_STALE | 当前版本或候选已变 | 读取最新版本后重新准备 |
| IDEMPOTENCY_CONFLICT | 同键不同请求 | 否，客户端纠正调用 |
| OPERATION_UNKNOWN | 中断导致结果尚未确定 | 先查询／对账，禁止盲重放 |
| CAPABILITY_UNAVAILABLE | 上游／宿主不支持 | 采用明确降级路径或停止 |

超长材料、低置信提取和不完整检索用明确 warning 或 blocker 表达，不静默丢弃。日志保留内部错误与 trace_id，但面向模型的错误不回显底价、凭据、内部 URL 或完整堆栈。

## 11.4 独立管理页 API（新增，非 WorkBuddy Open API）

建议以实例私有路径 `/admin/rfq/` 承载浏览与确认；写接口包括 `POST /admin/rfq/releases/{id}/approve` 和 `POST /admin/rfq/releases/{id}/reject`。同源会话、CSRF 和一次性确认凭证全部有效才受理。服务端从会话解析 actor，不接受任意 merchant_id／principal_id。

下载接口可为 `GET /admin/rfq/artifacts/{artifact_id}`，始终认证并校验归属，不把带长期访问凭据的下载链接放进模型。MCP 产物资源读取走其已认证通道，具体宿主文件保存行为列入实机测试。

# 12　WorkBuddy 接入设计

## 12.1 三层授权不可混淆

A：Buddy 应用在平台的创建与用户授权。B：WorkBuddy 作为 MCP 客户端访问商家实例。C：商家实例访问 shopping-cli／ERP 的经营凭据。三者分别管理，不能复用 client_secret，也不能把 WorkBuddy 的 token 直接当作 ERP 凭据。

官方文档支持远程 MCP + Skill，也提供本地 stdio 与用户自填 Token 方式；一个连接器只配置一个 MCP Server。Buddy 内置连接器的 OAuth 要求与非 OAuth 跳过绑定配置需要结合实际客户端测试，不能把某个配置字段当成全路径已通过。[S12][S13]

## 12.2 保持公共网关边界的接入顺序

M0–M3：独立 CLI／可信管理页，商家实例私有运行，不动公共网关。

M4 私有试点：WorkBuddy 通过“自定义连接器”直接连接该商家实例的 MCP。优先在受控网络中使用已有认证实现；若采用本地 stdio bridge，bridge 只做传输适配，不拥有业务状态或复制状态机。两个方案不混放在一个连接器配置中。

公开产品阶段：使用商家控制的专用管理域名及受审查的 OAuth 接入。当前生产实例 `/mcp`、`/oauth/*` 未公开，本设计不直接修改现有域名反向代理；先在 staging 用新管理域名验证暴露面，再审批上线。若平台无法为每个商家配置目标 MCP，就暂停完整 Buddy 的实例能力上架，保留私有专家／连接器试点，不重新启用公共网关代理。[S03]

## 12.3 专家与技能组织

一个商家询报价专家，三个技能：`rfq-intake`、`quote-build-review`、`quote-release-followup`。这些技能不携带策略阈值、密钥或租户配置；引用同一工具契约。

专家花名和品牌不在本次强行冻结。开发名称使用 `kiwi-rfq-workbench`，对外暂称“Kiwi 询报价工作台”。与现有“目录注册与发布”Buddy 配置隔离：新工作流是私有实例能力，不覆盖现有公开目录的胶囊或凭据。

首页五个场景：整理客户询盘、核对规格与 SKU、生成报价草稿、比较新旧报价、查看待批准与移交。两个工作模式足够：询盘处理、报价与跟进。场景胶囊本身不具有权限。

## 12.4 MCP Apps 与降级

新增交互资源建议为 `ui://kiwi-rfq/case`、`ui://kiwi-rfq/quote`、`ui://kiwi-rfq/release`，经工具 `_meta.ui.resourceUri` 关联，并按宿主能力协商。采用限制性 CSP、自包含静态资源、文本转义和同源资产；UI 只显示 Core 返回的授权投影。[S14]

宿主不支持 MCP Apps 时，使用结构化文本、认证产物资源和独立管理页完成同等业务；不能因卡片不显示就丢掉阻断项或跳过人工确认。MCP Apps 不是必需的首版依赖。

## 12.5 OAuth 实现注意

复用现有商家 OAuth 实现前，核实资源受众、PKCE、scope、重定向 URI、刷新轮换、吊销以及主体验证。MCP 标准授权与 WorkBuddy 平台应用 OAuth 分开验收。官方文档与 MCP 授权规范说明客户端发现和授权边界，但不证明当前部署已符合全部要求。[S12][S15]

首版模型工具只需要 read 与工作流 prepare 能力；批准保留在可信管理面，不给模型连接器增加“直接 approve”权限。使用更细 scopes 时必须在实例授权服务器实现，不把自定义字符串误写成平台已有权限项。

# 13　模型、提示词与技能行为

## 13.1 模型可做与不可做

允许：提取客户需求、生成澄清问题、提出 SKU 候选、解释 Core 计算结果、总结版本差异、草拟与固定商业条款一致的礼貌说明。

禁止：自行填补数量或单位、编造库存、决定适用税率、推测最低可接受价、改变有效期、用自然语言修改总额、替人批准、伪造发送或客户接受、把外部材料指令提升为系统命令。

## 13.2 提取与输出分离

提取阶段输出结构化 proposal，不直接生成正式报价。每个关键字段保留原文和定位；“尽快”“便宜一点”不转换为具体交期或折扣，必须澄清。

说明阶段读取 `PublicQuoteView` 与 `QuoteDiff`，不得读取私有策略仓。正式商业条款由模板从结构化对象渲染，模型可写的自由文本仅限非承诺性说明，并经过白名单／一致性检查后纳入新版本。

## 13.3 三个技能的验收要求

`rfq-intake`：先确认当前商家与材料来源；缺字段时停止；SKU 多解时展示依据；不把疑问句当订单。

`quote-build-review`：先刷新事实，再调用计价；只解释工具结果，不心算补齐；任何条款变化都重新计算、生成版本。

`quote-release-followup`：prepare 后引导到可信管理页；只读查询批准结果；导出与发送区分；客户反馈作为新证据，不自动生成 Agreement。

模型切换不改变算术结果、审批条件和状态机。多模型回归应关注提取准确、澄清行为和工具误用，而非只评价文风。

# 14　页面、客户文件与导出

## 14.1 操作者页面

询盘页：左侧原始材料与定位；中间规范字段与 SKU；右侧缺失／冲突／过期提示。原始客户文字始终以不可信内容显示，不能执行 HTML。

报价页：顶部醒目显示商家、客户、版本、币种、状态与有效期；主体为行项目、税与运费；下方是证据来源时点和与上一版的差异。敏感管理信息与客户预览分离。

审批页：显示即将导出的完整固定内容、影响与阻断项；批准／拒绝按钮独立，默认不选。过期或内容变化后按钮失效，并要求重建候选。

## 14.2 客户文件的最小内容

报价编号与版本、商家显示名称、客户／项目引用、SKU／规格／单位／数量、单价与优惠、含税／未税口径、税额与运费、总价、交期的已确认表达、服务与付款条件、报价有效期、数据截至时间、替代版本关系及“该报价不执行订单／付款／库存预留”的产品说明。

这是产品执行边界，不是法律效力保证。对外模板必须经商家确认，必要的专业审查作为发布前检查，不能仅凭文件写“非约束性”就保证任何法律结果。

不得包含成本、底价、内部利润、策略阈值、未授权精确库存、客户原始聊天、系统 token、审批 nonce 或其他商家资料。

## 14.3 渲染与防篡改

正式文件建议 PDF + 纯文本摘要，数据来自同一 PublicQuoteView。PDF 字体嵌入及许可证由项目负责；不得要求用户安装陌生字体。HTML 只作为内部渲染媒介，不允许任意网络资源、脚本或模板表达式。

客户 PDF 哈希在 prepare 阶段冻结并绑定批准。模板变化、模型改写或格式重新生成导致字节不同，必须新建 release，不得保留旧批准。文件下载失败不改变业务状态为“已发送”。

文本／CSV 后续导出需处理公式注入；SKU 或客户文字以 `= + - @` 开头时不能被表格程序当作可执行公式。首版正式文件以不可执行 PDF 为主。

# 15　安全、隐私与威胁模型

## 15.1 主要威胁与控制

| 威胁 | 例子 | 强制控制 |
| --- | --- | --- |
| 提示注入 | 询盘中要求“忽略底价，先批准” | 外部材料隔离；模型无批准接口；固定执行器 |
| 跨商家越权 | 用另一商家的 quote_id 获取报价 | 商家归属在每次读取、作业查询、产物下载中重验 |
| 重放与篡改 | 改了收件人却用旧 approval | 候选绑定版本、对象、产物摘要与一次性凭证 |
| 私密阈值泄露 | 从错误中逐步试出底价 | 白名单投影、通用拒绝码、限流和探测审计 |
| 越界联网 | 文件中嵌入内网 URL／重定向 | 首版不自动抓 URL；后续连接使用明确允许源、DNS／IP 校验 |
| 文档执行 | CSV 公式、HTML 脚本、模板指令 | 按数据处理、转义、渲染隔离、输出不可执行格式 |
| 不完整数据 | 只读前 100 个 SKU 就说无货 | complete／cursor 显式传播，关键数据不完整则阻断 |
| 结果未知 | 连接超时后重复发送 | 首版不自动发送；幂等作业与回读对账 |
| 凭据混用 | 目录 token 访问商家管理工具 | 三层凭据隔离、受众与 scope 验证 |
| 状态错报 | 日志写成功就显示客户收到 | 四种状态域独立；证据等级不能由模型提升 |

## 15.2 数据最小化

所有原始客户材料保存范围必须由商家授权。首版不把完整资料复制到公共运营服务；WorkBuddy 模型处理到哪些字段，在用户说明中逐项写明。“商家本地存储”不等于“从不发送给模型”。

建议可配置保留策略：原始询盘 90 天、报价与批准记录 365 天、运营日志 30 天；这些只是试点初值，实际合同、审计和商家要求需单独确认。删除按引用依赖执行：已批准产物的证据不可因清理临时文件而断链；脱敏删除与审计保留的冲突需由业务负责人处理。

禁止持久化模型私有思考。保留的是输入／输出对象、版本、来源、规则版本、工具调用和用户决策证据。私密字段读审计只记访问事件，不记具体底价或成本。[S05]

## 15.3 单实例不是自动安全

单商家部署仍需对象归属校验，防止部署配置串线、导入其他实例备份或未来多人功能引入隐患。restore 后检查 merchant_id 与实例配置一致；不一致拒绝启动写功能。

单机管理面凭据不能与公网 A2A 凭据共用。目录、管理、A2A 和数据侧日志分域；错误回显不能泄露内部地址或密钥。

# 16　与 KNP、A2A、shopping 轨及交易移交的关系

## 16.1 首版没有 AI 买家，也能完整工作

人工来源 RfqCase 包含本地 source_record；既有 A2A 或 shopping 会话可以通过 `ExternalThreadLink` 关联到它，但各轨 source_id、native_status、消息校验结果保留原样。统一看板是投影，不是重新解释协议状态。[S07]

禁止为人工客户生成虚假的签名、公钥、Agent Card 或 actor=buyer 的 KNP 消息。客户在微信里说“行”，最多记录为客户反馈证据，不能自动转成双方 AcceptedNonbindingAgreement。

## 16.2 后续 A2A 桥接规则

只有通过 A2A 执行桥门之后，才将已批准 QuoteRevision 映射为现有 Offer／CounterOffer：line items 对应 sku、quantity、unit_price；价格、履约、服务、付款和有效期进入既有 TermSet 对应字段。映射要逐项保真；无法表达的条件返回 UNSUPPORTED_TERM，不藏进模型文字并声称互操作成功。[S09]

审批先于正式报价发送。桥接复用既有 negotiation ledger、消息幂等与恢复，不从工作台直接伪造 wire 消息，也不调用 shopping 的人工处理接口代替 A2A 实现。基线代码的 A2A 人工处理缺口是明确的后续阻断项。[S05]

## 16.3 手工报价与 KNP Agreement 分别移交

人工报价的移交记录 `origin.kind=manual_quote`，引用 quote_id、revision、release_id 和客户意向证据。A2A 路径 `origin.kind=knp_agreement`，必须引用真实已校验的 agreement_id。二者不能通过补一个字段混为同一证明。

首版移交只生成文件包：客户报价、规范需求、证据目录、报价版本和校验摘要。人工提交给原有系统之后可保存 OWNER_RECORDED；只有经目标系统凭据查询，或验证目标方签发且绑定 packet_digest 的回执，才是 TARGET_VERIFIED。

“目标系统受理”只表示该系统接收了报价／销售线索／移交材料，不表示创建订单。生成采购单草稿与正式提交采购单也要分开；本版不执行正式订单写入。

## 16.4 目标回执验证

后续自动回执至少校验 issuer、audience／merchant、handoff_id、packet_digest、目标对象类型、目标对象 ID 和时间。若通过 API 查询，以目标方已认证接口为准；若通过签名回执，验证可信密钥和防重放。不接受模型自己填写 `verified=true`。

同一幂等键只对应一份移交内容。目标系统不支持幂等或结果查询时，自动提交功能不能通过验收；降级为人工材料导出，不能承诺“恰好一次”。

# 17　部署、配置、监控与回滚

## 17.1 首版拓扑

沿用商家单实例：一个 Merchant Core 写入者、一个商家 SQLite、一个私有产物目录和一个 shopping-cli 数据入口。独立管理页可与 Core 同进程；MCP adapter 不能再成为第二个数据库写入者。公共目录网关单独运行，数据卷与 OS 用户隔离。

当前部署文档的现网边界是实例 MCP／OAuth 不对公网。接入 WorkBuddy 的新管理入口必须在 staging 单独设计和批准，不能直接把原来 404 的 `/mcp` 路由放开当作配置修复。[S03]

## 17.2 配置分类

建议新增命名空间 `merchant_rfq`，初始字段：enabled、data_scope、limits、freshness、approval_ttl、artifact_root、retention、feature_flags。此为提案配置，不应直接粘贴到现有 profile schema 并假设能解析。

建议功能开关：`rfq_core=true`、`rfq_release=false`（验收后打开）、`rfq_workbuddy=false`、`rfq_auto_send=false`、`rfq_a2a_bridge=false`、`rfq_target_submit=false`。后三项首版固定关闭，不允许由模型改动。

开发环境允许人工演示数据，但生产启动拒绝 demo source／fake price；所有测试数据带 SYNTHETIC 标记。连接真实数据失败时关闭发布能力，读取历史草稿仍可用。

## 17.3 服务目标（建议，不是当前性能事实）

元数据读取 p95 ≤2 秒；本地确定性计价 p95 ≤1 秒；长任务在 ≤2 秒给出 job_id。MCP 单次返回以 30 秒内为上界设计，与官方建议及既有超时保护相协调。实际目标需在固定硬件、网络、SKU 规模和文件大小下压测。[S10][S12]

首版输入上限：单个粘贴文本 100 KB；单 CSV 2 MB／最多 1,000 行，其中一份报价最多 100 行；单实例同时运行 2 个渲染作业。超限明确拒绝或要求分批，不能截断后继续正式报价。

## 17.4 监控与告警

记录：询盘处理耗时、关键字段缺失、源失败／过期、报价校验失败、审批过期／冲突、重复请求、下载失败、UNKNOWN 作业和跨租户拒绝。业务 trace_id 贯穿来源、case、quote、release、artifact 和 handoff。

告警关注未知执行结果、连续源不可用、权限失败异常增长、数据库迁移失败和产物摘要不一致。日志不记录客户原文、底价或完整 token。

## 17.5 备份与恢复

SQLite 使用一致性备份接口，与产物引用清单共同形成备份批次，不能只复制正在写入的 DB 主文件而漏 WAL。定期恢复到隔离目录，验证所有已批准产物的哈希与引用完整性。

本版建议初始 RPO ≤24 小时、RTO ≤4 小时；这是需业务确认和演练的目标，不宣称已实现。未建立连续同步前，不沿用旧清单中的 RPO=0 字样。[S11]

回滚优先关闭新增发布／宿主功能开关，保留历史报价只读。破坏性 schema 回退前禁止继续写入，先备份并运行兼容读取校验；不得因回滚删除批准与发送记录。

# 18　开发目录、任务拆分与门槛

## 18.1 建议新增目录

```text
src/merchant-core/rfq/
  service.ts              # 单一业务入口
  types.ts                # 领域类型与投影
  repository.ts           # 持久化与 CAS
  source-records.ts       # 原始材料、定位、确认记录
  fact-resolver.ts         # shopping-cli 事实与新鲜度
  pricing.ts              # 确定性算术
  policy.ts               # 硬策略与可见性
  quote-revisions.ts      # 不可变版本与差异
  release-coordinator.ts  # 既有命令审批接缝
  artifacts.ts            # 渲染／摘要／权限下载
  delivery.ts             # 发送证据等级
  handoff.ts              # 移交材料与回执
src/mcp/merchant-rfq-tools.ts
contracts/merchant-rfq/0.1.0/
tests/merchant-rfq/
integrations/hosts/workbuddy/kiwi-rfq-workbench/
```

目录是建议增量，不是本次已提交代码。`schema` 定义是序列化权威，TypeScript 类型从 schema 生成或经类型一致性测试维护；不得文档、类型、工具描述各自拥有不同必填字段。

## 18.2 分阶段实施与退出条件

| 阶段 | 实施内容 | 退出门槛 |
| --- | --- | --- |
| M0 基线与契约 | 固定提交、查复用点、运行原 verify、核对数据侧 pin、修文档冲突、冻结候选契约 | 原测试通过；所有前置能力有运行证据；无未解释版本漂移 |
| M1 询盘与事实 | 来源、提取 proposal、人工确认、SKU、权威快照、分页 | 真实脱敏样本能够到 READY；未知／冲突都阻断 |
| M2 计价与版本 | 纯函数计价、规则校验、revision、diff | 全部算例一致；错币种／优惠越界／过期等失败正确 |
| M3 审批与导出 | 复用 CommandLog、一次性确认、原子激活、下载、发送记录 | 伪造批准／竞态／重放无越权；独立管理页闭环成功 |
| M4 私有宿主 | 单商家直连 MCP、专家与三个技能、文本降级、可选 MCP Apps | WorkBuddy 实机完成相同任务；断开宿主状态仍完整 |
| M5 真实试点 | 同材料对照、复用与人工成本、客户反馈、移交证据 | 达到第20章阈值后再决定完整 Buddy 产品化 |
| M6 可选扩展 | A2A 人工报价桥／自动渠道／目标系统适配 | 各自独立门槛；不与首版绑定发布 |

没有任何阶段因为“下一阶段界面已做好”而豁免当前 gate。历史提交消息中的测试通过记录只能作线索，M0 要保存本次执行日志、代码 SHA、依赖锁和环境版本。

## 18.3 可直接建立的开发任务

RFQ-001：源码基线与状态库扩展接缝；RFQ-002：八份候选 schema 与兼容策略；RFQ-003：输入来源和字段确认；RFQ-004：SKU 匹配及完整性；RFQ-005：价格／库存快照；RFQ-006：整数计价与算例；RFQ-007：不可变 quote 与 diff；RFQ-008：发布执行器与事务；RFQ-009：可信管理页；RFQ-010：产物投影和 PDF；RFQ-011：发送／移交记录；RFQ-012：MCP 工具；RFQ-013：WorkBuddy 私有接入；RFQ-014：安全、恢复与原系统回归；RFQ-015：真实任务试点。

依赖顺序：001→002→003/004/005→006/007→008/009/010→011；012 依赖003–011的服务契约；013 依赖012及安全门；014覆盖所有阶段；015依赖M3，完整平台产品化依赖M5。

# 19　测试体系与验收矩阵

## 19.1 四类证据分别计数

L0 交接包自检：JSON 可解析、schema 自身合法、样例能校验、参考算例正确、文件清单完整。仅证明材料一致性。

L1 项目自动测试：集成到 Kiwi 后的类型检查、原有回归、RFQ 单元／集成／安全／恢复测试。必须在固定源码与依赖下运行。

L2 宿主和部署实机：WorkBuddy 连接、权限、资源读取、人工批准、导出、重启及撤销。必须有真实客户端版本与操作证据。

L3 商家任务试点：真实材料、用户独立操作、人工成本、复用与付费。不能由开发者自导自演替代。

本次只运行附包的 L0 自检。L1、L2、L3 在交接包中明确标记 NOT_RUN；不得把 L0 的 PASS 改写为产品验收通过。

## 19.2 首版必须覆盖的测试组

| 组 | 必须覆盖的关键失败 |
| --- | --- |
| 导入与提取 | 相同材料重复导入、错客户、未确认数量、冲突 SKU、非法 CSV、输入超限 |
| 事实与完整性 | 翻页遗漏、源故障、价格单位混淆、未知库存、过期规则、来源冲突 |
| 计价 | 含税／未税、逐行舍入、优惠越界、税率非法、总额上限、未知运费 |
| 审批与权限 | 模型自批、无凭证、主体不符、旧版本、收件人变化、并发批准 |
| 幂等与恢复 | 同键异内容、超时后查询、进程中断、临时产物回收、未知执行结果 |
| 展示与导出 | 私密字段泄露、文件哈希变化、已导出误报送达、跨商家下载 |
| 协议与移交 | 人工来源伪装 A2A、跨轨执行、伪造目标回执、订单／库存越界 |
| 宿主与回归 | MCP Apps 不支持、OAuth 撤销、宿主关闭、旧工具／协议回归 |

详见 `05_acceptance/acceptance-matrix.json` 的80项 Given／When／Then 规格及状态。测试 ID、阶段和证据路径固定，方便开发代理逐项回填；初始不能预填“通过”。

## 19.3 差异化对照

A 组：通用模型获得同样材料及可用工具。B 组：原生 WorkBuddy，不安装本产品。C 组：本产品。任务、资料、字段金标和人工审核口径一致，随机或轮换顺序以减少学习效应。

计时覆盖安装配置分摊、资料整理、执行、核验、返工与再次使用。准确性由懂业务的人盲审固定字段，不用另一模型一句“看起来更专业”作为唯一裁判。

# 20　试点指标与停止条件

## 20.1 无需 AI 买家的试点定义

本版 Qualified RFQ 是真实外部客户提出、商家确有商品或服务能力响应、关键需求足以形成可审核报价的询盘；缺字段的真实询盘也应记录漏斗，但不能强行计入完成报价分母。种子数据、模型模拟客户、内部自测不计入真实任务。

建议验证门槛：3家外部商家、至少2位真实外部客户来源、累计20次真实合格询盘、至少5次重复使用任务。客户可以通过原有渠道沟通，不要求有两个 AI Buyer。此为人工询报价的新验证口径，不冒称已经通过历史 A2A 网络试点门。

## 20.2 产品与安全指标

主要价值指标：每份合格报价的人工净处理时间相对基线至少减少约40%，且关键字段错误率不得恶化。该阈值是本次建议投入标准，不是已证明效果。

安全硬门：未经批准的正式发布为0、跨商家泄露为0、虚假送达／成交／移交状态为0、演示价用于真实报价为0。任何一项出现即停止正式发布功能并调查。

采用指标：至少2家商家在第30天仍有自发使用；至少1家完成可核验的目标系统材料受理，人工自述另计；至少2家愿意以实际付费而非口头夸赞继续使用。价格不在技术设计中臆定。

## 20.3 暂停条件

真实询盘主要是无法结构化的工程设计、所需数据无法合法获得、用户不愿授权关键事实、审核比人工报价更耗时、只需要偶发写一段话、或缺少可验证的价格／税／运费规则，都应暂停扩展。

此时保留已完成契约与核心能力，不同时转去开发完整 CRM、采购平台、营销助手来掩盖本任务缺少需求。是否回到商品运营主线另行决策，不在本分支自动扩范围。

# 21　架构决策记录与待确认项

## 21.1 ADR 摘要

ADR-01：沿用独立 Merchant Core，宿主可替换。替代方案是全部状态放在 WorkBuddy 会话；拒绝原因是恢复、权限和审计不可控。

ADR-02：保持公共目录网关不碰实例。替代方案是中心网关代理所有商家工具；当前不采用，避免违背已确认信任边界。[S03]

ADR-03：新增人工 RfqCase，不扩 KNP wire。替代方案是把人工客户伪造为 Agent；拒绝原因是身份与协议证据失真。

ADR-04：确定性计价、模型解释。替代方案是模型直接计算最终金额；拒绝原因是复现、舍入与授权规则难以保证。

ADR-05：正式文件摘要绑定批准。替代方案是批准后再让模型重写 PDF；拒绝原因是批准对象与交付对象可能不同。

ADR-06：先私有闭环，再 Buddy 产品化。替代方案是同时开发公开应用、代理网关、自动渠道和完整交易；拒绝原因是验证成本与安全面超出首版。

## 21.2 必须确认但不阻塞文档交付的事项

| 项目 | 默认设计 | 必须确认的证据 |
| --- | --- | --- |
| 首批商家行业与样本 | 已有 SKU、整数数量、CNY | 真实脱敏询盘与报价规则 |
| shopping-cli 可用字段 | 仅经已有数据入口，不直连 ERP | 固定版本能力探测、价格单位、税／运费来源 |
| 审批身份映射 | 单商家具名 owner | OAuth subject、profile principal、store principal 对照 |
| WorkBuddy 连接路径 | 商家私有实例直连，不改公共网关 | 客户端实机、每商家 URL／OAuth 配置能力 |
| 正式文件格式 | PDF＋文本摘要 | 目标客户端下载与中文字体渲染 |
| 对外模板与保留策略 | 由商家批准 | 业务／必要专业审查记录 |
| 数据库事务接缝 | 原状态库单 writer | 同一事务覆盖候选与 release 的自动测试 |

未决项应进入 issue 和 gate，不用假设已解决的表述写入发布材料。

# 22　交接包、运行方法与来源

## 22.1 同版交接包的真实内容

`kiwi-rfq-workbench-v0.1.0/` 中包含本设计 Markdown、八份候选 JSON Schema、样例、参考计价实现与算例、80项验收规格、三个技能草稿、MCP 工具设计契约、来源锁定记录、文件清单与自检报告。所有文件实际打包，不引用一个不存在的“另附交接包”。

主文档另提供可编辑 Word；它与 Markdown 由同一内容生成。包内不包含 Kiwi 全仓库、生产凭据、官方审核通过的连接器包、商家真实资料或本次未开发的生产服务。

## 22.2 自检方法

```bash
cd kiwi-rfq-workbench-v0.1.0
python3 -m pip install -r 04_reference/requirements.txt
python3 04_reference/validate_handoff.py
```

自检检查 schema、样例、参考算术、跨字段一致性和文件清单。运行成功不改变 `05_acceptance/acceptance-matrix.json` 中的业务验收状态。

开发者落库之后另在 Kiwi 仓库执行 `npm ci` 与现有 `npm run verify`，再增加 RFQ 测试。必须在本机实际拥有正确仓库路径时执行，不照抄一个假设存在的用户本地路径。

## 22.3 来源与核查记录

以下 GitHub 链接均固定到本次提交；页面资料按2026-09-19检索。仓库文档与源码不一致时，先保留差异，再以最新明确决策和实际实现／运行证据确定，不把旧说明当成能力事实。

[S01] 包版本与脚本：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/package.json`。

[S02] README（含版本与演示说明漂移）：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/README.md`。

[S03] 0.10.0 变更与网关边界：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/CHANGELOG.md`；`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/docs/merchant-buddy/merchant-connector-deployment.md`。

[S04] 命令与审批：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/src/merchant-core/commands.ts`。

[S05] Merchant Core（含 A2A 人工处理暂不可用）：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/src/merchant-core/service.ts`。

[S06] 工作台 facade 与公开字段：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/src/merchant/workbench-service.ts`。

[S07] 两轨适配：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/src/merchant-core/negotiation-adapters.ts`。

[S08] 经营事实入口：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/src/commerce/data-source.ts`。

[S09] KNP 1.0 wire schema：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/contracts/negotiation/1.0/schema.json`。

[S10] MCP 工具适配与超时：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/src/mcp/merchant-tools.ts`。

[S11] 旧实机清单（开头已标记实例步骤当前不适用）：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/docs/merchant-buddy/workbuddy-e2e-checklist.md`。

[S12] WorkBuddy 连接器官方文档：`https://open.workbuddy.cn/docs/connector`。

[S13] WorkBuddy Buddy 应用官方文档：`https://open.workbuddy.cn/docs/buddy-app`。

[S14] MCP Apps 官方说明：`https://modelcontextprotocol.io/extensions/apps/overview`。

[S15] MCP 授权规范（明确引用版本，并非断言是最新版本）：`https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`。

[S16] 组合 pin：`https://github.com/harrylabsj/kiwi/blob/866dbe69583e3330198696861380043ccc721116/portfolio.lock.json`。文件中的组合 pin 不等同于当前源码提交，也不证明该组合已在本次运行验证。

**交付状态：设计与候选契约已形成；生产实现、Kiwi 集成回归、WorkBuddy 实机和真实商家试点未在本次执行。**
