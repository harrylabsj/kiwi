# @harrylabsj/kiwi-dsh-plugin

Kiwi Buyer plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（`dsh`，Everything is a Plugin）。一条命令装好 kiwi 的采购能力：

```bash
dsh plugin --profile web add @harrylabsj/kiwi-dsh-plugin
```

装完重启 `dsh web` 并开**新会话**，模型即可看到 9 个 `mcp__kiwi__*` Sourcing Tools
和 `kiwi-buyer` skill。

## 它装了什么

插件包 = **bundle patch + host 插件**：

1. **MCP 插件**（`cordis.patch.yml` → `@deepseek-ai/dsh-mcp-client`）：把
   `kiwi mcp serve`（kiwi-buyer-mcp）挂成 DSH 的 MCP 插件，工具以
   `mcp__kiwi__<name>` 暴露：

   | DSH 工具名 | 作用 |
   |---|---|
   | `mcp__kiwi__kiwi_search` | 发现候选供应商（读） |
   | `mcp__kiwi__kiwi_request_quotes` | 发起询价（写，幂等） |
   | `mcp__kiwi__kiwi_get_task` | 任务状态/报价/审批/过期（读） |
   | `mcp__kiwi__kiwi_negotiate` | CounterOffer / 澄清（写） |
   | `mcp__kiwi__kiwi_accept_agreement` | 接受非绑定协议（写，ASK） |
   | `mcp__kiwi__kiwi_get_agreement` | 读协议 + digest + 审计（读） |
   | `mcp__kiwi__kiwi_handoff` | 生成成交入口（写，ASK） |
   | `mcp__kiwi__kiwi_approve` | 批准持久审批（写） |
   | `mcp__kiwi__kiwi_reject` | 拒绝持久审批（写） |

2. **SKILL**（`lib/index.js` → `ctx.skills.registerProvider`）：注册 `kiwi-buyer`
   skill，教模型**何时用 kiwi、怎么构造合法 CommerceIntent**（避免
   `contract_violation`）、审批流程与错误处理。

## 前置与覆盖配置

- 运行时经 `npx -y @harrylabsj/kiwi@latest` 启动，**无需**全局安装 kiwi
  （`@latest` 强制重解析最新，绕开 npx 对旧版本的缓存）。
- 环境变量覆盖（在 dsh 进程环境里设置，父进程 env 透传给 kiwi 子进程）：

  | 变量 | 默认 | 作用 |
  |---|---|---|
  | `KIWI_MCP_DB` | `~/.kiwi/mcp/dsh.sqlite` | kiwi-buyer-mcp 持久 store（task/approval）。**需 kiwi ≥ 0.7.19**（0.7.19 起 `mcp serve` 支持该 env 默认路径）；旧版缺省为 cwd 相对的 `.kiwi/mcp/state.sqlite` |
  | `KIWI_PRINCIPAL` | `dsh:<用户名>` | Principal 身份（建议按用户区分） |
  | `KIWI_BUYER_AGENT` | `buyer-agent:kiwi-mcp` | 买家 agent 标识 |

- 代理/内网环境（Clash fake-ip 把 merchant 域名解析成 `198.18.0.0/15` 保留网段）
  需给 `mcp-kiwi` 行的 args 追加 `--a2a-skip-dns-check true`（见下方）。

## 覆盖默认配置

dsh 的 profile `cordis.patch.yml` 按 id **整体替换**（非 deep-merge）。要改
`mcp-kiwi` 行（如加 `--a2a-skip-dns-check`，代理环境），在
`~/.dsh/profiles/web/cordis.patch.yml` 写（静态值，dsh patch 不支持 `!!js` 于
args 数组）：

```yaml
- override:
    - id: mcp-kiwi
      config:
        serverName: kiwi
        transport: stdio
        command: npx
        args:
          - '-y'
          - '@harrylabsj/kiwi@latest'
          - 'mcp'
          - 'serve'
          - '--a2a-skip-dns-check'
          - 'true'
        cwd: ''
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

## 验证

```bash
dsh plugin --profile web list                      # 应出现 @harrylabsj/kiwi-dsh-plugin
dsh --profile web --dump-config | grep -A 20 mcp-kiwi   # mcp-kiwi + kiwi-dsh-plugin 两行
pgrep -af "mcp serve"                              # kiwi mcp serve 子进程存活
```

## 角色边界

DSH 只当 Host Agent；kiwi 的商务权威在 kiwi 侧（Buyer Core + DelegationPolicy +
Persistent Approval + KNP 状态机，`kiwi mcp serve` facade 内置五层授权 deny 优先）。
`accept_agreement` / `handoff` 默认 ASK（返回 `approval_required`），payment 恒
NEVER。详见 `../../hosts/deepseek-harness/README.md`。

## 开发

```bash
npm run validate   # prepack 门：manifest 形态 / 文件齐备 / patch 行 / 宿主导出 / 技能正文
# 本地安装验证：
dsh plugin --profile web add link:$PWD
```
