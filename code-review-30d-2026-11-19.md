# Kiwi 30 天增量代码审查报告

审查日期：2026-11-19。审查范围：`fc7a7b1c..20e73efa`（2026-10-21 → 2026-11-19，共 676 个提交）；当前提交：Kiwi `20e73efa`（分支 main）。

本报告仅覆盖 30 天增量，不表示全库无 bug 或生产上线通过。此前裁定见 [full-codebase-code-review-2026-10-07.md](./full-codebase-code-review-2026-10-07.md)（114 项）与 [code-review-48h-2026-11-19.md](./code-review-48h-2026-11-19.md)（30 项，审查终点 `f7e84df6`）。

## 审查范围与方法

- **规模**：676 个提交（harrylabsj 667、dependabot 8、haidong 1），1212 个文件变更、+271,235/−13,545 行；其中大量为 release 锁文件 / checkpoint / 构建产物，真实 src+tests 变更 1,153 个文件、约 +259,499/−8,930 行。
- **方法**：按 4 个功能流域并行深度审查，每个流域先对照既有两份报告去重，只报告新发现：
  1. 48h 报告修复落地核验（P0×2、P1×7 逐条；P2 抽查 18 项）+ 修复代码本身（`f7e84df6..20e73efa`，含 fe9e290a、20e73efa）；
  2. 独立 workbench / admin-passwd / 商品导入 / 分层套餐 / 凭据轮换 / 商家治理；
  3. workbuddy 技能 / 发送渠道适配器 / 供应链与发布脚本 / dependabot / 经营投影；
  4. buyer-core / cloud / a2a（买家身份·报价历史·回执、缓存锁恢复、全球搜索、报价单位）。
- **复核纪律**：全部 P0/P1 与关键 P2 由主审逐条重读当前 HEAD 源码确认后才列入；行号均为 HEAD 实际行号。
- **静态门禁**：`tsc --noEmit` ✅ 通过；`eslint` ✅ 通过。

## 当前结论

| 状态 | 数量 | 说明 |
|---|---:|---|
| 旧 48h 报告 P0×2、P1×7 | 全部已修复 | 修复质量高，测试同步改写为新流程正/负例；无 P0/P1 级回归 |
| 旧 48h 报告 P2 抽查 18 项 | 14 修复 / 3 部分修复 / 1 未修 | 未修项：learning 账本保留策略（见 P2-20） |
| **新发现 P1** | **2** | 导入提交丢更新；平台漂移门未进 CI |
| **新发现 P2** | **20** | 集中在 UNKNOWN 恢复运营面、quote-history 授权账本、客户身份层残余缺口、SMTP 边界 |

30 天内风险最集中的三处：①**导入提交不复验基线**（商家两步操作即可静默丢失整批商品，两次均返回成功）；②**平台漂移门不在任何 CI 执行**（版本不变内容漂移的防线实际不运行）；③**UNKNOWN 投递恢复依赖运营者无审计自证**（误证即对客户重复发送且无痕迹）。

---

## P1（2 项）

### P1-1 导入提交不复验商品表基线，后提交的草稿把先提交的导入静默回滚（丢失更新）

- **位置**：`src/http/merchant-management/api.ts:4426`（提交落盘）vs `api.ts:4230-4261`（合并只发生在草稿创建时）；对照 `src/merchant/file-listing-publication.ts` 约 L476-479（发布内核有同款守卫）。
- **证据**：`postProductsImportDraft` 在创建草稿时对**当时**的商品表按 SKU 合并（`base = importChannel.currentTable()`，L4230；`mergedProducts`，L4261），并把**合并后的整表**冻结进 `payload_json`。而 `postProductsImportCommit`（L4345）只校验 `expected_draft_digest === draft.payload_digest`（L4367，草稿自身摘要，防的是草稿内容被改）后直接 `importChannel.commit(table)`（L4426）写盘——**不再读 currentTable、不比对 base_digest**。发布内核 `file-listing-publication.ts` 的 commit 明确复验 `snapshot.digest !== draft.products_digest → PRODUCTS_CHANGED`，导入提交缺同款守卫。
- **失败场景**：
  1. 商家先后导入两个文件生成草稿 1、2（base 均为 V1），提交草稿 1（表变 V1+A）后再提交草稿 2 → 写入的是草稿创建时算出的 V1+B，**A 的整批 SKU 静默消失**，两次都返回 200 `succeeded`；
  2. 草稿创建后发生 `bindProductTableToCatalog`（给表盖 merchant_id 章）或 shopping-cli 同步改表，随后提交旧草稿把该变更一并回滚。
  与 8b6d0403（"merge product imports by SKU"）宣称的"文件外商品保留"语义直接冲突——保留只对草稿创建时刻的 base 成立。
