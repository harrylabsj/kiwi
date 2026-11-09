# WorkBuddy 实例专用头模式与直连边界（2026-11-09）

状态：本地实现；**未上线、未在真实 Linkluck 验证**。平台证据仅来自隔离应用，不能外推到 Linkluck 或 WorkBuddy 全局。

## 1. 平台证据（隔离应用）

`terra-workbuddy-header-probe-2026-11-08.md` 记录：隔离应用 `kiwi-header-probe-20261108.app.workbuddy.host` 上，`X-Kiwi-Authorization` 单字段在短/长值、GET/POST 下源站可见；客户端重复字段源站只看到 1 个；标准 `Authorization` 即使客户端未发也会出现，且与客户端值不匹配。结论仅适用于该隔离路径。

因此：

- 标准 `Authorization` 在 WorkBuddy 网关下**不可作为实例 OAuth 的唯一载体**；
- 专用头目前只能证明“单字段可透传”，**不能证明**分享门禁、平台日志、Linkluck/kiwi-hk 运行路径或 OAuth 授权已完成；
- 专用头透传 ≠ 商家身份授权。必须另有实例 OAuth 授权、绑定和撤销。

## 2. 实例显式 opt-in

`profile.yaml`：

```yaml
merchant_mcp:
  enabled: true
  auth_mode: oauth
  public_url: https://merchant.example.com
  workbuddy_header: true          # 缺省 false
  owner_scope: true               # 可选；仍须 owner 会话显式申请 merchant:owner
```

约束：

- `workbuddy_header: true` 只允许 OAuth 入口（显式 `auth_mode: token` 拒绝；`auth_mode` 缺省按正式 OAuth 语义）；装配层绕过同样 fail-closed。
- 未启用时，标准 OAuth `Authorization` 行为原样不变，配对凭据/静态 token 组合照旧。
- 启用后，`/mcp` **只**读取 `X-Kiwi-Authorization: Bearer <OAuth access token>`：
  - 缺失、重复原始头、逗号合并、控制字符、超长、非严格 Bearer → 401；
  - 完全忽略平台注入的 `Authorization`，不回退；
  - 不再挂配对凭据校验器，避免静态/配对凭据经标准头绕过；
  - token 仍由原 `MerchantOAuthVerifier` 校验：merchant 归属、scope（含 owner）、过期/撤销、跨商家规则不变。
- 该模式不改变 OAuth authorize/token 端点，也不放宽 owner scope；`merchant:owner` 仍由实例显式启用、客户端显式申请、owner 角色两步校验。

## 3. 实际连接途径与平台门禁

代码只提供**实例侧**可验证基础；WorkBuddy 平台如何把某商家的连接器指向该实例仍未证明。按实施合同的平台路由 gate：

- A. 平台支持按商家配置实例 URL → 使用实例专属 URL + OAuth + 本专用头模式；
- B. 不支持但允许逐实例生成/分发连接器 → 需要明确资产生成、授权、更新、下架与审核责任；
- C. 均不成立 → 只能人工导出 + Buddy 解读，**直连未完成**。

无论 A/B/C，均不得经 kiwi-hk Catalog 或共享网关代理商家私有数据。当前仓库的共享网关实例代理路径不应用于该场景，也不能作为本模式已完成的证据。

商家本机可执行的实例侧向导（不经过 kiwi-hk）：

1. 在实例上初始化管理员口令，打开该实例的 OAuth authorize；商家本人登录并显式同意 `merchant:read`（需要金额时再显式申请 `merchant:owner`，实例须先启用）。
2. 获得实例 OAuth access token；不要把分享码当作用户身份或 OAuth token。
3. WorkBuddy 连接器必须指向该实例自己的 HTTPS `/mcp`（或平台支持的等效逐实例配置），不能指向共享网关。
4. 若平台只能稳定透传专用头，则实例开启 `workbuddy_header: true`；客户端发送 `X-Kiwi-Authorization: Bearer <access token>`。平台注入的标准 `Authorization` 被忽略；缺失/重复/合并/异常直接 401。
5. 调用只读运营工具验证实例身份、scope 和数据；撤销 token 后必须 401。分享门禁头只证明访问层，不证明以上任一步已完成。

## 4. 商家多轮会话（显式 opt-in，未平台验收）

实例侧已实现 `merchant_mcp.conversation: true`（仅 OAuth）时装配
`MerchantConversationManager`，在 MCP 暴露 `kiwi_merchant_chat`：

- 复用既有 `buildChatKernel`（`kiwi chat` / merchant HTTP adapter 同一商家内核），不新建智能体；
- 会话 key 为 `(merchant_id, OAuth principal_id, conversation_id)`；返回 `conversation_id` 续接，跨主体/跨商家返回未找到；同一会话内 turn 串行，避免并发写共享状态；
- 每会话本地状态目录独立，但 `merchantDataRoot` 固定指向原实例数据目录：a2a ledger / intelligence 与实例权威事实同源；
- 只读能力在 kernel 装配阶段过滤：仅注入 `list_catalog_products`、`get_catalog_product`、`get_inventory_snapshot`、`list_incoming_consultations`、`get_catalog_health`、`list_a2a_negotiations`；其中两个磋商列表由 handler `redactAmounts` 去掉 `price_minor`。写工具、`view_private_thresholds`、经营摘要/指标/待审批/人工队列中可能含金额的工具、记忆写入与技能工具不注入；
- `merchantDataDir` 为必填；缺失构造即 fail-closed，不静默回退会话目录。
- 强制 `manual` 模式，不接受斜杠命令或模式切换；不依赖 prompt 或 `supervised` 假设；
- 重启后会话 id 不持久化（未实现恢复），旧会话不会重新打开；这是当前限制，不宣称恢复能力；
- 未启用 `merchant_mcp.conversation` 时工具不出现；默认仍是未启动商家对话内核。

