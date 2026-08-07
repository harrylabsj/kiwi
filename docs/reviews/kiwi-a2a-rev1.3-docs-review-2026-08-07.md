# Kiwi 文档评审：rev1.3 基线 + products/ + protocol/（2026-08-07）

评审人：Claude Code
评审日期：2026-08-07
评审范围（6 个文件）：

```text
docs/kiwi-a2a-architecture-baseline-rev1.3.md
docs/products/kiwi-catalog-product-architecture-v0.1.md
docs/products/shopping-cli-commerce-data-hub-v0.1.md
docs/protocol/kiwi-negotiation-protocol-1.0.md
docs/protocol/kiwi-negotiation-protocol-1.0-rev1.3.md
docs/protocol/kiwi-transaction-handoff-0.1.md
```

## 0. 版本关系与文件布局（最重要的背景）

目录里 mtime 与内容版本是**反向**的，按"最新文件"检索会拿到旧内容：

| 文件 | git 状态 | doc_revision | 身份 |
|---|---|---|---|
| `kiwi-a2a-architecture-baseline.md` | 已提交（HEAD=`b189a7f`，v1.0.0） | 1.2 / 08-05 | **v1.0 发布版基线**（无 Handoff） |
| `kiwi-a2a-architecture-baseline-rev1.3.md` | **未提交** | 1.3 / 08-07 | v1.1 方向草稿（Handoff + 产品拆分） |
| `protocol/kiwi-negotiation-protocol-1.0.md` | 已提交（v1.0.0） | 1.2 / 08-07 | **v1.0 发布版协议** |
| `protocol/kiwi-negotiation-protocol-1.0-rev1.3.md` | **未提交** | 1.3 | v1.1 方向草稿 |
| `docs/products/`（2 份）、`protocol/kiwi-transaction-handoff-0.1.md` | **未提交** | 0.1 | v1.1 方向草稿 |

- **rev1.3 是发布（08-07 06:41）前的下一步工作草稿，不是已发布修订**。v1.0.0 按 rev 1.2 发布；rev1.3 系列（含 products/、KTH/0.1）是发布后的 v1.1 迭代。
- 风险：① 按 mtime 排序会拿到旧内容（本次评审即踩坑，已核对 git 后纠正）；② 5 个文件全部 untracked，有丢失风险；③ 发布 commit 未 bump 基线修订号（发布版基线 frontmatter 仍是 1.2 / 08-05，与内容里的 08-07 宣布戳并存）。

**建议（P0）**：立即 commit 或移入 `docs/drafts/`；发布时 bump frontmatter 修订号成为流程的一部分。

## 1. 已修复的 P0 文字错误（本轮已改）

| 文件 | 位置 | 修复 |
|---|---|---|
| `protocol/kiwi-negotiation-protocol-1.0.md` | `:13` 宣布块 | 26/26 → **27/27** |
| `protocol/kiwi-negotiation-protocol-1.0.md` | `:16` | 删除重复的 H1 标题 |
| `protocol/kiwi-negotiation-protocol-1.0.md` | `:1359` 附录 B | "MUST be replaced … before public interoperability release" → 生产 authority 已上线的事实陈述（`https://kiwi.harrylabsj.com`，2026-08-06 起） |
| `protocol/kiwi-negotiation-protocol-1.0-rev1.3.md` | 同上三处 | 同步修复，避免草稿与发布版再次漂移 |
| `kiwi-a2a-v1.0-readiness-audit-2026-08-06.md` | `:4` 方法行 | "26 条" → "27 条" |

## 2. kiwi-a2a-architecture-baseline-rev1.3.md

### 总体评价

从 v1.0 基线向 v1.1 扩展的骨架是对的：产品拆分（Kiwi / kiwi-catalog / shopping-cli 三产品边界）、Handoff 作为"桥而不是交易"、§35A 全链路的候选→策略→批准→重验→执行、§44 把壁垒明确为"成交前成本"而不是替代平台订单/支付/履约——定位陈述是全仓最好的。**但作为文档，它当前的身份和引用是乱的。**

### 问题