- **修复建议**：commit 路径在 `importChannel.commit(table)` 前重新 `currentTable()` 并与草稿的 base_digest（空表为 `""`）比对，不一致返回 409 `precondition_changed` 要求重新预览（照抄 publication 的 `PRODUCTS_CHANGED` 处理）。

### P1-2 平台漂移门自身未被任何 CI/发布流程执行，"在 CI 前暴露"的承诺实际不成立

- **位置**：`scripts/verify-workbuddy-platform-drift.mjs:5-7`（docstring："版本号不变但内容漂移会在 CI 前暴露"）；`.github/workflows/ci.yml:91-100`；`package.json:49-53`。
- **证据**：`verify:workbuddy`、`verify:workbuddy-platform`、`verify:workbuddy-assets` 只出现在本地聚合脚本 `verify`/`verify:development` 中；ci.yml 只跑 contracts/vectors/buyer-skills/portfolio-products/supply-chain/audit-expiry/package——而 ci.yml:95 注释明确宣称 "Keep PR CI aligned with the `verify` contract"，workbuddy 三项恰好掉队。release-rehearsal.yml、supply-chain-rehearsal.yml、portfolio-release.yml（后者打包 workbuddy 专家与 app config）均未调用漂移门。vitest 侧 `tests/workbuddy-export-diff.test.ts` 只测 diff 工具逻辑（fixture），不对提交的基线快照跑真实比对。
- **失败场景**：开发者改 `platform/build-platform-pack.mjs` 生成器或直接改 `platform/out/*`、app config，版本仍 1.8.2 → PR CI 全绿 → 平台包（platform-pack.zip / market.json / industry-config.json）与平台导出基线漂移并发布——正是 c255a850/751cf21d 要防的"版本不变内容漂移"。
- **修复建议**：把三项 `verify:workbuddy*` 加入 ci.yml（漂移门为离线脚本，成本与 `verify:buyer-skills` 同级），与注释宣称的 verify 契约对齐。

---

## P2（20 项）

### 主题一：投递 UNKNOWN 恢复运营面（fe9e290a / 20e73efa 修复引入的新状态）

### P2-1 retryUnknownDelivery 完全依赖运营者自证，无审计、无渠道幂等校验

- **位置**：`src/http/merchant-management/api.ts:1393-1421`；`src/merchant-core/customer-delivery/repository.ts:232-244`。
- **证据**：retry 路由要求 body 声明 `verified_not_executed/channel_idempotent === true`（L1403-1408），随后把字面量 `true` 传给 `retryUnknownDelivery`——无任何实际核对，也不写审计事件（appendEvent 类机制未用）；SMTP 天然不支持同 ID 幂等，运营者勾选即重发。
- **失败场景**：SMTP DATA 250 后租约丢失 → `recoverExpiredClaims` 转 UNKNOWN → 运营者误证"未执行"→ 同 `delivery_id` 重发 → 客户收到重复邮件且无审计痕迹可追。
- **修复建议**：路由落 `who/attestation` 审计事件；按 channel 校验幂等能力（email 恒 false 时拒绝或要求二次确认）。

### P2-2 dispatchDelivery 提前 enter 流门，claim 失败不 leave

- **位置**：`src/merchant-core/customer-delivery/channel.ts:84-89,102-104,142-144`。（两个流域独立发现，交叉确认）
- **证据**：`stream_gate.enter` 在 `write(claim)` 之前；claim 抛 `lease_busy/backoff/stream_busy` 时异常直接传播，`leave`（L142-144）只在结算后且 `settled.status !== "UNKNOWN"` 时到达。
- **失败场景**：同 stream 记录在退避期被反复 tick，gate 以本 worker 为 holder 占满 `lease_ms`（默认 120s），期间同流其他合法发送被 enter 拒绝而 skip；自愈但造成渠道内部抖动。
- **修复建议**：claim 失败路径补 `leave`（try/catch 或先 claim 后 enter）。

### P2-3 delivery loop 未传 stream_gate，与 reply-outbox 的"共用互斥"未实际生效（部分修复）

- **位置**：`src/merchant-core/customer-delivery/gate.ts:223`（stream_key 已去掉 purpose 对齐命名）；delivery loop 装配处（`dispatcher-loop.ts`）未传 `stream_gate`。
- **证据**：M6-5 的目标是接待回复 outbox 与投递循环共用 StreamGate；命名空间已对齐，但 delivery loop 装配不传 gate，两侧仍结构性不相交。
- **失败场景**：同一底层渠道（如 SMTP 连接/频控）在 reply-outbox 与 delivery loop 同时发送时无互斥，M6-5 的设计承诺落空。
- **修复建议**：delivery loop 装配传入与 reply-outbox 相同的 gate 实例。

