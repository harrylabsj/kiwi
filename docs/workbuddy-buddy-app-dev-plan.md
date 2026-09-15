# Kiwi Merchant → WorkBuddy Buddy 应用开发计划

**日期：** 2026-09-14
**依据：** `kiwi-merchant-workbuddy-buddy-app-assessment.md`（评估基于 `main@765964a` / v0.7.22；本仓库当前 v0.8.0）

## 目标与边界

- 目标：以「标准远程 MCP 连接器」方式把 Kiwi Merchant 接入 WorkBuddy，作为商家运营工作台。
- MVP 范围：只读查询 + 审批候选生成，不开放高风险自动写操作。
- 不做：
  - 重写现有 A2A Merchant；A2A/KNP 入口保持独立，不改成 MCP。
  - 在 MCP 层维护第二套磋商状态机（只读 Kiwi Ledger/Store）。
  - 直接执行 `create_product` / `update_inventory` / `resolve_review`（一律先返回审批候选）。

## 前置决策（开工前需确认）

1. 部署形态：单商家一服务 vs 多商家共享 MCP 服务。MVP 建议先单商家。
2. 认证模式：优先 WorkBuddy Connector OAuth；短期不具备则用「用户自填 Token」+ `token-schema.json`。
3. 域名分离：`mcp.merchant.example.com:9100` 与现有 `a2a.merchant.example.com:9000`。`KIWI_A2A_PUBLIC_URL` 只接受 `https://<host>` 不接受路径，独立子域名更稳妥。

## 阶段一：Merchant Workbench Facade（核心业务层抽取）

从 `src/agent/merchant/merchant-tools.ts` 抽取不依赖 Pi Agent Core 的业务服务层。

- 新增 `src/merchant/workbench-service.ts`（**偏差说明**：原计划写 `src/mcp/merchant-service.ts`；实施时对齐 buyer 侧先例——业务服务层放领域目录（`src/buyer-core/service.ts`），`src/mcp` 只放协议层，避免 `src/agent` 反向依赖 `src/mcp`），统一封装：
  - 商品目录查询
  - 库存快照
  - A2A 磋商记录（读 Ledger）
  - 人工审核队列
  - Merchant Ops 统计（读 `src/merchant/stats-store.ts`）
  - 商品变更草稿和审批候选（复用 `WriteApprovalCandidateStore`）
- 横切能力：DTO 校验、租户校验、字段白名单、敏感字段脱敏（底价/成本/利润/凭据绝不返回）、统一错误映射、fail-closed（商品源故障不回退演示价）。
- 改造 `src/agent/merchant/merchant-tools.ts` 改为调用 Facade，避免 Pi tool 类型外泄。

验收：Facade 可被现有 Pi 工具和新 MCP 层同时调用；脱敏有单测覆盖。

## 阶段二：标准远程 MCP Server

- 新增：
  - `src/mcp/merchant-tools.ts` — 7 个 MVP 工具定义
  - `src/mcp/merchant-server.ts` — streamableHttp MCP Server（独立端口，不复用 A2A `/` 端点）
  - `src/mcp/merchant-auth.ts` — OAuth / Token 校验，最小权限
- `package.json` 引入标准 TypeScript MCP SDK（版本按 WorkBuddy 支持矩阵确认）。
- 工具约束：名称/描述/参数/返回结构稳定；单次请求 30s 内完成（限制查询窗口和响应体大小）；写类工具只返回审批候选。
- MVP 工具：

  ```text
  kiwi_merchant_list_products
  kiwi_merchant_get_product
  kiwi_merchant_get_inventory
  kiwi_merchant_list_a2a_negotiations
  kiwi_merchant_list_human_reviews
  kiwi_merchant_get_analytics
  kiwi_merchant_prepare_product_change
  ```

- 修改：`src/cli.ts` 增加 `kiwi merchant mcp serve`；`src/config/profile.ts` 增加 WorkBuddy/租户配置引用；`src/product-cli.ts` 补帮助与状态说明。
- 测试：`tests/merchant-mcp.test.ts`、`tests/merchant-auth.test.ts`（无凭据 fail-closed、越权租户访问拒绝）。

验收：本地用 MCP Inspector 或脚本客户端完成 7 个工具的连通与权限测试。

## 阶段三：Connector 打包与 Buddy 配置

- 新增连接器文件（实际位置沿用既有 WorkBuddy 集成目录约定，放 `integrations/hosts/workbuddy/kiwi-merchant-connector/`）：

  ```text
  integrations/hosts/workbuddy/kiwi-merchant-connector/
  ├── connector-meta.json
  ├── mcp.json                    # tools 声明为非标准信息字段（平台以 tools/list 为准）
  ├── icon.svg
  ├── skills/kiwi-merchant/SKILL.md
  └── token-schema.json           # auth_mode: "token"（用户自填 Token）
  ```

  校验/打包脚本：`integrations/hosts/workbuddy/package-merchant-connector.mjs`（--check / --out zip，风格对齐 package.mjs）。字段格式依据官方连接器文档（<https://open.workbuddy.cn/docs/connector>）。

