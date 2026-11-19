# 买家识别与交易回执升级 · 实施笔记（Kiwi `upgrade/buyer-identity-receipts`）

依据《Kiwi-买家识别与交易回执-最小改造设计》与《开发任务》。基线 `a0dd7993`。

## 关键代码事实（探索结论）

- 验签身份：`OpenInquiryVerifier`（src/a2a/open-inquiry-verifier.ts）对 `/a2a` POST 的 open-inquiry 签名验签成功后返回
  `{authenticated:true, identity: sessionIdentity(keyid), identityVerified:true, trustLevel:"T0"}`。
  `isOpenInquiryIdentity(identity)`（open-inquiry-identity.ts）判定 keyid 前缀 `kiwi-inquiry-session-v1:`。
- pipeline（server/pipeline.ts）：`InboundNegotiationContext.identityVerified = caller.identityVerified === true`；
  message metadata 由 `parseInboundMessage` 保留（inbound-message.ts:87）；KNP envelope 顶层未知键拒绝
  （domain/envelope.ts:131），`inquiry.subject` 是开放 Record（domain/objects.ts:82）→ 查询扩展放 subject 内。
- merchant-handler（server/merchant-handler.ts）：
  - rfq 分支 L1383+：schema 校验 → floor/product/unit/promotion 校验 → `seedEnvelope` 生成 offer →
    `advancePhase({type:"offer"})` → `conditionalByNegotiation.set` → `appendSent(reply, snapshot)`。
  - inquiry 分支 L1233+：structured sku/topics → reception engine → `textReply`。
  - accept 分支 L1935+：校验 → `advancePhase({type:"accept_nonbinding"})` → `buildAgreement`（`agr_<uuidv7>`）
    → 清理 → 返回 artifactParts。**协议对象目前不持久化**（只有 state_transition 事件）。
  - `appendSent` L884：`message_sent` 事件含完整 envelope + `outcome.result.merchant_quote_source={offer_id,snapshot}`。
  - handle() 顶部：peer binding → syncPhaseFromLedger → 终态守卫（商业动作一律 state_conflict）。
  - ledger 是每 negotiation 一个 JSONL 链文件（negotiation/ledger/store.ts），append 原子；事件 kind 含 `system`；
    `outcome:{kind:"ok",result:Record}`；禁词扫描禁 key 含 "credential" 精确匹配 → 命名用 `buyer_binding`。
- 客户记忆（merchant-core/customer-memory）：`customer_subjects`（PK subject_id）、`subject_bindings`
  （actor 索引**非唯一**）、`data_grants`（purpose CHECK: customer_memory|history_recall|experience_learning|notification，
  `uq_data_grants_epoch`）。迁移机制：`ModuleLedgerSpec` 版本必须从 1 连续、checksum 校验，加表 = 新增版本 4。
  `CustomerIdentityService.currentSubjectForActor`（identity.ts:303）= 接待 `contextFor` 的绑定来源。
- 接待（a2a/reception）：engine `respond` 空文本/非中文 → ask_clarification；`ReceptionEngineResult` 无
  recognizedInquiry 字段（K1 需新增）；responder.ts 传 `identityVerified` 已有；A2A 节点装配时
  `SqliteCustomerMemoryProvider(allowWrites:false)`（单写者，写权在 workbench/governance）。
- 买方（buyer-core）：`envelopeToMessage`（a2a-knp.ts:195）不设 metadata（K2 挂点）；`A2AClient.sendMessage`
  返回 A2ATask；`TaskApprovalStore`（store.ts，SQLite mcp_* 表）承载 task/approval/agreement/handoff；
  `acceptAgreement`（service.ts:1174）校验 merchant_agreement 后写 `mcp_agreements`；
  `handoff`（service.ts:1503）生成 `handoff-<uuidv7>`；`BuyerProtocolRecovery` 是持久幂等发送模式。
- workbench 单写者：`instance_ownership` CAS 租约 + fencing；A2A 进程不持所有权（管理写在 workbench）。
- kiwi-catalog：双栈共享 `_ROUTE_TABLE`（route_table.py）+ `register_fastapi_routes`（每条路由必须两处登记，
  parity 靠测试）；auth.py 有 merchant token（`merchant_tokens` 表）与 admin token；a2a/request_signature.py 有
  Ed25519 JWS 验签（EdDSA、±300s、nonce 去重 control_plane_nonnes）+ `jwk_thumbprint`；DB 迁移 = models.py
  SCHEMA + migrations.py 新版本（当前 56）双写一致（test_shadow_tables 守卫）。

