# DeepSeek Harness（`dsh`）接入 —— Kiwi 作为 MCP 插件

DeepSeek Harness 是 DeepSeek 官方的 Agent 框架（`deepseek-ai/deepseek-harness`，
CLI `dsh`，**Everything is a Plugin**，基于 Cordis 插件微内核）。模型、工具、技能、
会话、沙箱、Agent loop、甚至 Web UI 都是插件。Kiwi 作为**插件**进入 harness：把
`kiwi mcp serve`（kiwi-buyer-mcp，9 个 Sourcing Tools）挂成 DSH 官方的 MCP 插件
（`@deepseek-ai/dsh-mcp-client`）。

这与 Hermes/OpenClaw 接入同构：**DSH 当 Host Agent，kiwi 的商务权威仍在 kiwi 侧**
（Buyer Core + DelegationPolicy + Persistent Approval + KNP 状态机，`kiwi mcp serve`
facade 内置五层授权 deny 优先）。插件持有的是"调用工具"的能力，不是"直接写入商务"
的能力。

## 工具命名

DSH 的 MCP 插件把工具注册为 `mcp__<serverName>__<rawName>`。本接入 serverName=kiwi：

| DSH 工具名 | 原始工具 | 作用 |
|---|---|---|
| `mcp__kiwi__kiwi_search` | kiwi_search | 发现候选供应商（读） |
| `mcp__kiwi__kiwi_request_quotes` | kiwi_request_quotes | 发起询价（写，幂等） |
| `mcp__kiwi__kiwi_get_task` | kiwi_get_task | 任务状态/报价/审批/过期（读） |
| `mcp__kiwi__kiwi_negotiate` | kiwi_negotiate | CounterOffer / 澄清（写） |
| `mcp__kiwi__kiwi_accept_agreement` | kiwi_accept_agreement | 接受非绑定协议（写，ASK） |
| `mcp__kiwi__kiwi_get_agreement` | kiwi_get_agreement | 读协议 + digest + 审计（读） |
| `mcp__kiwi__kiwi_handoff` | kiwi_handoff | 生成成交入口（写，ASK） |
| `mcp__kiwi__kiwi_approve` | kiwi_approve | 批准持久审批（写） |
| `mcp__kiwi__kiwi_reject` | kiwi_reject | 拒绝持久审批（写） |

## 配置（写进 `~/.dsh/profiles/web/cordis.patch.yml`）

```yaml
- insert:
    - id: mcp-kiwi
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: kiwi
        transport: stdio
        command: node
        args:
          - <KIWI_ROOT>/dist/cli.js
          - mcp
          - serve
          - --db
          - <KIWI_ROOT>/.kiwi/mcp/dsh.sqlite
          - --principal
          - dsh:<user>
          - --agent
          - buyer-agent:dsh
        cwd: <KIWI_ROOT>
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

- `<KIWI_ROOT>`：本地 kiwi 仓库路径（如 `/Users/<user>/coding/kiwi`）；
  `mcp serve` 对 cwd 敏感（agentDataDir 相对路径），cwd 必须指向仓库根。
- `--catalog-url` 缺省 `https://catalog.kiwi.harrylabsj.com`（公网发现），无需传。
- `--principal` 建议按 DSH 用户区分（`dsh:<user>`）。
- **`--a2a-skip-dns-check true`（代理环境必须）**：Clash fake-IP 代理会把 merchant
  域名解析成 `198.18.0.0/15`（benchmarking 保留网段），A2A 客户端 DNS 复查默认
  fail-closed 拒绝 → "A2A endpoint host ... resolves to a reserved network"。跳过
  DNS 复查即解决（信任 catalog 发布的商家域名；Hermes 集成同配置）。非代理环境可去掉。

完整可复用文件见 [`mcp-servers.cordis.yml`](mcp-servers.cordis.yml)。

## 步骤

```bash
# 1) 验证 mcp server 独立可用（MCP 握手 → tools/list 应列出 9 个工具）
node <KIWI_ROOT>/dist/cli.js mcp serve --db <KIWI_ROOT>/.kiwi/mcp/dsh.sqlite \
  --principal dsh:<user> --agent buyer-agent:dsh

# 2) 把上面的 insert 写进 ~/.dsh/profiles/web/cordis.patch.yml（先备份）

# 3) 确认配置树加载（应出现 mcp-kiwi 行）
dsh --profile web --dump-config | grep -A 16 mcp-kiwi

# 4) 重启 dsh web（必须重启：bundle 插件在加载时生效）
dsh web            # 或在 3080 端口重启现有实例

# 5) 确认运行时子进程被拉起并保持（mcp-client 持连接；kill 后自动重连）
pgrep -af "cli.js mcp serve --db .*dsh.sqlite"
```

然后开一个**新会话**，模型即可看到 `mcp__kiwi__*` 9 个工具（预设锁定于会话创建时，
新插件工具需要新会话）。

## 验证

- `dsh --profile web --dump-config` 出现 `mcp-kiwi` 行（配置树解析成功）。
- dsh 进程下有 `kiwi mcp serve` 子进程持续存活（mcp-client 管理连接）。
- 新会话中模型可调用 `mcp__kiwi__kiwi_search`（试 `kiwi_search("USB-C 扩展坞")`）。

## 角色边界与安全（沿用 Hermes 轨同一套）

- **DSH 只当 Host**：不持有 Commerce token、不拥有 Buyer/商家状态机、无最终写入权。
- 所有候选回到 kiwi 的 DelegationPolicy / Persistent Approval / KNP 状态机形成写入。
- `accept_agreement` / `handoff` 默认 ASK（返回 `approval_required`），用户确认后
  才 `kiwi_approve`；payment 恒 NEVER。
- CommerceIntent 最小披露：只投影完成交易必需的字段，用户邮箱/地址/聊天/Host
  Memory 一律不得进 intent。
- 未给 `--policy` 时用内置安全默认（读 AUTO、accept/handoff ASK、payment NEVER）。

完整使用说明（触发、intent 构造、授权、错误处理、演示）见 [`SKILL.md`](SKILL.md)，
与 Hermes 的 kiwi-buyer skill 同源，工具名改为 DSH 的 `mcp__kiwi__*` 前缀。

## 与「受限 ReasoningBackend」用法的区别

kiwi 仓库另一处 `integrations/harnesses/deepseek-harness/`（contract gate）是把
harness **当受限推理后端**验证 DecisionCandidate 契约（无写权）——那是 Kiwi↔Harness
的**契约验证面**。本文件是 harness 作为 **Host Agent 平台**让 kiwi 以 MCP 插件进来，
与 Hermes 轨同构。二者不冲突，方向相反。

> 开发预览提示：dsh 为 developer preview（0.1.0-rc.x），插件 manifest 建议 pin
> `harness-schema-version`；插件包 `@deepseek-ai/dsh-mcp-client` 随 dsh 安装自带。
