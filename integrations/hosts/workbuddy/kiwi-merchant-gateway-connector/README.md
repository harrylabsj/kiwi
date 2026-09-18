# kiwi-merchant-gateway-connector — 商家连接器（「Kiwi 商家运营」）包

状态：**已提交 WorkBuddy 审核，尚未发布**（2026-09-18）。平台连接器 ID `oc_f6eb7fea361ac64e`，v1.0.0；上架后仍须实机验收 OAuth 与工具。

指向 **Kiwi 商家连接器网关**（多商家共享入口，`https://merchant.kiwi.harrylabsj.com/mcp`，远程 HTTPS MCP + OAuth）。商家在 OAuth 授权页完成目录注册/登录后，网关按已验证 `merchant_id` 提供：

- **第 0 版目录能力**（本包静态声明的 5 个工具）：商家公开资料的草稿、请求发布（仍需商家在目录门户确认）、状态查询、撤回；
- **第 1 版实例能力**（动态）：商家在网关 `/instance` 页面绑定自有 Kiwi Merchant 实例后，`tools/list` 会多出该实例的 `kiwi_merchant_*` 工具（清单从实例现取、按令牌 scope 过滤）。

## 与既有包的区别（不要混用）

| 包 | 指向 | 用途 |
| --- | --- | --- |
| `kiwi-merchant-connector-oauth/` | 单个商家实例（Veyquo） | 历史单商家形态；发布计划 §3.5 明确**不得**作为通用商家入口提交 |
| `kiwi-merchant-connector/`（token） | 单个商家实例 + 用户自填 Token | 过渡形态，同理不用于通用发布 |
| **本包** | 受信任网关（多商家） | 通用商家连接器，商家 Buddy 引用它；采购专家仍用买方连接器 `kiwi-sourcing` |

## 校验与打包

```sh
node integrations/hosts/workbuddy/package-gateway-connector.mjs --check
node integrations/hosts/workbuddy/package-gateway-connector.mjs --out /abs/path/kiwi-merchant-gateway-1.0.0.zip
```

脚本只读、不联网、不覆盖已有压缩包。校验：meta/mcp/icon 合法性、`url` 必须为 https 且路径 `/mcp` 且**不在**商家自有实例域名上、`tools` 声明与 `src/merchant-gateway/catalog-tools.ts` 实现名字一致、包内无疑似凭据。

声明与实现的**全等**比对（描述、inputSchema 逐个字段）由 `tests/workbuddy-gateway-connector.test.ts` 锁定，随 CI 一起跑。

## 提交前必须确认（外部事项）

1. **source 唯一性**：包已通过上传解析并生成新 ID，待审核通过后核对正式市场记录。
2. **新平台 ID**：`oc_f6eb7fea361ac64e`，与买方 `oc_bd73f860e3e2b5d3` 分开。
3. **入口域名**：`merchant.kiwi.harrylabsj.com` 已切换为商家网关；公网 `/health` 返回 `kiwi-merchant-entry`，OAuth 元数据提供 catalog/merchant scope。
4. **OAuth 回调**：按 source 派生为
   `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`，
   并验证平台规定的 loopback 回退；Buddy 应用级回调另行配置，二者不要混用。
5. **工具可见性**：绑定实例后新增的工具是否需要在 Buddy 侧重连/刷新才可见——属预览实测项。

## 注意

- 本包不声明第 1 版实例工具：那些工具按商家实例现取，静态声明会与实际不符。
- 未绑定实例的商家照常使用第 0 版能力（注册、草稿、发布、撤回），**不会**因为没部署服务器而被阻塞。