## 方案落点

### K1 本店身份建档
- 新迁移 customer-memory v4：`verified_customer_identities(merchant_id, verified_actor, subject_id,
  binding_epoch, created_at, updated_at, PRIMARY KEY(merchant_id, verified_actor))`。
- 新模块 `merchant-core/customer-memory/auto-identity.ts`：
  `ensureVerifiedCustomerIdentity(db,{merchant_id,verified_actor,now})` 单事务幂等 find-or-create：
  查映射 → 有：返回 subject，绑定 ACTIVE 过期则新建（epoch=max+1），最新绑定 REVOKED 则不重建；
  无：建 agent_scope subject + epoch1 绑定 + 映射。issuer="open-inquiry"、assurance_class="verified-key"。
- Writer 接缝 `a2a/server/customer-identity-gateway.ts`：`CustomerIdentityWriter`（local | spooled）；
  local 直接写 state.sqlite；spooled 先入本地 spool（a2a dir JSON），转发 `KIWI_CUSTOMER_IDENTITY_FORWARD_URL`
  （workbench 内部端点 + 共享 token），失败保持 pending 可靠重试（register 时 + 定时 drain）。
  环境变量：`KIWI_CUSTOMER_IDENTITY_WRITER=local|spooled`。
- 接入点：
  - merchant-handler 新 option `customerIdentity?: {merchantId, writer}`：rfq 分支在 schema 校验通过后
    （identityVerified && isOpenInquiryIdentity）调用；inquiry 分支在 engine 判定为有效询价后调用。
  - engine `ReceptionEngineResult.recognizedInquiry`（确定性判定：structured sku / interpreter sku /
    topics / 中文数量 任一）；responder.ts 增 `onVerifiedInquiry` hook（node.ts 注入 writer）。
  - 搜索/GetTask/无关消息/拒绝动作不调用 → 无建档（A6）。

### K4 商家协议持久化
- accept 分支改造（merchant-handler）：
  1. 校验全过后、advancePhase 前：查 ledger `system` 事件 `outcome.result.kind==="agreement_issued"`
     （同 negotiation + accepted_offer_id + terms_digest）→ 命中则复用原 artifact。
  2. 未命中：`buildAgreement` → 先 append 预写证据事件（agreement_id/terms_digest/identity/buyer_binding）
     → 再 advancePhase → 返回。
  3. handle() 终态守卫对 accept 特判：终态但有匹配证据 → 幂等返回原协议；无证据 → state_conflict（待核对）。
- K5 商家回执从该证据事件读取；重启扫链补登记（仅 phase=AGREEMENT_REACHED 的）。

### K2 委托与报价历史
- 委托扩展：`message.metadata.kiwi_delegation = {type:"kiwi.quote-history-delegation",version:1,merchant_id,
  purpose:"quote_history",issued_at,expires_at,buyer_agent_id}`；买方按 task 绑定派生（重试恒定）；
  `envelopeToMessage(envelope, metadata?)`。请求体签名已覆盖（content-digest）。
- 商家校验（merchant-handler，rfq/inquiry/history-query 共用）：验签身份 + merchant_id 匹配 + 版本 > 撤销水位
  + 未过期；通过 → 新表 `quote_history_delegations`（v4 迁移）记录版本/状态/撤销版本，并经
  DataUseGrantStore 建/续 history_recall grant（purpose 复用现有词表）。
- 已发报价索引：appendSent 时（subject 已知）写 `published_offers`（v4 迁移）：merchant/subject/negotiation/
  offer_id/sku/quantity/unit/currency/unit_price_minor/valid_until/terms_digest/spec_json(带来源快照)/created_at。
- 历史查询扩展：KNP `inquiry` + `subject.kiwi_history_query={version:1,skus?,limit?}`；商家在 inquiry 分支
  先判扩展：验签 + 授权复核（绑定/授权/数据范围 + 撤销版本）→ 查 `published_offers` → data part
  `kiwi_quote_history` 返回（历史价含时间/有效期；本次价格仍走正式 RFQ）；无授权/不支持 → 走原接待/澄清路径。
- 买方：`a2a-history-query.ts` 构造查询 envelope（ inquiry + subject 扩展）+ metadata 委托 → sendMessage →
  解析 data part；service `resolveLastQuote`。
- 幂等：BuyerProtocolRecovery exchange binding 纳入委托版本（同 message ID 改委托 → 不同绑定 → conflict）。