### P2-4 UNKNOWN 无自动对账作业（部分修复）

- **位置**：`src/http/merchant-management/api.ts:684-691,1393-1421`（运营核对路由已接）。
- **证据**：崩溃积压的 UNKNOWN 记录仍全靠人工发现；无启动扫描/定时对账作业提示运营者待核对数量。
- **失败场景**：无人盯管理台时 UNKNOWN 记录无限期滞留，客户通知静默丢失。
- **修复建议**：启动与周期性作业输出 UNKNOWN 待核对计数（或告警）。

### 主题二：quote-history 授权账本一致性（ed8cc50a / 20e73efa 引入）

### P2-5 撤销/换版不撤销底层 data_grant，授权账本残留 ACTIVE 行

- **位置**：`src/merchant-core/customer-memory/quote-history.ts:210-216,267-276`。
- **证据**：`revokeDelegation` 只把 `quote_history_delegations.status` 置 REVOKED，对应 `history_recall` grant 保留 ACTIVE 至 `expires_at`；每次版本递增 `createGrant` 新行，旧 grant 不撤销。
- **失败场景**：撤销后旧 grant 在 `data_grants` 中仍 ACTIVE；当前读面（checkActive 复核 delegation 状态）不可达，但任何未来按 grant 直读的路径会把"已撤销委托"当有效授权；且 grant 行无界累积。
- **修复建议**：revoke/换版时同步撤销旧 grant（`DataUseGrantStore` 已有撤销机制）。

### P2-6 委托有效期无上限

- **位置**：`src/merchant-core/customer-memory/quote-history.ts:130-135`。
- **证据**：`validateDelegationShape` 只校验 `expires_at > now` 且 `issued_at <= expires_at`；对比 `grants.ts:45` 的 90 天上限，K2 委托可声明任意远期。买家侧默认 90 天（`a2a-quote-history.ts` `buildDelegationMetadata`），但形状校验不设上限。
- **失败场景**：买方一次声明 10 年委托，商家按 `delegation.expires_at` 建 grant，与全库 90 天保留/授权姿势不一致。
- **修复建议**：加 TTL 上限（如 90 天），与 `MAX_GRANT_TTL_SECONDS` 对齐。

### P2-7 applyDelegation 同版本幂等重入返回入参 subject_id 而非存储值

- **位置**：`src/merchant-core/customer-memory/quote-history.ts:186-198`。
- **证据**：`existing.status === "ACTIVE"` 分支返回 `subject_id: subjectId`（入参）。当前调用方 subject_id 由服务端 `ensureVerifiedCustomerIdentity` 派生（merchant-handler.ts:665-686），入参=存储值，无实际错配；但契约上同版本不同 subject 的请求被静默接受并返回新 subject。
- **失败场景**：未来任何调用方信任返回值即产生跨主体误读。
- **修复建议**：同版本重入时比较并拒绝/返回存储 subject_id。

### P2-8 published_offers（报价快照）不在删除清算与保留期范围

- **位置**：`src/merchant-core/customer-memory/memory.ts:471-479`（删除按 `customer_memories ∪ history_index` 解析主体）；`src/merchant-core/migrations/ledgers.ts` CUSTOMER_MEMORY_V4（`published_offers` 无 purge 列）；`maintenance.ts`（`expireDue` 不覆盖）。
- **证据**：`quote-history:<subject>` scope 封存后 `checkActive` 拒读，但 `published_offers` 行（含 spec/价格/有效期快照）永久留存且 `expireDue` 不清理。
- **失败场景**：客户请求删除后，其报价历史快照仍静止留存于库中（查询不可达但未删除），与 90 天保留承诺不一致。
- **修复建议**：纳入删除清算与保留期 sweep。

### 主题三：客户身份层残余缺口（48h P0 修复后的次要面）

### P2-9 确认类接口在验证秘密前先泄露签发/绑定状态差分

- **位置**：`src/merchant-core/customer-memory/grants.ts:247-289`；`identity.ts:206-230`。
- **证据**：`confirmGrant`/`linkConfirm` 检查顺序为 存在→已消费→过期→签发者→绑定→短语/proof；错误码可区分"请求不存在/签发者是你/主体未绑定/秘密错误"。
- **失败场景**：持 `customer:self` 的会话可探测 grant_request/challenge 的存在性与签发者关系（不含敏感数据，弱 oracle）。
- **修复建议**：统一先验秘密再验绑定（过期顺序无碍）。

