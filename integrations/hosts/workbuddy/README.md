# Kiwi WorkBuddy 专家

职称：**Kiwi 采购询价**；花名：**海纳·采购专家**。专家版本独立从 1.0.0 开始，不改变 Kiwi 运行时版本。

`kiwi-procurement-expert/` 是完整专家包，包含 `.codebuddy-plugin/plugin.json`、Agent、三个预加载技能和 512×512 PNG 头像。专家只使用既有 Kiwi 买方 MCP 九个工具，复用现有审批与状态机。

专家 v1.0.1 的 `dependencies.connectors` 使用桌面端运行时 source **`kiwi-sourcing`**。开放平台资产 ID **`oc_bd73f860e3e2b5d3`** 继续用于管理已发布连接器，两者不能互换。WorkBuddy 5.6.0 的 `getConnectorConfigById` 只按 `entry.source || entry.name` 查找；v1.0.0 误填资产 ID，会在启动 MCP 前报 `Connector not found`。

升级时保留原专家的平台 ID，上传 v1.0.1 包并检查平台生成的依赖仍为 `kiwi-sourcing`；若平台强制改写为 `oc_…`，需由 WorkBuddy 修复资产 ID 到 source 的映射。更新后重新载入专家，再从连接器面板连接 Kiwi，确认九个已发布买方工具可用。本修复不改变买方连接器配置、工具契约或 Kiwi 运行时版本。

## 校验与打包

在 Kiwi 仓库根目录运行（使用项目已有 Node、yaml、ajv 依赖和系统 zip）：

```sh
node integrations/hosts/workbuddy/package.mjs --check
node integrations/hosts/workbuddy/package.mjs --out /absolute/path/kiwi-procurement-expert-1.0.1.zip
```

脚本校验两层职称/花名一致、技能路径/预加载一致、PNG 尺寸和大小、引用的工具仍在 MCP 源码中、示例满足 CommerceIntent 契约；只打包明确列出的专家文件，不带数据库、凭据、运行时或 macOS 元数据，不覆盖已有压缩包。

## WorkBuddy 提交

在开放平台「专家 → 创建」上传 ZIP，核对：

- 专家职称：Kiwi 采购询价（对应 profession，不是 displayName）。
- 专家花名：海纳·采购专家（对应 displayName）。
- 市场展示分类建议：行业顾问；服务类目按平台实际可选项选择采购辅助/效率工具相关项。
- 三个示例问题、头像和介绍应由包正常解析。市场分类有时仍需在表单手动选择。

由用户授权发布后才提交审核。此适配不自动提交、不更新连接器、不发布 npm。后续修改原专家时保留平台生成的专家 ID；即使撤回后重新上传，平台也可能要求递增 version（微信专家已验证此要求）。

## 离线验收与线上联调

离线场景：只找供应商不发 RFQ；缺数量时不猜测；报价缺运费不声称到手总价；只制定还价方案不发送；接受/交接仅按对应授权和运行时审批推进；硬拒绝不绕过；任务恢复不重复询价。包校验只验证可确定的结构/契约，不代替这些对话行为的实测。

线上联调使用明确授权的测试供应商，验证搜索 → 询价 → 状态 → 比较 → 非约束性协议 → 交接；不会自动向真实商家发测试请求。Kiwi 不处理订单创建、支付和库存预留。

## 头像

内置 ImageGen 生成的原创插画，保存为 `kiwi-procurement-expert/avatars/kiwi-procurement.png`。提示词：绿色 kiwi 鸟，戴圆框眼镜、拿三项勾选清单，薄荷绿/深绿与少量暖橙，浅色背景，居中留白，无文字、无品牌标识；用于采购专家头像。

## Kiwi 商家连接器与 Buddy 应用（当前第 0 版）

当前通用包是 `kiwi-merchant-gateway-connector/`：`source=kiwi-merchant`、固定 HTTPS 网关入口、OAuth，**只暴露 6 个 `kiwi_catalog_*` 目录工具**。按[部署说明](../../../docs/merchant-buddy/merchant-connector-deployment.md) §0，网关不连接商家实例、不代理库存或询价工具。不要把历史 `kiwi-merchant-connector/`（单实例 token）或 `kiwi-merchant-connector-oauth/`（单实例 OAuth）包提交为通用入口。

```sh
node integrations/hosts/workbuddy/package-gateway-connector.mjs --check
node integrations/hosts/workbuddy/package-gateway-connector.mjs --out /absolute/path/kiwi-merchant-gateway-1.1.1.zip
```

`kiwi-merchant-buddy/` 是应用后台人工配置草稿、头像、AI 客服准备技能与填写说明。v1.1.0 商家连接器资产已撤回；按 2026-09-24 决策，以 v1.1.1 独立重新申请 OAuth MCP 连接器资产，审核通过后由 Buddy 应用内置连接器引用新 ID。用户仍在 Buddy 内完成授权使用，不要求另行安装市场产品。提交需要专用商家测试账号。具体包与实机检查见[上架素材包](../../../docs/merchant-buddy/merchant-connector-submission-pack.md)和[检查单](../../../docs/merchant-buddy/workbuddy-e2e-checklist.md)。
