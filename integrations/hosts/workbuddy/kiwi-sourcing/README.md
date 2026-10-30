# Kiwi 采购询价 WorkBuddy Connector

## 状态与本地验证

此包是 Connector `1.0.4` 候选，展示名称保持 `kiwi网络空间`。平台版本核验结果：`1.0.3` 审核中，`1.0.4` 可用；本候选包尚未提交平台审核。提交审核不等于审核通过。

2026-10-31 在 WorkBuddy 5.9.3 本地专家完成一次只读 `kiwi_search`：工具 `mcp__kiwi-network-local__kiwi_search` 返回 `success`，耗时 1263 ms；结果为 Veyquo 两款保温杯候选（600 ml、500 ml），状态 `completed + has_candidates`，价格待询价。本次未询价、磋商、下单或付款。

并发修复后的 40 项合成/协议回归通过；两个真实并发启动器均达到 `READY`，13 工具契约通过、退出码为 0，最终更新锁已清除。这些结果验证本地启动和一次只读搜索，不表示询价、磋商或交易链路已验收。

## 启动路径

`mcp.json` 从历史固定 npm CLI 入口改为随包 `runtime/production-launcher.mjs`。启动器要求 Node 22.19+、系统 `npm` 和 Python 3，并要求宿主提供当前用户私有的 `CODEBUDDY_PLUGIN_DATA`。每次启动只解析 npm `latest` 一次，锁定本次包及来源证据，执行隔离安装、来源/完整性/安装树验证、英文和中文 MCP schema 探测，再启动本次确切版本的后端。未准备完成前，前端可返回静态 13 工具基线；该列表本身不是 READY。只有后端 initialize、实际 tools/list 与 13 工具契约都验证通过后，才发出固定 READY 状态。任何未知版本、验证失败、缓存漂移或超时都停止，不回退到旧缓存。

MCP 前端只支持 `2025-06-18`：客户端请求该版本时原样回应；请求其他非空版本时回应此服务支持的 `2025-06-18` 作为 counteroffer，并等客户端发 `notifications/initialized` 后才激活后端。如果客户端不接受，会话不会进入 READY，也不会创建 backend。协议诊断仅向 stderr 写固定版本分类、服务协商版本和状态，不记录客户端发送的原始版本字符串或请求正文。该协议处理已通过本地合成流测试。本次本地搜索证明当前 WorkBuddy 路径可用；其他协议版本 counteroffer 行为和写工具流程仍未验证。

历史正式入口固定为 `@harrylabsj/kiwi@0.12.3`；另一个未提交 staging 副本改为固定 `0.12.7`。本候选用按次 latest 替代这两种固定 pin，是有意的启动契约变化，不能默认为平台接受。

## 架构与业务边界

```text
WorkBuddy 对话
  └─ Kiwi 采购询价 Connector（本目录）
       └─ Kiwi Buyer Core
            ├─ 本地 SQLite：task、approval、agreement
            ├─ kiwi-catalog：发现供应商
            └─ 独立 Kiwi Merchant Agent：商品、库存、报价、KNP/A2A
```

连接器是买家入口，不是商家运行时。`kiwi merchant` 继续独立部署并保有商家私有数据、凭证、定价规则和审计 Ledger。商家经营助手可以作为独立控制面调用既有 Merchant HTTP/SSE 接口，不将商家运行时迁入 WorkBuddy。

保留随包 13 工具契约。连接器是 MCP 通道，不增加业务审批、授权、预算或范围逻辑：已列出的工具名、arguments 和后端结果按协议透传，`approval_required`、错误和拒绝结果也由 Kiwi 后端决定并返回。连接器不会生成确认、自动调用 `kiwi_approve`、替换审批结果或因宿主缺少 elicitation 能力而拦截业务工具。

业务范围、预算及是否调用接受协议、handoff、approve 等动作由上层专家和 Kiwi 后端职责划分决定；连接器不证明真人身份或确认意图，也不保证后端实现特定预算策略。`kiwi_approve` 仅在上层专家主动调用时透传。13 个工具中没有支付工具；连接器不会新增支付能力。

连接器仍保留 MCP 协议版本协商。对 host 或 backend 的 elicitation，仅作为协议能力/请求通道透明转送；其存在不构成 connector 的审批或真人授权证明。真实 WorkBuddy 真人确认语义尚未验证。

## 配置与数据安全

- 一个连接器只配置一个 stdio MCP Server。
- 不在包内保存 Token、API Key、管理员密码或商家凭证；不把一次性秘密输出到模型可见的日志或回执。
- 准备缓存必须位于宿主提供的私有数据目录；格式 3 指针绑定版本、integrity、lock 摘要和安装内容树。启动前持锁重新核对并重扫。
- npm latest、registry、签名验证和安装需要外网；网络或能力不足时停止，不换源、不静默回退。
- MCP timeout 当前为 30 秒；A2A 调用预算为 15 秒。
- 非绑定协议不会创建订单、支付或锁定库存。

## 本地校验与打包

在 Kiwi 仓库根目录运行：

```bash
npm run verify:workbuddy
npm run package:workbuddy
```

打包默认输出 `release/workbuddy/kiwi-sourcing-1.0.4.zip`，也可通过 `scripts/package.sh <新ZIP路径>` 指定新目标。已存在目标会被拒绝，不覆盖旧包。显式 package manifest 当前包含 connector 元信息、MCP 配置、图标、README、Skill 与 allowlisted Runtime；`PACKAGE-SHA256.json` 固定包内 39 个 payload 文件的尺寸和摘要。测试与原始研究材料不打包。

副本离线验证包括 READY observer 对应的 13 工具契约、tree/pointer/lock 检查及格式 3 树摘要回归。离线测试不访问 npm，也不代替 WorkBuddy host 测试。

## 尚未验收的业务与发布范围

本地专家成功执行的是只读搜索；候选价格仍待询价。向商家询价、报价比较、磋商、接受协议、handoff/approval、下单、订单或库存变更、付款均未在本次验证中执行，不能据此宣称这些业务流程已验收。连接器也不证明真人授权语义或 Kiwi 后端预算、范围策略。

提交此候选到平台不代表审核通过。WorkBuddy 宿主的其他协议版本协商、完整升级/回滚、灰度及紧急下架流程也未由本次只读搜索覆盖。平台版本和审核状态以提交当时的实际平台结果为准。
