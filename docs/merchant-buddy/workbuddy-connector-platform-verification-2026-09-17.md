# WorkBuddy 已发布 Kiwi 连接器核验：设计 §8.3 / WP3

核验日期：2026-09-17。方式：已登录的 WorkBuddy 开放平台、WorkBuddy 5.5.6 客户端官方市场分发文件，以及本次重新下载的官方分发包交叉核验。未上传更新包、未提交审核、未修改买方包。

**核验后的产品决策（2026-09-17）**：用户已确认保留现有买方连接器，新增独立商家连接器；商家第 0/1 版共用该商家连接器。本文保留核验当时的事实与单连接器迁移问题作为历史记录，下文关于“WP3 买方包迁移门槛”的描述不再阻塞本轮商家交付。最新方案见[第 1 版设计](../v1-product-flow-and-onboarding-design.md)和[商家连接器发布计划](generic-merchant-connector-release-plan.md)。

## 结论

真实 `source` 为 **`kiwi-sourcing`**，连接器类别是 **MCP**，当前传输是 **本地 `stdio`**，由 `npx @harrylabsj/kiwi@0.8.0 mcp serve` 启动；分发配置没有 OAuth、远程 URL、Token 表单或 Authorization 注入。

平台存在该连接器**原 ID 的“更新版本”入口**。这证明可对原资产提交版本更新，但尚不证明更新校验允许同一 `source` 从 `stdio` 迁移到远程 `streamableHttp` 并新增 OAuth。公开文档未明确承诺这类跨传输/认证迁移；本次没有用上传新包来试探校验。因此 §8.3 的“现状调查”已完成，“跨传输升级兼容性”仍待确认，**不能据此把 WP3 买方包迁移标记为已放行**。

## 1. 平台发布记录与更新入口