- **[P0] R1. 文档身份冲突**：frontmatter `target_product: "Kiwi A2A v1.0"` 但 `scope: "Agent-to-Agent Commerce through Safe Transaction Handoff"`（v1.1 概念）；同一个文档同时装已宣布的 v1.0 完成定义（§41）和 v1.1 完成定义（§41A）；§5 架构图画进了 v1.1 的 Handoff Engine / Commerce Data 层。它既不是"v1.0 基线的新修订"，也不是干净的 v1.1 基线。建议：要么拆成"v1.0 基线冻结 + v1.1 基线草稿"两份，要么把 target_product 改为 v1.1 (draft) 并明确"本文是 v1.1 方向草稿"。
- **[P1] R2. §35A 与 KTH/0.1 双份定义已出现事实分歧**：同一套 Handoff 概念在基线 §35A 和 `protocol/kiwi-transaction-handoff-0.1.md` 各定义一次，措辞不同且已不一致——Handoff 对象字段（基线有 `buyer_identity_ref`/`destination_uri_or_ref`/`destination_payload`，KTH 是 `destination_ref` 且无 buyer_identity_ref）、MVP 目的地数量（基线 6 类 vs KTH 4 类）、状态"不得伪装成"清单（基线 3 个 vs KTH 5 个）、`handoff_digest`（基线有、KTH §6 无）。建议：§35A 收敛为指向 KTH/0.1 的指针，对象/状态/字段只在 KTH 定义一次。
- **[P1] R3. 基线 §36 安全不变量未覆盖 Handoff 层**：rev1.3 的 §36 仍是 24 条，没有任何 Handoff 不变量；而协议 rev1.3 已补了不变量 21（"downstream Transaction Handoff MUST NOT be represented as a KNP order/payment/inventory side effect"）。基线既然把 Handoff 纳入 scope，应同步补 [N] 不变量（handoff 无交易副作用、destination URL 安全、不得伪装外部成功）。
- **[P1] R4. §42 规范树 4 处断链/路径不符**（已逐项验证）：
  - `docs/kiwi-catalog-product-architecture.md`、`docs/shopping-cli-commerce-data-hub.md` — **不存在**，实际在 `docs/products/…-v0.1.md`；
  - `docs/testing/kiwi-a2a-v1-test-plan.md` — **不存在**（`docs/testing/` 目录不存在）；
  - `schemas/`、`test-vectors/` — **不存在**，schema 实际在 `contracts/negotiation/1.0/schema.json`（v1.2 发布版 §42 同样引用 `schemas/`，同病）。
- **[P2] R5. §34 产品定位与 products/ 两份文档重复**：34.1≈catalog 文档 §1–4、34.2≈shopping-cli 文档 §1–2，措辞已出现轻微漂移（如 `observation` 只在基线出现）。母文档应保留摘要+指针，避免三处维护。
- **[P2] R6. §34.2 "读取/受控写入边界"未解决写权威问题**：与 shopping-cli 文档同源（见 §4），写操作与外部权威源（ERP/PIM）的关系未定义。
- **[P3] R7. 正式规范里出现昵称"项目维护者"**（`:557`"统一使用项目维护者实际控制域名"）：公开发布到 kiwi.harrylabsj.com 前应改为"Kiwi 项目实际控制域名"。

## 3. docs/protocol/（3 个文件）

### 3.1 kiwi-negotiation-protocol-1.0.md（发布版）

**优点**：JCS+SHA-256 确定性 wire、三状态正交（negotiation/approval/A2A task）、`(sender_identity, message_id)` 幂等主键、condition 语法治理（禁 eval/正则/JSONPath）、20 条安全不变量、fail-closed 原则——骨架质量高，与基线 [E]/[N] 不变量映射一致。P0 文字错误已修（§1）。

**遗留问题**：
- **[P1] §21.2 状态转换表不完整**：`AWAITING_CLARIFICATION` 状态没有任何 Withdraw/Decline 行（表里只有 `OPEN/OFFER_OPEN` 两行），从该状态无法经 Withdraw/Decline 到达 WITHDRAWN/DECLINED；Cancel 用了 "non-terminal" 全覆盖，说明作者意识到但只修了一半。补两行，或把 Withdraw/Decline 的 current 列改成 "non-terminal"。
- **[P1] §36.7 与宣布依据的偏差**：§36 完成标准第 7 条要求 "interoperable with an **independent implementation**"，但就绪度审计的互操作证据全部是 Kiwi 自研双侧（`interop-bilateral`），没有第三方实现。宣布依据的是 §41 的 27 条，§36.7 未被审计覆盖。需明确 §36 是否 normative、该条如何判定。
- **[P1] 审计"双证"过度宣称**：审计结论"27/27 全部有代码 + 测试双证"，但矩阵 #21 自标"✅（间接：无直接测试）"。应表述为 26 直接 + 1 间接。
- **[P2] §19.2 digest 剥离歧义**："remove any transport-specific signature fields **not defined by KNP**"——判定权不清晰，建议显式字段白名单。
- **[P2] §13.3 嵌套深度表述含糊**："MUST NOT exceed 2 below the root"——root 自身是否算一层未定义。
- **[P2] §8 信封示例出现 `in_reply_to` 但规则到 §14 才定义**。

