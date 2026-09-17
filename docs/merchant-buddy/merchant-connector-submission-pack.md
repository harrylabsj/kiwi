# 商家连接器上架素材包（提交前必读）

状态：素材就绪、**未提交**（2026-09-17）。依据：[商家连接器独立发布计划](generic-merchant-connector-release-plan.md)、[平台核验记录](workbuddy-connector-platform-verification-2026-09-17.md)、[第 1 版设计](../v1-product-flow-and-onboarding-design.md)。

**提交顺序**：先连接器（拿到平台生成的新 ID）→ 再 Buddy 应用（引用该 ID）→ 最后预览与实机验收。**不得**先提交应用。

---

## 1. 连接器包

| 项 | 值 |
| --- | --- |
| 目录 | `integrations/hosts/workbuddy/kiwi-merchant-gateway-connector/` |
| 内容 | `connector-meta.json`、`mcp.json`、`icon.svg`（3 文件，约 9 KB） |
| source | `kiwi-merchant`（**需先在平台核对唯一性**） |
| 入口 | `https://merchant.kiwi.harrylabsj.com/mcp`（固定 HTTPS，OAuth） |
| 回调 | `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`（按 source 派生；拒绝时回退 loopback） |
| 声明工具 | 5 个 `kiwi_catalog_*`（第 0 版目录能力）；第 1 版实例工具按商家实例**动态出现**，故不静态声明 |

重新生成（提交前必须重跑，并核对 sha256）：

```sh
node integrations/hosts/workbuddy/package-gateway-connector.mjs --check
node integrations/hosts/workbuddy/package-gateway-connector.mjs --out /abs/path/kiwi-merchant-gateway-<version>.zip
shasum -a 256 /abs/path/kiwi-merchant-gateway-<version>.zip
```

本次构建产物（供对照，**提交前请以最新构建为准**）：`kiwi-merchant-gateway-1.1.0.zip`，sha256 `b4766196ac94ac8b04738e3b4795b7662c6a6441f999fc2091352d5d140b47ea`。

离线校验覆盖（脚本 + 测试，均随 CI 跑）：
- 包结构与字段合法性；`url` 必须 https + `/mcp` + **不得落在商家自有实例域名**；
- `tools` 声明与 `src/merchant-gateway/catalog-tools.ts` 实现**全等**（`tests/workbuddy-gateway-connector.test.ts`）；
- 包内无疑似凭据（`cmt_` / `mcp_at_` / Bearer / API key 形态）。

## 2. 平台步骤（连接器）

1. 上传 ZIP → 平台解析并生成连接器 ID → 核对信息（名称、source、工具、回调）。
2. 记录 **新连接器 ID**（不得复用买方 `oc_bd73f860e3e2b5d3`）。
3. 提交审核 → 审核通过后记录版本号与发布状态（作为验收证据留存）。
4. **若平台拒绝 `workbuddy://` 私有协议回调**：确认回退 `http://127.0.0.1:{动态端口}/oauth/callback` 是否被接受；两条都不行则停下评审，不改入口形态。

## 3. Buddy 应用

配置草稿：`integrations/hosts/workbuddy/kiwi-merchant-buddy/buddy-app.config.json`（v1.1.0，已按两个连接器方案重写）。

**两类回调不要混填**（本次重写的重点）：

| 字段 | 填什么 |
| --- | --- |
| 应用级「授权回调URL」 | 本应用自己的 HTTPS 回调服务（接收平台 Open API 授权码）。当前不申请 Open API 权限 → 留空；确需权限时**先部署可处理授权码的真实回调**，不得填占位 URL |
| 连接器回调 | `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`（属于连接器包，不属于应用表单） |

应用侧要点：
- 模式：**目录注册与发布**（用 `kiwi_catalog_*`，发布必须引导到门户确认）、**连接我的 Kiwi Merchant 服务**（引导到 `https://merchant.kiwi.harrylabsj.com/instance`，令牌/配对码不经聊天）、商品查看 / 询价处理 / 库存与变更草稿（需已绑定实例）。
- 未绑定实例的商家：走「目录注册与发布」不受影响（网关在未绑定时不返回 `kiwi_merchant_*` 工具），这是第 0 版不被首次绑定阻塞的技术保证。
- 平台后台逐字段核对清单见 `kiwi-merchant-buddy/README.md`。

## 4. 提交前必须确认的外部事项

| # | 事项 | 由谁解决 | 未确认时的后果 |
| --- | --- | --- | --- |
| 1 | `kiwi-merchant` source 是否已被占用 | 平台核验 | source 冲突会让包解析失败或与既有资产混淆 |
| 2 | 新连接器 ID（平台生成） | 平台流程 | 无法绑定 Buddy 应用 |
| 3 | `merchant.kiwi.harrylabsj.com` 从"Veyquo 单实例"切换为网关入口的时机 | 部署方（见部署说明 §10） | 连接器指向的入口若仍是单实例，其他商家授权会落到 Veyquo |
| 4 | 平台对 `workbuddy://` 私有协议回调与 loopback 回退的接受情况 | 平台预览 | 授权无法回跳 |
| 5 | 绑定实例后新增工具是否需要 Buddy 侧重连/刷新 | 平台预览 | 商家绑定后可能看不到实例工具，需在文案里给出「重连一次」的指引 |

## 5. 随提交附上的证据

- 跨仓端到端验收：`bash scripts/v1-merchant-connector-acceptance.sh`（20 项断言，输出含 `publication_id`、工具清单、隔离与离线恢复结论）；
- 契约锁定：`tests/workbuddy-gateway-connector.test.ts`、`tests/buyer-tool-contract.test.ts`（买方九工具 inputSchema 基线）；
- 安全设计：`merchant-instance-pairing-design.md`（绑定=控制权证明、配对码、凭据轮换/吊销、出站钉住、mTLS 决策）；
- 部署说明：`merchant-connector-deployment.md`（同机拓扑、反代分流、凭据清单与轮换、回滚）。

## 6. 被拒或需回滚时

1. 撤回/下架连接器版本（平台操作），**不影响**：目录里的公开资料（在 kiwi-catalog）、商家的商品/库存/接待（在商家实例）、买方连接器与采购专家（完全独立）。
2. 反代把 `merchant.kiwi.harrylabsj.com` 摘掉或置 503；网关进程可继续运行（已连接商家不受影响）。
3. 若已发出新 ID 但应用未通过：保持应用未发布状态，修正后重新提交；不要用买方 ID 或单实例包顶替。

## 7. 明确不做

- 不把 `kiwi-merchant-connector-oauth/`（指向 Veyquo 单实例）作为通用商家入口提交；
- 不为通过表单而申请不需要的 Open API 权限或填写无效回调；
- 不在连接器包内写任何密钥、商家实例地址或内部令牌；
- 不在未验证入口可用的前提下宣称"已支持异地自托管"（出站钉住已实现，但真实公网部署的端到端仍待部署环境）。