### P2-10 revokeBinding / listBindings 无归属校验（潜伏）

- **位置**：`src/merchant-core/customer-memory/identity.ts:279-315,338-352`。
- **证据**：`customer:self` actor 可撤销商家内任意 `binding_id` 的绑定（只验 merchant+epoch）；`listBindings` 同样无 actor 过滤。当前 src 无生产调用面（grep 仅定义），但与 48h P0 修复精神不一致。
- **失败场景**：未来把该面接到客户工具/API 即成为跨客户撤销原语。
- **修复建议**：`customer:self` 时校验 `binding.actor_id === actor.actor_id`。

### P2-11 linkConfirm 不校验 source_session_id 一致性

- **位置**：`src/merchant-core/customer-memory/identity.ts:180-276`。
- **证据**：输入 `source_session_id` 只参与 proof_ref 摘要，未与挑战记录的值比对——审计字段可写入任意会话号（不影响绑定安全性，绑定以 actor 为准）。
- **修复建议**：比对一致或从记录回填。

### 主题四：workbench / 管理面

### P2-12 admin-passwd 重置口令不撤销既有管理会话

- **位置**：`src/cli.ts:2200-2216`（cmdMerchantAdminPasswd 只调 `writeAdminCredentials`，L2214）；`src/auth/merchant-sessions.ts:88-107`（无会话清理）；会话 TTL 12h（`merchant-sessions.ts:45`）。
- **证据**：`writeAdminCredentials` 只写 admin-credentials.json；`MerchantAdminSessions` 仅提供单会话 `revoke`（logout），口令重置路径没有任何会话吊销。CSRF token 可由会话派生（页面加载即得）。
- **失败场景**：管理员怀疑会话泄漏（cookie 被复制/前操作员离职）后重置口令，攻击者持旧 cookie 仍可继续调用全部 `/merchant/api/*` 管理写直至 12h 过期。48h 报告核验过 admin-passwd 但未覆盖此点。
- **修复建议**：`--force` 重置时遍历 revoke 该 merchant 的全部 ACTIVE 会话（或把 credentials `created_at` 晚于会话 `created_at` 的会话判废）。

### P2-13 draft-store markCommitted 的 DELETE 可删掉并发提交刚写入的 committed 行

- **位置**：`src/http/merchant-management/draft-store.ts:153-175`。
- **证据**：`SELECT ... WHERE status='draft'` 在事务外（L153），随后 `BEGIN IMMEDIATE` 里**无条件** `DELETE ... AND status='committed'`（L162）再 UPDATE 自己。两个进程同时提交同一草稿：赢家先 draft→committed，败者的 DELETE 恰好匹配并删除赢家行，其 UPDATE 改 0 行返回 false。
- **失败场景**：需两个管理写进程共享 state.sqlite（设计上单写者准入使其实际不可达），故为防御性缺陷；一旦发生，草稿账本该 digest 的行整条消失。
- **修复建议**：SELECT 挪进 `BEGIN IMMEDIATE`；DELETE 限定 `draft_id != ?` 或改为先 UPDATE 后清理冲突行。

### P2-14 发布卡片文案与常驻上架状态矛盾

- **位置**：`src/http/merchant-management/page.ts:855`（用户可见文案）；对照 `page.ts:646-650`（`productStatusLabel`：expired → "上架"）与 L1071 新文案。
- **证据**：03ddea13 把 `productStatusLabel` 改为 `expired → 上架`（有效期不再改变上架状态，与测试一致），但发布卡片 muted 文案残留旧句："上架/下架与有效期在目录商家后台设置；**「过期」统一显示为「已下架」**。"，L646 注释同样过时。
- **失败场景**：商家看到过期商品显示"上架"而页面文案宣称应显示"已下架"，对上下架状态与"长期有效"承诺产生误判；过时注释会误导后续维护者改回旧行为。
- **修复建议**：改写 L855（例如"数据有效期只影响自动报价；上下架以目录商家后台为准"），同步修正 L646 注释。

### 主题五：发送渠道适配器

### P2-15 SMTP DATA 体裸 CR 未规范化 + 信封/头无字符集校验