### K3 WorkBuddy 回访
- service `requestQuotes` 新分支：`reuse_history?: true`（显式 sku 优先跳过）→ 先解析商家 →
  `resolveLastQuote` → 唯一匹配：替换 intent items 的 sku（保留本次数量）走标准 RFQ；无历史/多义/不支持 →
  结构化返回澄清（不发 RFQ）。结果展示历史价 + 日期 + 有效期。
- MCP 工具 `kiwi_request_quotes` 增可选参 `reuse_history`；WorkBuddy expert 的 prompt/SKILL 增“沿用上次规格”
  分支说明；Pi 关闭时同样可用（纯服务层）。

### K5 意向回执 / K6 入口回执（共享投递组件）
- 新模块 `src/commerce/receipt/`：`types.ts`（事件词表 + 五类字段）、`outbox.ts`（merchant：a2a dir SQLite
  `receipt_outbox(event_id PK, payload_json, status PENDING|DELIVERED, attempts, next_retry_at)`；buyer：
  TaskApprovalStore 增 `mcp_commerce_receipt_outbox`，与协议同事务入队）、`catalog-client.ts`
  （POST {catalogUrl}/v1/commerce/receipts；merchant 用 Bearer merchant token；buyer 用 open-inquiry 会话钥
  签 EdDSA JWS，payload=回执字段，thumbprint=buyer_binding）、`dispatcher.ts`（入队即投 + 重启 drain +
  退避重试；同 event_id 幂等）。
- 商家事件：agreement 证据落账且 phase=AGREEMENT_REACHED → `merchant_agreement_issued`（买方 binding 用
  已验签 keyid）；带 handoff_destination 的 offer 正式发出后 → `merchant_entry_offered`（quote_ref 关联，
  无协议号）。
- 买方事件：`acceptAgreement` 成功提交本地协议（含有效 merchant_agreement）→ `buyer_agreement_accepted`；
  `handoff` 实际生成 handoff_ref（含即时返回分支）→ `buyer_handoff_generated`。拒绝/待审批/本地候选不入队。

### K7 订单
- `src/handoff/order-record.ts` 增渠道来源字段扩展（source_channel/channel_order_ref/channel_evidence，
  校验函数保持 fail-closed）；商家 ingest 已验证渠道订单后 → `merchant_order_created` 事件入队（同 event_id
  重投幂等；渠道内 order_ref 去重在 Catalog C2 做）。外链/失败 checkout 不产生事实。

### C1 回执入口（kiwi-catalog）
- models.py + migration 57：`commerce_receipts`（UNIQUE(merchant_id, reporter_role, reporter_identity,
  event_id)；content_hash；received_at；assurance verified|self_signed|adapter_delegated）。
- `handlers/commerce_receipts.py`：`submit(db_path, payload)`：
  - merchant：Bearer merchant token → `resolve_merchant_by_token`（merchant_id 强校验）；buyer：自包含
    EdDSA JWS（嵌入 JWK，`jwk_thumbprint` 校验 buyer_binding 一致）。
  - 事件类型×报告方白名单 + 必填字段校验（严格 allow-list，多余字段 400）。
  - 幂等：同 (已验报告方, event_id) 同 content → 返回原结果（`idempotent:true`）；异 content → 409。
- 只读查询 `GET /v1/commerce/receipts`（merchant token/admin）：按 merchant/negotiation/event_type 过滤；
  公开页面不接入任何回执投影（B6 同步验证）。
- 路由三处登记：`_ROUTE_TABLE` + `register_fastapi_routes` + parity 测试；双栈一致性测试
  （test_register_dual_stack 模式）。

### C2 事实计算（kiwi-catalog）
- `services/commerce_facts.py` + 只读端点 `GET /v1/commerce/facts/{intent|entry|order}`：
  - 意向：仅 merchant_agreement_issued × buyer_agreement_accepted，六元组全等计一笔；单方 → 报告方展示；
    冲突 → 待核对；自签 buyer → `verified_enterprise:false`（已核验企业指标只计独立企业凭据）。
  - 入口：merchant/buyer 分列；入口先于协议时按 quote_ref 关联。
  - 订单：(merchant_id, order_channel, order_ref) 去重；来源可信且关联可验证才确认；另一商家不可读。
- 权限：merchant token 只读本店；admin 全量；无公开读。

