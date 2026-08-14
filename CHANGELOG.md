# Changelog

## Unreleased

- A2A 1.0 KNP 响应统一使用 `text`/`data` Part 与 `ROLE_*` wire 形状，0.3 兼容响应保持不变。
- malformed 1.0 Part 现在在协议边界 fail-closed，避免远端输入触发内部 500。
- Python 参考实现与 CSV/Excel 适配器增加响应、请求体、文件、行、列和压缩包资源上限。
- 组合 CI 增加官方 SDK 往返与三向独立实现 conformance，并上传 wire transcript 证据。

## v0.7.7 — 2026-08-14

**安全身份与发布元数据**：trusted-keys 注册表、出站 HTTP Message Signature 闭环，以及组合锁重锚。

## v0.6.1 — 2026-08-09

**修复与商家侧支持**（shopping-cli v3.0 发布面剥离后的契约对齐）：

### 商家部署（Veyquo 实装驱动）

- 新增 `KIWI_MERCHANT_TOKEN`：商家用自己签发/找回的随机 token 绑定 merchant_id
  注册 Agent（register.ts / a2a node / cli serve+publish 直传优先，HMAC 派生兜底）
  ——平台 `KIWI_CATALOG_OWNER_TOKEN_SECRET` 不再需要出现在商家服务器；
- `kiwi merchant publish` Step 2 重构：读 shopping-cli `listings projections
  --format json` 投影 → 直连 catalog `POST /v1/listings/publish`（剔除 `_` 前缀
  内部字段；owner token 直传优先/HMAC 兜底；投影读取非零退出/非 JSON fail-closed），
  修复 `publish-listings` 命令被 shopping-cli v3.0 剥离后的发布失败；
- shopping-cli 兼容探测与调用路径支持 `--shopping-cli-path`（entry point 名
  `shopping-cli`，非 legacy `shopping`）。

### 其他

- 测试：1577 全过（新增发布失败明细、投影参数断言等）。

## v0.6.0 — 2026-08-07

**A2A v0.6.0 正式发布**（当日由 v1.0.0 回退版本号；KNP 协议身份不变，基线 §41 完成定义
27/27 经就绪度审计 `docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md` 逐条实证满足）。

### 协议与发布

- §41 #6：公开稳定 namespace `com.harrylabsj.kiwi.shopping.negotiation`，spec/schema 托管于
  `https://kiwi.harrylabsj.com`（Cloudflare Pages，公开仓库 `harrylabsj/kiwi-spec`）。
- §41 #7：九类核心 Negotiation Objects 冻结为 JSON Schema（`contracts/negotiation/1.0/schema.json`），
  与领域实现交叉一致性对齐（digest 必填、offer-like items 要求 unit_price、withdraw/decline scope 约束等）。
- 协议文档状态 Draft → Normative（Released）；基线 §41 加盖宣布戳。

### 实现（v0.4–v1.1 累计）

- **v0.4 谈判基础**：KNP 领域模型、条件求值器、Ledger、幂等、Legacy Adapter。
- **v0.5 原生 A2A**：Agent Card、A2A client/server、Task 生命周期与恢复、Channel 抽象、鉴权。
- **v0.6 UCP interop**：profile 模型/resolver、capability intersection、well-known 服务、UCP-Agent、双入口发现。
- **v0.7 开放网络**：trust records、fan-out 隐私 + 多商家 RFQ、服务端限流、interop E2E。
- **v1.1 交易 handoff**：agreement→checkout 桥、UCP checkout channel、operator 授权、只读 order records、ACP-Commerce 接缝。
- **发现层**：ShoppingCliCatalogSource（Agent Catalog 作为发现源）、UCP cart capability client。

### 验证

- 全部离线测试全绿（`npm run verify`：lint/typecheck/build/test/package）。
- 测试计数以 `npm run verify` 实际输出为准（README 同步维护）。

### 行为边界（§41 #25/#26/#27）

- KNP/1.0 在非绑定商业协议处终止：不创建订单、不执行支付、不锁库存
  （agreement 三副作用 flag 恒为 `false`，schema 与领域双重强制）。