这只是 MCP 适配层，**不是 WorkBuddy 原生渠道**：stdio 构建候选的 `mcp.json` 已声明 `kiwi_merchant_chat`，但平台是否分发/刷新运行时 `tools/list`、是否允许对话工具、云端模型/商务凭据是否就绪均未验证。真实多轮对话、会话恢复和平台 UI 仍待联调；不得宣称已上线。

## 5. 本机适配器（离线可测，未部署）

`src/workbuddy-adapter/` 提供可独立验收的客户端基础，不经过 kiwi-hk：

- `binding.ts`：固定实例绑定（HTTPS / loopback、路径恰为 `/mcp`、issuer 同源、无 query/userinfo）；运行期不能由模型改 URL。
- `oauth.ts`：固定 issuer 的 discovery/register/PKCE/token/refresh/revoke；所有服务端请求带 `X-Share-Code`，浏览器授权 URL 仅按需带 `sharecode` query；不跟随重定向、限时/限量。
- `token-store.ts`：AES-256-GCM 加密文件（0600）；CLI 在本机数据目录生成 `adapter-key`（0600）作为密钥，token 与 key 同目录，**不是系统钥匙串，不能抵抗同账号读取**。按绑定指纹校验，换绑/换密钥/篡改 fail-closed；为支持门禁后的续期，加密保存 access/refresh token 与分享码；不保存 PKCE verifier。
- `mcp-client.ts`：固定实例 MCP 客户端，只发 `X-Kiwi-Authorization`，不发标准 `Authorization`；支持 initialize / initialized / tools list / tools call，JSON/SSE 有限解析。
- `cli.ts`：可运行的 `kiwi-workbuddy-adapter` 入口——`setup` 在本机受控页面绑定唯一实例并完成 OAuth PKCE；`serve` 是 WorkBuddy stdio MCP（只读运营 + 只读对话）；`status`/`logout` 管理本地状态。绑定、加密 key 与 token 均在 `--data-dir`（缺省 `~/.kiwi/workbuddy-adapter`），`0600`；未绑定/未授权 `serve` 退出 2。
  - setup 默认只申请 `merchant:read`；仅当实例 metadata 声明支持 `merchant:owner` 时显示可选复选框，必须商家本人勾选才请求；token 返回超出本次授权的 scope 会被拒绝。
  - 每次工具调用前检查 token；临近过期在单航班内 refresh，并用新的 token 创建新 MCP client；失败不自动重放可能已执行的请求。
  - 本机状态写入使用数据目录级跨进程锁（有界等待）；锁内完成最新 binding/token 读取、过期判断、一次有界 refresh 网络调用与保存，浏览器授权等待不持锁。崩溃遗留 `.state-write.lock` 不按 TTL 删除，后续写 fail-closed，需人工确认后移除。
  - 磋商列表严格透传并校验 `cursor`（非负整数）、`status`（active/agreement/all）、`limit`（1–100）。

构建候选：`integrations/hosts/workbuddy/kiwi-merchant-instance-stdio/mcp.json`（stdio，命令 `kiwi-workbuddy-adapter serve`）与 `README.md`。`src/workbuddy-adapter/cli.ts` 带 `#!/usr/bin/env node`，`package.json` 的 `postbuild` 会 `chmod 755 dist/workbuddy-adapter/cli.js`；`files` 未包含该 `integrations` 目录，按独立连接器资产交付，不随 npm 包分发。未提交平台、未实测 WorkBuddy 对该 stdio 包的分发/刷新行为。

`cli.ts` 提供本机 `setup` 受控页面与 loopback callback、`serve` stdio MCP、`status`/`logout`。它仍不是 WorkBuddy 平台连接器：没有平台资产分发/自动更新/审核，WorkBuddy 是否支持该 stdio 包及工具清单刷新未验证；真实平台 OAuth 是否携带 sharecode/header、刷新撤销与会话绑定仍待联调。

## 6. 未实现 / 待验证

- 真实 Linkluck 实例上的专用头 + OAuth + 分享门禁组合；
- WorkBuddy 平台是否支持按商家实例 URL、连接器资产生成/审核/升级；
- 平台边缘日志对 `X-Kiwi-Authorization`、sharecode、标准 Authorization 的采集/脱敏；
- 实例 OAuth 引导页在 WorkBuddy 内的实际可达性；
- 商家对话内核在云端的装配与消息路由（当前仅显式 opt-in 的 MCP 适配层，未平台联调）；
- 专用头模式在反向代理/CDN 下的重复头、大小写、逗号合并行为（仅隔离应用的原始 Node 测试）；
- 若中间层在到达实例前把重复字段静默折叠成单值，实例侧无法再检测；需在代理/平台侧另行验证。