## 验收对照（测试计划）
- A1：并发两笔有效询价 + 重试 → subject 唯一；签名无效 → 无建档（open-inquiry-server 测试扩展）。
- A6：writer 故障 → 询价正常、无虚假承诺、恢复后无重复主体；绑定过期不新建客户号；无关消息/拒绝不建档。
- B6(Kiwi)：accept 三中断点重试恢复同一 agreement_id/摘要；终态无证据 → state_conflict。
- B6(Catalog)：同组回执双栈投递一致；幂等/冲突/字段限制/乱序。
- B1/B2/B3/B4/B5：固定回执样本驱动 C2 状态投影 + Kiwi 真实出站联调测试（模拟 catalog HTTP）。
- A2/A4：授权缺失/撤销/过期/旧客户端 → 正常询价无历史；历史查询返回来源规格与旧报价。
- A5：WorkBuddy 分支（reuse_history）两任务同 subject、出站 SKU=上次那款（服务层测试 + prompt 更新）。

## 交付顺序
批次1：K1 + C1 + K4（含迁移与测试）→ 批次2：K2 + C2 → 批次3：K3 + K5 + K6 → 批次4：K7 → 全量回归。

## 本地接线与复验

- 买方 MCP/HTTP 的历史委托由企业配置显式开启，`KIWI_QUOTE_HISTORY_DELEGATION=true`。WorkBuddy Expert 在声明这项配置后公开 `reuse_history` 工具参数。商家需要保留稳定的工作区，买家需要保留原协议目录和身份。
- 历史委托版本默认是 `1`。企业重新授权后，在买方设置更大的 `KIWI_QUOTE_HISTORY_DELEGATION_VERSION`，重启买方，再向原商家发起一次带明确商品规格的正常签名询价。商家收到新版本后才建立新授权。同版本重试不会延长有效期或恢复已撤销的授权。
- 买卖两端各自配置 `KIWI_RECEIPT_CATALOG_URL`。商家使用该店的 `KIWI_RECEIPT_MERCHANT_TOKEN`；买方复用本次磋商的开放询价签名钥。自托管直连需要另行启用受支持的开放询价验签，买方选择 `KIWI_OPEN_INQUIRY_DIRECT=true` 后才以该钥签名直连。
- 拆分部署中，A2A 使用 `KIWI_CUSTOMER_IDENTITY_WRITER=spooled`，将 `KIWI_CUSTOMER_IDENTITY_FORWARD_URL` 指向持有写权的 Workbench `/merchant/api/internal/customer-identity`。两端共享独立的 `KIWI_CUSTOMER_IDENTITY_CHANNEL_TOKEN`，最少 32 个字符。A2A 对同一库的历史查询使用只读连接。
- UCP 订单上报由 checkout 适配器的 `orderReceipts` 显式接入。适配器需使用商家凭据或独立限定商家与来源渠道的 Catalog 凭据。Catalog 的 `KIWI_CATALOG_ORDER_ADAPTER_BINDINGS` 接收绑定数组，每项包含 `adapter_id`、`token_digest`、`merchant_id` 和 `order_channel`。普通外链不产生订单事实。

## 投递对账与评测数据保留

- 独立商家工作台与 A2A 接待在同一个运行数据目录下共用 `delivery-streams.sqlite`。协调键包含商家、渠道和会话或收件范围。不同渠道继续独立发送，同一发送流的在途记录遵守共享租约和 outbox 状态。
- 启用邮件发送循环后，设置 `KIWI_DELIVERY_EVIDENCE_URL` 和 `KIWI_DELIVERY_EVIDENCE_TOKEN` 可启用自动对账。前者是部署方维护的 HTTPS 只读渠道日志查询端点。请求使用 GET 和 Bearer 鉴权，包含 `merchant_id`、`delivery_id`、`attempt` 、`started_at`、`channel`、可用时的 `provider_request_id` 和 `attempt_digest`。渠道端点必须根据已核对的原始投递日志准确回传 `attempt_digest`、不含个人信息的 `evidence_ref`，以及 `outcome: "accepted"` 和 `accepted_at`，或 `outcome: "not_sent"` 和 `future_execution_blocked: true`。无法确认时保持 `UNKNOWN`，查询未命中不构成未发送证明。
- 对账只结算原尝试，结果与审计同事务持久化。确认未发送会停止原记录，SMTP 不会自动重发。运营端可从 `GET /merchant/api/v1/delivery/unknown` 查看待核对列表和最近审计。未配置渠道日志端点时，发送循环会定期记录待核对数量。
- 治理所有权持有者定期清理评测。完成且候选已终结的评测保留 90 天逐场景详情，之后保留报告摘要和命令重放绑定。孤立且已过保留期的回执及过期执行租约会清理，待核对回执和未完成命令的幂等依据继续保留。