- **位置**：`src/merchant-core/customer-delivery/smtp-adapter.ts:86-92`（escapeData）、`:152-154,164-170`。
- **证据**：`escapeData` 只把 `/\r?\n/` 归一为 `\r\n`，裸 `\r`（CR 后无 LF）原样保留；随后仅按 `\r\n` 分行做点填充——裸 `\r.` 在把孤立 CR 当行结束的服务器上被解读为新行首 `.`，提前结束 DATA 并把余文当 SMTP 命令执行。对照 Subject 有 `[\r\n]→空格` 清洗（L165），而 `MAIL FROM:<…>`/`RCPT TO:<…>`/`To:`/`From:` 完全无 CRLF/字符集校验（当前防线只有"from/to 均来自操作员 env"）。Resend 路径经 JSON 无此面。
- **失败场景**：payload.body（可含客户名等嵌入文本）出现 `\r` → 宽容 SMTP 服务器上 DATA 提前终止/命令走私（追加 RCPT/发新邮件）；前提是操作员 env 自身含 CRLF 或 body 含裸 CR。
- **修复建议**：`escapeData` 增加裸 CR 清洗（`.replace(/\r(?!\n)/g, "\r\n")`）；对 from/to 断言拒绝 `[\r\n]`（入口 fail-closed）。

### P2-16 Resend 429/暂态 5xx 归 not_sent，叠加退避后窗口内静默弃发

- **位置**：`src/merchant-core/customer-delivery/email-adapter.ts:84-86`；`channel.ts:33-40,126-133`。
- **证据**：旧报告"毒消息每 15s 重试整个窗口"已由 `MAX_NOT_SENT_ATTEMPTS=5` + 指数退避修复；但分类未改：422 坏地址与 429/暂态 5xx 同走 `http_${status}` → not_sent。5 次退避总跨度约 10 分钟后 `next_attempt_at = valid_until`，窗口内不再重试。
- **失败场景**：Resend 账户级限速或突发 5 分钟限流时，正在退避的合法通知被计满 5 次 attempts 后在 valid_until 内永久放弃——可证明未发送（无重复），但属本可通过等待恢复的丢失。
- **修复建议**：按状态分类——429（及带 Retry-After 的 5xx）归 `unknown` 或引入独立可恢复态；仅 400/403/422/413 等确定性拒绝保持 not_sent。

### 主题六：buyer-core / 供应链 / 遗留

### P2-17 商家 decline 的 reason_code 无长度与字符限制

- **位置**：`src/buyer-core/protocol-recovery.ts:83`；流入 `src/buyer-core/a2a-quote-fetcher.ts:580`。
- **证据**：`structuredDecline` 中文本消息已做控制字符清洗 + 300 字截断（L86-91），而 `reason_code` 仅 `trim()`，未限长即拼入 `merchant_declined:<code>`（L580）落入失败详情/McpError details/任务 payload/日志。
- **失败场景**：恶意/被攻陷的商家端点返回超大 reason_code，膨胀买家任务 payload 与日志。
- **修复建议**：限长（如 64 字符）+ 字符集白名单，与文本消息同标准清洗。

### P2-18 buyer-skill 一致性守卫承诺"未登记副本直接失败"，实现无任何副本扫描

- **位置**：`scripts/verify-buyer-skill-consistency.mjs:12-13`（承诺 3）对照 `:133-202`。
- **证据**：全脚本只对 `DUAL_SOURCE_FILES`/`BOUNDARY_FILES`/`PENDING_FILES`/`SEQUENTIAL_ORDER_FILES`/`REFERENCE_ENTRY_FILES` 五张固定清单做 existsSync+token 断言，无 readdirSync/glob；新增一份含双来源语义的 SKILL.md 副本且不登记时，守卫静默通过。
- **失败场景**：新宿主包复制买家规则后改坏来源分区/价格类型词表，守卫与 CI 都放行——恰好复现该脚本要防的"静默分叉"，头注释让维护者误以为有兜底。
- **修复建议**：对 `skills/**/SKILL.md` 与 `integrations/**/SKILL.md` 扫描含 `kiwi_search`/`network_search` 的文件并要求全部登记；或删掉头注释第 3 条改为如实描述。

### P2-19 KIWI_SHIPPING_HOST_ROOT 可把主机预算核算指向任意目录，预算门形同虚设

- **位置**：`scripts/verify-npm-shipping-installed.mjs:29-34`；`scripts/build-npm-shipping.mjs:103-110`。
- **证据**：`hostRoot = process.env.KIWI_SHIPPING_HOST_ROOT ?? root`，`budget()` 对 hostRoot 求和后与 MAX_HOST（3 GiB）比较；实际安装/构建产物写在 `root/build/...`。该变量全仓无文档、无测试、未进契约文件。
- **失败场景**：设 `KIWI_SHIPPING_HOST_ROOT=/tmp/empty` 即令预算恒为 0 通过，冻结契约里的 3 GiB 主机预算可被静默突破，与"发布门禁不可静默放宽"的自订原则相悖。
- **修复建议**：删除该覆盖，或要求 hostRoot 必须包含 root（realpath 祖先校验）并在 receipt 记录实际 hostRoot 与字节数。

