# kiwi-merchant-gateway-connector — 商家连接器（「Kiwi 商家运营」）包

状态：**该资产已由需求负责人撤回（2026-09-21）**；历史：v1.1.0 曾提交 WorkBuddy 审核未发布（2026-09-20）。平台连接器 ID `oc_c86216e2a36110bf`（**撤回后不得再引用**）；原 v1.0.0 草稿 `oc_f6eb7fea361ac64e` 已由用户删除。审核通过后仍须实机验收 OAuth 与 6 个工具。详见[上架素材包](../../../../docs/merchant-buddy/merchant-connector-submission-pack.md)。

> **版本迁移记录**：原 v1.0.0 包只有 5 个工具。同 ID 重传 v1.1.0 未持久化；用户随后删除了旧草稿，再创建新资产 `oc_c86216e2a36110bf`。新资产的提交页及资产列表均显示 **v1.1.0 / 审核中**；6 个目录工具在仓库契约中通过校验，WorkBuddy 用户侧可见性仍待审核通过后验证。包摘要见[上架素材包](../../../../docs/merchant-buddy/merchant-connector-submission-pack.md) §1。

指向 **Kiwi 商家连接器网关**（多商家共享入口，`https://merchant.kiwi.harrylabsj.com/mcp`，远程 HTTPS MCP + OAuth）。商家在 OAuth 授权页完成目录注册/登录后，网关按已验证 `merchant_id` 提供**第 0 版目录能力**（本包静态声明的 6 个工具）：

| 工具 | 用途 |
| --- | --- |
| `kiwi_catalog_get_merchant_profile` | 连接状态与公开资料管理入口 |
| `kiwi_catalog_get_merchant_stats` | **经营汇总**：关注者总数 + 公开资料总浏览量 + 各资料的状态与浏览量（匿名聚合：无身份、无名单、无群发通道） |
| `kiwi_catalog_save_publication_draft` | 保存私有草稿 |
| `kiwi_catalog_request_publish` | 保存草稿并给出**门户确认入口**（不发布） |
| `kiwi_catalog_get_publication` | 读取一条资料的**当前内容**（商家名/商品名/类目/简介/店铺链接/FAQ）与状态 |
| `kiwi_catalog_withdraw_publication` | 撤回资料 |

按[「网关不碰实例」](../../../../docs/merchant-buddy/merchant-connector-deployment.md)原则（部署说明 §0），**没有** `kiwi_merchant_*` 之类的实例工具：商家实例独立部署、与网关无连接，买家经目录发现后**直接**与实例做 A2A。

## 与既有包的区别（不要混用）

| 包 | 指向 | 用途 |
| --- | --- | --- |
| `kiwi-merchant-connector-oauth/` | 单个商家实例（Veyquo） | 历史单商家形态；发布计划 §3.5 明确**不得**作为通用商家入口提交 |
| `kiwi-merchant-connector/`（token） | 单个商家实例 + 用户自填 Token | 过渡形态，同理不用于通用发布 |
| **本包** | 受信任网关（多商家） | 通用商家连接器，商家 Buddy 引用它；采购专家仍用买方连接器 `kiwi-sourcing` |

## 校验与打包

```sh
node integrations/hosts/workbuddy/package-gateway-connector.mjs --check
node integrations/hosts/workbuddy/package-gateway-connector.mjs --out /abs/path/kiwi-merchant-gateway-1.1.0.zip
```

脚本只读、不联网、不覆盖已有压缩包。校验：meta/mcp/icon 合法性、`url` 必须为 https 且路径 `/mcp` 且**不在**商家自有实例域名上、`tools` 声明与 `src/merchant-gateway/catalog-tools.ts` 实现名字一致、包内无疑似凭据。

声明与实现的**全等**比对（描述、inputSchema 逐个字段）由 `tests/workbuddy-gateway-connector.test.ts` 锁定，随 CI 一起跑。

## 提交前必须确认（外部事项）

1. **source 唯一性**：包已通过上传解析并生成新 ID，待审核通过后核对正式市场记录。
2. **新平台 ID**：`oc_c86216e2a36110bf`，与已删除旧商家 ID `oc_f6eb7fea361ac64e`、买方 `oc_bd73f860e3e2b5d3` 分开。
3. **入口域名**：`merchant.kiwi.harrylabsj.com` 已切换为商家网关；公网 `/health` 返回 `kiwi-merchant-entry`，OAuth 元数据提供 catalog/merchant scope。
4. **OAuth 回调**：按 source 派生为
   `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`，
   并验证平台规定的 loopback 回退；Buddy 应用级回调另行配置，二者不要混用。
5. **工具可见性**：连接器版本更新（如本次新增的关注总数工具）后，已在用的 Buddy 是否需重连/刷新才看到新工具——属预览实测项。

## 注意

- 本包**只声明第 0 版目录工具**；按「网关不碰实例」原则，入口不会出现实例工具，声明与运行时一致。
- 商家**无需部署任何服务器**即可使用全部能力（注册、草稿、请求发布、状态、撤回、关注总数）——第 0 版不依赖实例。