- Buddy 后台配置草稿：`integrations/hosts/workbuddy/kiwi-merchant-buddy/`（buddy-app.config.json + README）。首页（slogan/欢迎语）、3 个工作模式（商品查看、询价处理、库存与变更草稿）、场景胶囊（预置提示词 + 工具绑定）、模型池（以 WorkBuddy 模型池为主）。后台导出格式未公开，草稿为自定义结构，提交前需在后台核对。
- 用 staging MCP 服务 + 导出的配置 JSON 做预览调试。

## 阶段四：加固、审核与发布

仓库内已完成：

- 审批链路闭环（MCP 侧）：`MerchantWorkbenchService` 内置进程级执行钩子表 + `recoverPendingDrafts()`（启动时为本服务可执行工具 `draft_product_change` 的遗留 pending 候选重建钩子）+ `approveCandidate()`（语义对齐 chat kernel `/approve`：重读前置重哈希、stale/expired supersede、只执行库内已批准参数、manual 拒绝、幂等不重复执行）。`kiwi merchant mcp serve` 启动路径把非 draft 候选按 expireForRecovery 语义失效，恢复 draft 候选并在启动日志报告条数。审计复用 `WriteApprovalCandidateStore`（candidate_id / arguments_hash / 状态流转落 state.sqlite），未新建第二套。
- 发布前清理：README 顶部版本声明改为以 `package.json` 为准（消除 0.7.22 漂移）；能力宣传核对通过——连接器包与 Buddy 草稿未宣传 `listings/status/doctor`（未实现）与 `pauseListing`（对真实 shopping-cli 2.x fail closed），变更场景措辞均为「生成草稿，批准后执行」；mcp.json 与 `src/mcp/merchant-tools.ts` 的一致性由 `tests/workbuddy-merchant-connector.test.ts` 全等比对锁定。
- 公网 fail-closed 核查：
  - MCP 侧矩阵已覆盖（`tests/merchant-auth.test.ts`）：loopback+无 token=警告启动；非 loopback+无 token=拒绝启动（CLI 退出码 2）；非 loopback+有 token=正常。
  - A2A 侧现状：**已是 fail-closed**——`src/a2a/node.ts` `startA2aNode` 在广告地址非 loopback 且未配置认证验证器（`KIWI_A2A_AUTH` / 直传 authVerifier）时抛错拒绝启动（审查 BUG-02）；loopback-only + 公网广告的组合有醒目 stderr 告警（审查 P2-E，认证责任在反代）。所有 A2A 启动路径（agent serve / merchant start / merchant up）都经 `startA2aNode`，无绕过。未改 A2A 代码。

平台侧剩余人工步骤（仓库外）：

- 创建应用 → 基础信息审核 → 分模块配置（按 `integrations/hosts/workbuddy/kiwi-merchant-buddy/README.md`）→ 预览调试 → 提交审核 → 发布上线。
- 已发布应用的配置变更需重新提交审核。
- 连接器 zip 用 `package-merchant-connector.mjs --out` 重新生成后按「连接器」流程提交；提交前核对阶段三 README 列出的后台字段清单。

## 发布检查清单

- [ ] 版本一致：README 版本声明以 package.json 为准（已改）；发布前确认 package.json 版本是本次发布目标。
- [ ] 能力宣传：连接器 SKILL.md / Buddy 胶囊 / mcp.json 不含未实现能力（listings/status/doctor、直接执行写操作）。
- [ ] fail-closed：MCP 非 loopback 无 token 拒绝启动（`merchant-auth.test.ts`）；A2A 公网广告无验证器拒绝启动（既有守卫）。
- [ ] 凭据不入库：包内无真实 token/域名凭据（校验脚本凭据扫描）；`SHOPPING_MERCHANT_TOKEN` 不出现在任何包文件。
- [ ] zip 重新生成：`node integrations/hosts/workbuddy/package-merchant-connector.mjs --out <新路径>.zip`。
- [ ] 后台字段核对：按 `integrations/hosts/workbuddy/kiwi-merchant-buddy/README.md` 的「需在 WorkBuddy 后台核对的字段」逐项过。

## 主要风险与控制

| 风险                                | 控制                                                   |
| ----------------------------------- | ------------------------------------------------------ |
| 协议不兼容                          | A2A/KNP 与 MCP 通过独立适配层连接                      |
| 自然语言绕过 write gate             | MCP 写工具只产出审批候选，执行仍走 Kiwi approval store |
| 私密字段泄露（底价/成本/利润/凭据） | Facade 白名单 + 脱敏单测 + 评审 checklist              |
| 状态分裂                            | MCP 只读 Kiwi Ledger/Store，禁止本地状态机             |
| 数据源不可用                        | 保持 fail-closed，不回退演示价                         |
| MCP 超时                            | 查询窗口分页、响应体截断、30s 上限                     |
| 版本漂移                            | 发布前统一版本号与文档                                 |

## 建议排期

阶段一 2–3 天 → 阶段二 3–4 天 → 阶段三 1–2 天 → 阶段四 2–3 天，合计约 8–12 个工作日（不含 Buddy 审核等待时间）。

## 参考资料

- [WorkBuddy Buddy 应用文档](https://open.workbuddy.cn/docs/buddy-app)
- [WorkBuddy 连接器文档](https://open.workbuddy.cn/docs/connector)
- [WorkBuddy 第三方应用与 OAuth 文档](https://open.workbuddy.cn/docs/third-party-app)
- [WorkBuddy Open API 文档](https://open.workbuddy.cn/docs/openapi)