### P2-20 learning 账本仍无保留/prune 策略（旧 48h 报告遗留，未修复）

- **位置**：`src/merchant-core/learning/repository.ts`（grep 无任何 prune 查询）；`releaseEvaluationClaim` 仍永久保留 claim 行。
- **失败场景**：评测账本与 claim 行无界增长，拖慢查询与备份。
- **修复建议**：按 `MAX_GRANT_TTL_SECONDS` 同级的保留窗口增加 prune 作业（可挂进既有 maintenance 调度）。

---

## 旧 48h 报告修复核验（主审逐条复核关键项）

### P0/P1 逐条核验（9/9 已修复）

| 编号 | 结论 | 关键证据（HEAD） |
|---|---|---|
| P0-1 客户自助自发自验数据授权 | 已修复 | `grants.ts:144` 签发改 `memory:write`；`:259-265` 拒签发者/NULL-签发（`issuer_cannot_confirm`）；`:266-273` 强制主体绑定（`subject_not_bound`）；`history.ts:190-201` search 增加绑定硬校验；迁移 v5 补 `issuer_actor_id`（旧行 NULL 不可确认）；原跨主体 fixture 已改为负例 |
| P0-2 绑定挑战自发自验 | 已修复 | `identity.ts:139` `linkChallenge` 改 `memory:write`；`:217-223` 签发者/NULL 拒绝；`:228-249` proof 校验后 `MAX(binding_epoch)+1` 建绑定；`assertActorOwnsSubject` fail-closed |
| P1-1 requestDeletion 漏绑定 | 已修复 | `memory.ts:468-489`：事务内解析 scope 涉及主体集合逐一 `assertActorOwnsSubject`；空 scope 且仅 `customer:self` 拒绝 |
| P1-2 claimDelivery 无租约前置 | 已修复 | `dispatcher.ts:109-111` `lease_busy`；claim+authorize 同一 IMMEDIATE 事务（`channel.ts:100-103`）；loop 重入互斥；测试固化双领取负例。附带语义变化：崩溃租约转 UNKNOWN 需运营核对（引出 P2-1/4） |
| P1-3 SMTP 无 deadline | 已修复 | `smtp-adapter.ts:47-116` 每命令/连接/STARTTLS deadline，超时 destroy+reject，归 `unknown` |
| P1-4 只在 prepare 检查授权 | 已修复 | claim 事务内 `authorize` 复核 binding/subscription/epoch/退订/过期/`max_per_day`（`workbench-server.ts:318-359`、`gate.ts:138-196`、`repository.ts:262-272`） |
| P1-5 收件人不消费 address_ref | 已修复 | 删除固定 `KIWI_DELIVERY_EMAIL_TO`；改 `KIWI_DELIVERY_RECIPIENTS` 映射，未解析即 `recipient_unresolved`，适配器不得回退固定地址（入契约 `channel.ts:53-54`） |
| P1-6 uncertain 评测永久卡死 | 已修复（结构性） | marker 带 15 分钟 TTL；过期取本地回执或清 marker 重派（`learning/repository.ts:305-334`）；回执等值校验后经 recoveryWriteGuard 落地不双计数。默认部署可自动恢复 |
| P1-7 保留期清算是死代码 | 已修复 | 新增 `maintenance.ts:53-63` 接进 `workbench-server.ts:252-265` 与 `bootstrap.ts:826-839,1644` |

### P2 抽查结果（18 项：14 修复 / 3 部分 / 1 未修）