### 3.2 kiwi-negotiation-protocol-1.0-rev1.3.md（草稿）

增量内容全部合理：§16.1 Downstream Transaction Handoff（明确"独立子规范治理、不扩展 KNP 交易权限"）、§33 补不变量 21、§24 发现来源列表（kiwi-catalog 可选）、§32 kiwi-catalog 不属 legacy mapping 的澄清、措辞 "becomes"→"remains" 的改进。**主要问题是 R1/R2 的连带**：它和发布版同号共存于 protocol/ 目录（见 §0），且头部"26/26"残留已修。

### 3.3 kiwi-transaction-handoff-0.1.md（KTH/0.1）

**优点**：non-goals 完整、§3 "bridge, not a transaction protocol" 原则清晰、§11 URL 安全清单（HTTPS/redirect/反钓鱼/展示最终目的地）、§17 metrics 的 `reported_external_conversion` 必须标注外部来源、§12 Ledger MUST NOT claim external success。与 kiwi-catalog（§14）、shopping-cli（§15）、KNP（§13）的关系声明都一致。

**问题**：
- **[P1] K1. 与基线 §35A 双份定义分歧**（见 R2）——最优先解决，消除分歧后再冻结 schema。
- **[P2] K2. candidate→handoff 转化规则缺失**：§5 candidate 是 immutable，§6 handoff 由"policy/approval + 重验后"产生，但未定义二者 id 关系（`handoff_candidate_id` → `handoff_id` 如何衔接）、STALE 候选的完整行为链（§10 只说"生成新候选"）。
- **[P2] K3. §9 状态清单无迁移表**：KNP/1.0 有完整迁移表，KTH 只有 7 个状态名——PROPOSED→READY→DELIVERED→OPENED 由谁触发、REVOKED/FAILED 从哪些状态可达，均未定义。状态机语义直接决定"不误报成功"的可审计性，v1.1 实现前需要迁移规则。
- **[P3] K4. 无 schema 布局附录**：KNP/1.0 有附录 A（schemas/ 布局），KTH 未说明 schema 文件放哪。

## 4. docs/products/（2 个文件）

### 4.1 kiwi-catalog-product-architecture-v0.1.md

**优点**：定位（Commerce Agent Catalog + Discovery & Verification Infrastructure）、非责任清单（全仓最好）、§13 MVP 具体可测。

**问题**：
- **[P2] `COMMERCE_VERIFIED` 状态无边界定义**：容易读成"背书/推荐"，与基线 §27"不得把本地单方标记伪装成全球事实、身份验证与商业信誉分离"的立场需要对齐——写明它不代表质量或信誉评级。
- **[P2] §8 搜索维度含 "Handoff capability"**：v1.1+ 功能进了 v0.1 文档（shopping-cli 文档 §8 同病），两处要么都标 "(v1.1+)" 要么都删。
- **[P2] MVP 无 freshness 刷新机制**：搜索支持 "verification freshness" 过滤，但 MVP 9 条没有对应的过期/刷新条目。

### 4.2 shopping-cli-commerce-data-hub-v0.1.md

**优点**：定位转换干净（不再承担 Agent Catalog）、§5 "source authority MUST be explicit, 不得静默合并冲突源"、与 rev1.3 §41A 完成定义逐条对齐（§41A-4/5/6/7/8 ✓）。

**问题**：
- **[P1] 写权威冲突未解决**：§4 接口含 `updateProduct()`/`updateInventory()`/`draftProductChange()`，但 §5 说 inventory→ERP、price→pricing system 是权威源。**权威在外部系统时 shopping-cli 凭什么写？** 需明确：写操作要么限定在 shopping-cli 本地权威字段，要么定义为"向权威系统的代理写入（适配器级 approval）"。
- **[P2] 缺 Non-Responsibilities 清单**：只有一条"不再承担 Agent Catalog"。应同样显式：不做身份权威、不做 UCP 托管、不做协商记录权威、不做价格权威（外部源存在时）。
- **[P2] "authorized business context" 未定义**（§2 Core Data 唯一无形状条目）：谁授权、如何区别于 Private 边界，建议删掉或给定义。
- **[P2] "Handoff capabilities" 前移**（同 4.1）。