在[连接器管理页](https://open.workbuddy.cn/connector/all)实际看到“Kiwi 采购询价”公开发布 v1.0.0。页面自身读取的 `GET /api/v2/open-platform/capabilities/oc_bd73f860e3e2b5d3` 返回以下非敏感字段：

| 字段 | 实测值 |
| --- | --- |
| `assetId` | `oc_bd73f860e3e2b5d3` |
| `capabilityType` | `connector` |
| `name` | `kiwi-sourcing` |
| `visibleScope` | `ALL` |
| `publishedVersion.versionId` | `310` |
| `publishedVersion.version` | `1.0.0` |
| `publishedVersion.status` | `published` |
| `pendingVersion` | `null` |
| `fieldsVersionId` | `310` |

点击该卡片“更新版本”后进入：

```text
https://open.workbuddy.cn/connector/publish/oc_bd73f860e3e2b5d3?action=republish&step=1
```

页面是“配置连接器 → 确认信息 → 提交审核”的原资产更新流程，第一步要求上传 ZIP。只查看该页面，未上传文件。页面自身的详情响应不包含原包 `mcp.json`，因此以下传输与认证事实另由官方分发包核实，未把平台 `name` 字段直接猜成 `source`。

## 2. 官方分发包中的实际配置

来源：[WorkBuddy 官方连接器分发包](https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip)。本次重新下载约 20.6 MB 的 ZIP，SHA-256 与客户端 `.connectors-marketplace.meta.json` 记录完全一致：

```text
ETag: d00a927ec121e870350eda10c0c642fb
SHA-256: 696b15a8548b8ea17ef6965f928f74295550882e832ed47b5cb597398c840a47
Last-Modified: Thu, 17 Sep 2026 05:25:20 GMT
```

分发索引 `.codebuddy-connector/connectors.json` 中该条目的 `id` 与 `source` 都是 `kiwi-sourcing`，`type=mcp`、`version=1.0.0`、`minWorkbuddyVersion=5.0.0`，没有 `auth_mode` 字段。

`connectors/kiwi-sourcing/mcp.json` 原始内容：

```json
{
  "mcpServers": {
    "kiwi-sourcing": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@harrylabsj/kiwi@0.8.0",
        "mcp",
        "serve",
        "--principal",
        "workbuddy:local",
        "--agent",
        "buyer-agent:workbuddy",
        "--a2a-timeout-ms",
        "15000"
      ],
      "runtime": { "type": "node", "version": "22" },
      "timeout": 30000
    }
  }
}
```

鉴权结论限定于 **WorkBuddy → 本地 MCP 这一连接层**：它依靠宿主启动本地进程，不是远程 OAuth 连接。不能把 `auth_mode` 省略单独解释为“已接 OAuth”；该包也没有远程 URL、请求头、Token 环境变量或配套 `token-schema.json`/`cli.json`。买方运行时内部的业务授权/审批规则仍然存在，不能因连接层无 OAuth 而删除。

分发 Skill 的 `allowed-tools` 明确列出九个工具：`kiwi_search`、`kiwi_request_quotes`、`kiwi_get_task`、`kiwi_negotiate`、`kiwi_accept_agreement`、`kiwi_get_agreement`、`kiwi_handoff`、`kiwi_approve`、`kiwi_reject`。本次未启动该 npm 版本读取运行时 `tools/list`；仓库新增的关注工具不能仅凭本地源码就声称已包含在已发布版本中。

## 3. 对 WP3 的具体影响

1. **保持资产身份**：目标继续使用 `assetId=oc_bd73f860e3e2b5d3`、`source=kiwi-sourcing`、MCP server key `kiwi-sourcing`。不要改用尚未发布的 `kiwi-merchant` source 或单商家 Veyquo 包。
2. **迁移属于运行位置与身份体系变化**：目前买方进程在每个用户电脑上启动；远程化后必须按真实用户身份隔离任务、审批、协议和审计。当前固定 `--principal workbuddy:local` 与 `--agent buyer-agent:workbuddy` 不能直接作为共享远程服务的全体用户身份。
3. **保留已发布买方契约**：以分发包和固定 npm 版本为基线核对九工具的输入/输出、任务恢复、幂等与审批语义。现有本地任务和审批不会因更新连接器自然出现在远程服务中，需明确旧任务继续办理/迁移方式，不能承诺无缝恢复。
4. **OAuth 是新增连接体验**：目标远程方案需为买家建立真实主体、最小买方权限，再按需增加商家目录权限；不能要求买家注册商家或授予商家权限。若沿用 source，按官方回调规则应使用 `workbuddy://workbuddy/mcp/connector%3Akiwi-sourcing/oauth/callback`，不是 `connector%3Akiwi-merchant`。
5. **WP3 包修改门槛保留**：先确定平台接受同一 ID/source 的 `stdio → streamableHttp + OAuth` 更新及存量客户端行为，再修改并提交买方包。当前证据足以排除“已发布包本来就是远程 OAuth”的路线，尚不足以保证直接切包成功。

## 4. 尚需确认的唯一平台迁移问题

可供平台支持答复或后续受控更新校验的精确问题：

> 对已发布 MCP 连接器 `oc_bd73f860e3e2b5d3` / `source=kiwi-sourcing`，能否保持 ID、source 和买方工具名称，在版本更新中把 `mcp.json` 从本地 `stdio + npx` 改为 HTTPS `streamableHttp`，并由新的远程 MCP 服务提供标准 OAuth？现有已安装用户会自动刷新传输配置并触发 OAuth，还是需要断开/重连或重新安装？平台审核/包解析是否限制这种变更？

“存在更新按钮”和“版本号可递增”只能确认一般版本更新。关闭此迁移问题需要平台对上述具体变更的明确答复，或针对同一资产的受控新包解析、预览和存量客户端升级验证。本次只核验，不发外部消息、不上传试验包。

参考：[WorkBuddy 连接器文档](https://open.workbuddy.cn/docs/connector)、[第 1 版设计](../v1-product-flow-and-onboarding-design.md)。