| # | 原报告项 | 状态 | 证据 |
|---|---|---|---|
| 1 | scheduler 错误串清洗 + retryTask 独立 try | 已修复 | `operations-jobs/scheduler.ts:251-283` |
| 2 | saveReceipt 位于 try 外 | 已修复 | `learning/evaluation.ts:582-588` |
| 3 | bootstrap 少传 recoveryWriteGuard | 已修复 | `bootstrap.ts:822-825` |
| 4 | managementDb 无 PRAGMA | 已修复 | `bootstrap.ts:789-792`；`workbench-server.ts:212-213` |
| 5 | 迁移并发竞态 | 已修复 | `ops/schema.ts:572-584`（BEGIN IMMEDIATE 内复读 MAX(version)） |
| 6 | revise 搁浅 marker | 已修复 | `learning/service.ts:892-902` |
| 7 | weixin catch-all 归 UNKNOWN | 已修复 | `weixin-adapter.ts:41-50,73-79` |
| 8 | candidate_refs 未校验 | 部分修复 | `agent-runtime.ts:419-431`（去重/限长/去控制字符；未按引擎真实候选核验） |
| 9 | epoch UPDATE 不查 changes | 已修复 | `consent-repository.ts:158-166,256-270` |
| 10 | 直写 scope 错配 + allowWrites 默认 true | 已修复 | `reception-provider.ts:56-57,278-280` |
| 11 | 非 loopback 无 public-url 全 403 | 已修复 | `workbench-server.ts:70-74` |
| 12 | SMTP 随机 Message-ID | 已修复 | `smtp-adapter.ts:160-161`；迁移 v6 补列 |
| 13 | not_sent 绕租约 + 无退避 | 已修复 | `dispatcher.ts:135-159`；`channel.ts:33-40,125-133` |
| 14 | 两侧 stream_key 不相交 | 部分修复 | `gate.ts:223` 已对齐；loop 未传 gate（见 P2-3） |
| 15 | unknown 占用重启绕过 | 已修复 | `reply-outbox.ts:75-92,122-129` |
| 16 | learning 账本无保留策略 | **未修复** | 见 P2-20 |
| 17 | confirmGrant 可对 SEALED scope 建 grant | 已修复 | `grants.ts:113-122`；`memory.ts:202-208` |
| 18 | UNKNOWN 依赖不存在的基础设施 | 部分修复 | 路由已接；仍无自动对账（见 P2-4），且 P2-1（自证无审计） |

**修复引入的可用性语义变化**：崩溃/过期租约不再回 PENDING，统一转 UNKNOWN 由运营核对收敛——安全（fail-closed）但牺牲自动恢复，配套缺口即 P2-1/2/4。

---

## buyer-core / cloud / a2a 流域核验结论（主审亲审）

**已核验无问题**：

1. **买家缓存锁恢复（2551ca3b）**：`buyer-cache-store-draft.mjs` 以 symlink 指针 + 独立 SQLite 数据文件 `BEGIN IMMEDIATE` 互斥；全路径 `O_NOFOLLOW`/0700/nlink 校验；进程死亡后 OS 锁随之消失、BEGIN IMMEDIATE 成功即恢复，陈旧 marker symlink 被识别重建；损坏/篡改指针 fail-closed（`CACHE_LOCK_INVALID`/`PREPARE_TIMEOUT`）。`cache-os-lock.test.mjs` 覆盖恢复序列。
2. **报价历史复用（K2/K3）**：买家只把 `hit.sku` 注入 intent（`service.ts:832` `withHistorySku`）；价格/数量/单位仅进 `reusedHistory` 参考展示并附"以正式报价为准"注记；多候选强制澄清（`history_ambiguous`）；intent 显式含 SKU 时禁用复用；之后仍过 `validateCommerceIntent`。商家侧委托确认走 48h P0-1 修复后的两方流程。
3. **交易回执 outbox（K5/K6/K7）**：`ReceiptDispatcher` 重入互斥（`draining`+`drainRequested`）+ event_id 幂等重投 + 失败退避保留 PENDING，回执故障不阻塞本地事务。
4. **piece 单位识别（4b029734）**：封闭一对一别名集（box/盒、piece/个/件），无跨单位换算；商家 decline 详情经 `redactShareParameter` + 文本消息控制字符清洗 + 300 字截断（reason_code 缺口见 P2-17）。
5. **平台规则缓存失败跟踪（366ef681）**：`lastAttemptFailed` 显式标志替代"时间戳相等推断"，修掉同毫秒碰撞误用成功 TTL；有回归测试；"非空输入全非法"归 undefined 不误判停用（`trade-platforms-client.ts:36-39`）。
6. **bootstrap 错误路径**：各 catch 均 fail-closed——显式错误码（`PRODUCTS_UNAVAILABLE` 等）、外部副作用边界抛错持久化 UNKNOWN 不重投、预留超限 429 结构化响应；无吞错。
7. **买家会话/任务所有权**：tasks/approvals/idempotency 全部按 `owner_hash` 隔离（唯一索引 `idx_mcp_tasks_idem(owner_hash, idempotency_key)`）；legacy adoption 已禁用（`store.ts:433`）；跨会话 idempotency 泄漏修复簇（67379076→893ffbd8）成立。
8. **全球 Kiwi Network 搜索（3b103fc2）**：汇总 fail-closed（全部组件 `completed` 才允许 `no_match`；`not_searched` 不与"无商家"混同）；全球化只是路由默认值变化，无信任边界变化。
9. **谈判槽位原子预留（48029190）**：预留表 `BEGIN IMMEDIATE` 先于外部发送、60s 过期，并发 counter_offer 不再双占轮次。