## 5. 问题汇总与优先级

| 优先级 | 问题 | 位置 |
|---|---|---|
| P0 | rev1.3 系列 5 个文件未提交（防丢失） | 全仓 |
| P0 | "最新 mtime = 旧内容"的文件布局陷阱 | docs/ 根目录 |
| P0（已修） | 26/26→27/27、附录 B 残留、审计"26 条"、重复 H1 | protocol ×2 + audit |
| P1 | R1 文档身份冲突（v1.0 target vs v1.1 scope） | baseline-rev1.3 |
| P1 | R2/K1 基线 §35A 与 KTH/0.1 双份定义分歧 | baseline-rev1.3 + KTH |
| P1 | R3 基线 §36 缺 Handoff 安全不变量 | baseline-rev1.3 |
| P1 | R4 §42 规范树 4 处断链/路径不符 | baseline-rev1.3（schemas/ 问题 1.2 同病） |
| P1 | 协议 §21.2 状态表缺 AWAITING_CLARIFICATION 迁移 | KNP/1.0 |
| P1 | 协议 §36.7 独立实现互操作未审计 | KNP/1.0 + 审计 |
| P1 | 审计"双证"过度宣称（26 直接 + 1 间接） | audit |
| P1 | shopping-cli 写权威冲突 | shopping-cli 文档 |
| P2 | §19.2 digest 判定、§13.3 嵌套表述、K2/K3、products 四小项 | 多处 |

## 6. 已验证的正面事实

- `https://kiwi.harrylabsj.com` 在线（HTTP 200，Cloudflare）✓
- git tag `v1.0.0` 与 package.json `1.0.0` 一致 ✓
- 就绪度审计引用的 partition 测试确已提交（`b8c900a`）✓
- 审计"74 测试文件"与实际 76 个文件略有漂移（未注明审计时点）

## 7. 第二轮评审（2026-08-07，commit 4697fe0 后）

第二轮换视角：跨文件逐字段比对 + 规格完整性（KTH/0.1 是否达到 KNP/1.0 的规格标准）。

### 7.1 规格完整性缺口（KTH/0.1）

- **[P1] K5. KTH 无 digest/canonicalization 规格，但对象携带 `handoff_digest`**：KNP/1.0 有 §19 完整 digest 规范（RFC 8785 JCS + SHA-256）；KTH 引用 `terms_digest`/`handoff_digest` 却从未定义 `handoff_digest` 的计算范围。v1.1 实现前需补（或显式声明继承 KNP §19 规则）。
- **[P1] K6. candidate 声称绑定 policy version，JSON 无此字段**：KTH §5 绑定清单有 "policy version"（`:121`），candidate JSON（`:96-112`）无 `policy_version`；而基线 §7.4 的 HandoffCandidate 有。KTH 与基线此处已不一致。
- **[P2] K7. handoff 对象缺身份绑定与 digest**：KTH §6 对象无 `merchant_identity`/身份引用、无 `handoff_digest`（基线 35A.2 两者都有）；§10 重验要求 "verify Merchant identity" 但对象不承载该快照，审计链有洞。
- **[P2] K8. OPENED 状态判定来源未定义**：外部 checkout URL 打开后 Kiwi 无法可靠得知（浏览器在 Kiwi 之外）。文档有 `OPENED` 状态与 `handoff_opened` 审计事件，但没说它由"用户确认 / 客户端回传 / 外部回调"哪种机制产生——而这正是"不得从 delivery/open 推断外部成功"防线（§12、§18-8）的关键。判定机制必须显式定义，否则该审计事件无从产生。
- **[P2] K9. candidate immutable 与 STALE 的建模冲突**：§5 "immutable candidate" vs §10 "candidate → STALE，重新生成候选"——immutable 对象如何变 STALE？candidate JSON 无 status 字段，STALE 只能落 Ledger 事件。需明确 STALE 是对象状态还是审计记录状态。
- **[P3] K10. §1 flow 与 §4 不一致**：§1 把 `selected_nonbinding` 画成必经步骤，§4 说 "A Buyer MAY first mark…"。流程图应标可选。

### 7.2 跨文件一致性（新发现）

- **[P2] N1. CommerceDataStore vs CommerceDataSource**：术语表（rev1.3 §6 `:455`）唯一一次出现 `CommerceDataStore`，其余全部（rev1.3 §33/§34/§41A、products/shopping-cli §4/§12）是 `CommerceDataSource`。术语表行为残留，应统一。
- **[P2] N2. capability 命名与 destination 类型命名漂移**：KTH §14 的 catalog capability 是 `supports_erp_handoff`，而 destination type 是 `buyer_erp_request`——同一能力两个名字。建议 KTH §14 的 capability 名直接派生自 `destination_type` 枚举。
- **[P2] N3. 验证状态清单同样无迁移规则**：catalog 文档 8 个 verification 状态（DISCOVERED→REJECTED）与 KTH 7 个 handoff 状态均无迁移表——与 KNP/1.0 有完整迁移表（§21.2）的规格标准不对等。K3 的同类问题在 kiwi-catalog 文档同样存在。

### 7.3 第二轮确认无问题的一致点

- §41A 完成定义与 KTH §16/§17/§18、catalog 文档 §13、shopping-cli 文档 §12 的目标闭环逐条对应 ✓
- `selected_nonbinding` 的 Buyer-local 语义三处一致（基线 §16、rev1.3 §16、KTH §4）✓
- "kiwi-catalog=谁可以谈、shopping-cli=拿什么谈、KNP=怎么谈、Handoff=去哪成交" 的口径在三份文档一致 ✓
- KTH §18 完成标准与 §41A-12/13/14（无订单/支付/库存副作用）对应 ✓

## 8. 第三轮评审（rev1.4.1 bundle，2026-08-07）

评审对象：`kiwi-commerce-v1.1-rev1.4.1-docs/` 自包含文档树（一致性补丁，不扩架构范围）。
协议 rev1.4 与旧树字节一致；CURRENT-DOCS.md 为更新后的权威清单。

### 8.1 第二轮发现吸收对照（全部实证）

| 发现 | rev1.4.1 处理 |
|---|---|
| K8 OPENED 含糊 | ✅ 拆为 `LAUNCHED`（仅表示成功请求 OS/browser/deep-link handler 启动，不证明页面加载）+ `OPENED_CONFIRMED`（需可归属证据：Kiwi 控制 callback / merchant 或 platform 绑定 `handoff_id` 的 callback / verified return URI）；§9 迁移表 evidence 门槛；§36 新增不变量 28；完成标准 12 |
| K9 immutable 冲突 | ✅ §5.1 "Candidate Immutability and Lifecycle Projection"：内容不可变、生命周期为 Ledger 事件投影；完成标准 13 |
| K10 selected_nonbinding | ✅ §3.4 / §16 / KTH §4 三处统一标 OPTIONAL |
| N1 DataStore 术语 | ✅ 术语表 → `CommerceDataSource` |
| N2 capability 词表 | ✅ `handoff_destination_types[]` 单一词表派生自 KTH `destination_type`，禁止 `supports_*` 平行别名（KTH §14 / catalog §8 / shopping-cli §8 三处统一） |
| N3 catalog 状态 | ✅ 三正交域各带迁移表（VerificationLevel / FreshnessState / AdministrativeState）；`COMMERCE_VERIFIED` 边界显式化 |

附带改进：metrics 改 `handoff_launch_rate`/`opened_confirmed_rate`；KTH 完成标准扩至 13 条；测试计划 v0.2 补齐（Scope/catalog/shopping-cli/KTH/E2E/Metrics）。

### 8.2 遗留问题（本轮发现）

- **[P1] §40.1 测试计划断链**：`docs/testing/kiwi-a2a-v1-test-plan.md` 不存在，实际为 `kiwi-commerce-v1.1-test-plan-v0.2.md`（§43 用对名）。错误名自 v1.2 基线一路继承。—— **2026-08-07 已修复**
- **[P1] §41 audit 路径回归**：bundle 生成于 reviews/ 整理之前，写回 `docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md`，实际在 `docs/reviews/`。—— **2026-08-07 已修复**
- **[P2] bundle 路径语义未声明**（README 只有 "Start with docs/CURRENT-DOCS.md"，bundle 内引用在合并前不解析）—— **2026-08-07 已在 README 补充路径语义说明**
- [P3] §14.3 "Kiwi A2A v1.0 不管理订单" 措辞、§34.3 裸用 "KTH" 缩写无定义——未修（下轮顺带）

### 8.3 结论

内容质量过关：evidence 门槛、immutable/lifecycle、词表唯一性、状态域正交均以可测试方式落地。bundle 已合并进 `docs/` 对应目录（protocol rev1.4 与既有文件字节一致，未重复落盘）。