## 已核验无问题（其余流域要点）

- **认证/会话/CSRF（workbench 复用面）**：HMAC CSRF timing-safe + Origin 精确匹配；`allowedOrigins` 以活引用传入、listen 后 push 实际端口有效；trusted-page CSP nonce + 顶层窗口强制；inline 脚本不反射 search 参数。
- **单写者准入与逐次所有权核验**：`writeGoverned` 逐写包裹（/learning/*、/automation/*），三处装配均传 `writeUnderOwnership`；ops 面经 facade `recoveryWriteGuard`；dispatcher claim/结算包 `write` 且每 tick `assertOwner`；identity receiver fail-closed（token ≥32 字节 timing-safe + assertOwner）。
- **workbench 双连接**：两连接均 WAL + busy_timeout=5000；bcd335aa 已把 ops facade 收回 assembly 连接，消除跨连接栅栏分裂。
- **路径/文件写入安全**：draft_id 严格正则防遍历 + 0700/0600 + lstat 拒软链 + 同目录 tmp+rename 原子写 + JCS 摘要重算比对；products 表 commit 同纪律。
- **凭据轮换（20e73efa）**：`endRuntimeSwitch` finally 清理；sidecar 先持久化后 stop/write、confirm 按 rotation_id 幂等可重放；磁盘已是 replacement 时先验新 token 身份再分别探测；锁文件 `wx` 原子创建 + lock_id 归属 + pid 存活探测；0700/0600、lstat 拒软链、token 禁 CR/LF/NUL、HTTPS/loopback 强制。测试钉住 recover/幂等/锁序列化。
- **页面双重转义（7dde9dcc）**：唯一 HTML 拼接点 `esc(accessSyncText(...))` 包裹，其余 textContent；测试固化两侧行为。**kiwi-tool EPIPE**：唯一副本已带 stdin error 兜底，exit 收敛为 `KIWI_RUNTIME_STOPPED`。
- **双源搜索（b18a0437）**：顺序为提示词语义，由守卫 marker + SEQUENTIAL_ORDER_FILES 固化；代码侧聚合 fail-closed。
- **发送适配器密钥面**：Resend Bearer 仅入 header、错误体不落日志；SMTP 凭据不出现在任何 reason/日志；STARTTLS 默认开启且 rejectUnauthorized；weixin BotCredentials 0600 原子写、日志不含 token/context_token。
- **供应链脚本**：assertSource 契约逐字一致 + 逐文件哈希 + grafts 拒绝；portfolio.lock 外仓 pin git blob 级校验、assume-unchanged/脏树/软链逃逸全拒；云包 deployment-lock 强制 SRI + 实包逐文件 SRI；audit 豁免 fail-closed 带到期日。
- **dependabot 8 提交**：7 个 minor/patch 无行为面变化；唯一 major（vitest 4.1.11→5.1.0）经实测关键四套件 47 测试全绿。
- **经营投影/调度（e5354d0b/e610b3bc）**：projection 只读、缺表/失败一律 `data_incomplete` 不伪造 no_change；prefilter 在所有权栅栏内执行。
- **分层套餐（7874d94d）**：仅展示层 `plan_label`，schema 兼容旧 Catalog，本库无缺陷。
- **URL 导入与导入合并本体**：强制 https/无 userinfo/域名后缀匹配/ID 白名单/目录链接模板再生成；同 SKU 更新/文件外保留/重复 SKU 整批拒绝按设计成立（时序缺口见 P1-1）。

## 运营提示（非缺陷）

1. `verify:audit-expiry` 现存豁免条目 **2026-11-27 到期**（8 天后发布门会拦），请按流程续审。
2. 本地 HEAD（20e73efa）落后 origin/main 4 个提交（`0807463e` merchant-cloud prepare devOptional 修复、`7b5bcc7d` eslint-plugin bump 及两次契约重冻结）。
3. 提交粒度：30 天 676 个提交中含大量 release/checkpoint 重冻结提交，建议发布流水线产物与 src 变更进一步分离，降低审查与回滚成本。

## 修复优先级建议

1. **P1-1**（导入丢数据，商家两步即可触发，真实数据破坏）；
2. **P1-2**（三行 CI 改动即可闭合，否则漂移防线形同虚设）；
3. **P2-1 / P2-12 / P2-16**（UNKNOWN 审计、口令重置吊销会话、Resend 限速弃发——生产可用性与安全审计收益最大）；
4. 其余 P2 按主题批次处理（quote-history 账本一致性可合并为一个 PR）。
