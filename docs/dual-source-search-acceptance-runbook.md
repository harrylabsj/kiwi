# 双来源搜索 · 两端验收 runbook

版本：v0.1（2026-09-25）
依据：《Kiwi-Buyer 双来源搜索设计文档 v1.1》§12/§19；场景清单 `tests/fixtures/dual-source-search-cases.json`
状态：两端均已实测（Hermes 证据见 §4，WorkBuddy 证据见 §3）；C 可收口。

---

## 1. 验收对象与版本

| 对象 | 本次验收使用的形态 | 说明 |
| --- | --- | --- |
| 运行时 | `~/coding/kiwi` 本地构建（`dist/cli.js`，package.json 0.11.0 未发布） | 只在此形态提供 `network_search` / `products`；发布后由 pin 升级切到线上版本 |
| Hermes 插件 | `~/coding/hermes-plugin-kiwi`（分支 `feat/dual-source-search`）拷贝到 `~/.hermes/plugins/kiwi` | 测试副本的 `mcp.json` 临时指向本地构建；仓库内仍是 pin `@harrylabsj/kiwi@0.8.0` |
| WorkBuddy 专家 | 仓库源码 `integrations/hosts/workbuddy/kiwi-procurement-expert`（v1.1.0） | 尚未打包提交平台；本机安装副本仍是 1.0.0（旧依赖写法） |

## 2. Hermes 验收步骤（可复现）

```sh
# 2.1 准备：插件副本 + 运行时指向
cp -R ~/coding/hermes-plugin-kiwi ~/.hermes/plugins/kiwi
#    把 ~/.hermes/plugins/kiwi/mcp.json 的 args 改为
#    ["/Users/jianghaidong/coding/kiwi/dist/cli.js","mcp","serve"]   ← 仅测试用
hermes plugins enable kiwi --no-allow-tool-override

# 2.2 后端直连预检（不经过 LLM，验证字段形状）
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kiwi_search","arguments":{"query":"保温杯"}}}' \
 | node ~/coding/kiwi/dist/cli.js mcp serve

# 2.3 会话级验收（分源编排 + 状态措辞）
hermes -z "只做只读搜索，不要发起询价或调用写工具。只用 mcp__kb__kiwi_search 搜索「保温杯」，
然后按 kiwi-buyer 技能分区展示，并附证据段：network_search 原样 JSON。"
```

**期望观察**

| 检查点 | 通过标准 |
| --- | --- |
| 技能加载 | 会话中能取到 `kiwi-buyer` 技能并按其分区口径作答 |
| 两路工具 | 工具列表同时存在 `mcp__kb__kiwi_search`（Network）与 `web_search`/`web_extract`（互联网） |
| 分源输出 | 回复分「Kiwi Network · 网络内商家」「互联网电商 · 平台商品」两节，互不混排 |
| 状态措辞 | `completed` + `no_match` → 可说「本次没有匹配」；`partial`/`timeout`/`error`/`not_searched` → 一律不得说「没有供应商」 |
| 外部结果 | 带平台名与原始链接；未读取原页面不标「已核实」；不进入 `kiwi_request_quotes` |
| 旧运行时 | pin 0.8.0 时无 `network_search`，回复按「空即无匹配」保守表述，不编造状态 |

## 3. WorkBuddy 验收步骤

**本地预览态已装好（2026-09-26）**：本地专家市场的源目录
`~/.workbuddy/plugins/marketplaces/experts/plugins/kiwi-procurement-expert` 与安装副本
`~/.workbuddy/plugins/cache/experts/kiwi-procurement-expert/1.1.0` 已更新为 v1.1.0，
注册表 `~/.workbuddy/plugins/installed_plugins.json` 的 kiwi 条目指向 1.1.0；1.0.0
目录保留可回滚，注册表备份为同目录 `.bak-20260926`，市场源快照在
`/tmp/workbuddy-backup-20260926/`。**重启 WorkBuddy 后生效。**

**本轮的运行时限制**：已发布连接器 `kiwi-sourcing` v1.0.0 pin 的是
`@harrylabsj/kiwi@0.8.0`，因此**本轮不会出现 `network_search`**——按技能里的「旧运行时」
口径判定（`note` 非空 → 覆盖不完整；空数组且无 `note` → 可说本次没有搜到）。该连接器
`allowed-tools` 只有 9 个工具，专家文本引用的 4 个关注工具（`kiwi_follow_merchant` 等）
在当前环境不存在，关注类行为不在本次验收范围。

前置未知项：**专家会话是否能使用宿主互联网检索/网页读取工具**——包内不能声明（`package.mjs` 禁止 `tools` 键），工作台宿主环境已启用 `agent-browser` / `playwright-cli` 插件，但专家是否可见未实测。

1. 重启 WorkBuddy，打开「Kiwi 采购询价」专家，确认版本为 1.1.0；若仍显示 1.0.0，用上节的备份与市场源回滚后再走平台提交路径。
2. 在专家会话依次走以下提示，逐条对照 §12 判据（清单见 fixture）：

   - 「帮我找 316 不锈钢保温杯，2 个，杭州」→ 期望：Network 与（若有工具）互联网分区展示
   - 「只看 Kiwi Network，找保温杯」→ 期望：只查网络一路，不暗示查过互联网
   - 「帮我比一比刚找到的这些」→ 期望：无 `task_id` 也能比较；页面价/资料价标明性质，不称报价
   - 「跟第一家询价」→ 期望：仅 `inquiry_available=true` 的商家可询价；M0 商家返回 `merchant_inquiry_unavailable` 时如实说明
   - 若会话无互联网工具 → 期望：明确说明「未检索互联网」，不得宣称双来源

3. 记录：是否出现互联网工具、分区是否符合、措辞是否守住「无匹配 vs 查询未完成」的边界。

**C2 已执行（2026-09-26），两条证据：**

1. **客户端 trace（2026-09-21 真实专家会话）**：轨迹显示该会话加载了专家技能（`Skill(kiwi-source-and-quote)`）、**真实调用 `WebSearch` 4 次**并拿到结果，另通过 `workbuddy_request_mcp_connection` 请求连接 MCP（当时连接被跳过，模型如实说明「无法在 Kiwi 上搜索供应商」而非编造商家）。→ **专家会话具备互联网检索工具**（工具可用性属宿主级）。
2. **无头复现（CodeBuddy CLI 2.158.0 + 专家 1.1.0 + 本地运行时 + 桩目录）**：同一套技能文本下，模型同时走通 Network 与互联网两路，输出分源；标注 `page_reference`、声明「未读取原页面不核实」、不评最低价、不生成到手价、明确把外部候选排除出 `kiwi_request_quotes`；主动核对 MOQ（候选 MOQ 10 vs 用户要 2）与硬条件缺口；`network_search` 原样返回 `completed + has_candidates` 并被正确解读为「不等于已满足全部硬条件」；写工具调用 0 次。两次权限被拒的中间运行中，模型**拒绝编造 `network_search`**，并把「工具被拒」正确映射为 `not_searched + undetermined` 且声明「不是无匹配」。

**保留**：桌面端专家面板的新鲜会话未实操（工具可用性由 trace 佐证）；如需在面板复核，按上面 5 条提示走一遍即可。

### 3.1 无头 CLI 路线（可由助手执行，免手动点界面）

WorkBuddy 客户端自带无头 CLI（`-p` 打印模式 + `--channels` 加载插件/专家）：

```sh
CB="/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
"$CB" -p "<提示>" --channels plugin:kiwi-procurement-expert@experts --output-format text
```

**前置**：该 CLI 的登录态与桌面端**各自独立**，需先登录一次——直接运行 `"$CB"`，在交互提示里执行 `/login`。
本机实测（2026-09-26）：未登录时返回 `Authentication required. Please use /login command to sign in`；登录后上面的命令即可承载 §3 的五条提示词，输出可直接判读。

**本机已就绪的形态（2026-09-26）**：`~/.local/bin/codebuddy`（2.158.0，已登录）；本地专家市场 `experts` 已加入该 CLI 并安装 `kiwi-procurement-expert@experts` 1.1.0。
**无头跑专家（只读白名单 + 桩目录，无外部副作用）**：

```sh
# 1) 桩 catalog（响应受 /tmp/cbc-scratch/catalog-mode.txt 控制：candidates | hang | error）
node /tmp/cbc-scratch/stub-catalog.mjs &
# 2) 一次只读专家会话
~/.local/bin/codebuddy -p "<§3 的提示词>" \
  --channels plugin:kiwi-procurement-expert@experts --agent kiwi-procurement \
  --mcp-config /tmp/cbc-scratch/kiwi-mcp.json \
  --tools "WebSearch,WebFetch,Read,ToolSearch,Skill,DeferExecuteTool,WaitForMcpServers" -y \
  --output-format text
```

注意：`--allowedTools` 不足以放行 MCP 调用（要经 `DeferExecuteTool`）；桩目录是为了不触碰真实商家（否则专家有权限时会真的发起询价）。

## 4. 本次实测记录（2026-09-25，Hermes）

- **会话 1（pin 0.8.0）**：技能被读取并按新口径编排；实际调用 `kiwi_search` + `web_search`，产出分源结果（Network 空 + 互联网 3 条，均带平台与链接与「不能当报价」免责）；`network_search: 无`（旧运行时符合预期）。
- **会话 2（本地构建）**：`network_search` 原样返回：

  ```json
  {"source":"kiwi_network","status":"completed","result_state":"no_match","searched_at":"2026-09-25T13:40:32.207Z",
   "components":[{"name":"listings","status":"completed"},{"name":"agents","status":"completed"},
                 {"name":"merchant_publications","status":"completed"}],"notes":[]}
  ```

  回复严格按 `completed + no_match` 的措辞作答，并显式声明「不代表网络不可用、不代表超时或失败」。
- **后端直连预检（生产目录）**：`保温杯` → 1 个商家（`products[0]` 含 `title`/`category`/`price.kind=to_be_quoted`/`lead_time_hint`/`basis=merchant_listed`）；`扩展坞`、`办公椅` → `completed + no_match`。三例组件全部 `completed`，无失败被掩盖。

## 5. 已知干扰项与风险

1. ~~**两个 kiwi MCP 源同时在场**~~ **已收敛（2026-09-26）**：`~/.hermes/config.yaml` 的直连 `kiwi-buyer-mcp` 已注释（备份 `config.yaml.bak-20260926`），其参数（`--db` 指向 `~/coding/kiwi/.kiwi/mcp/hermes.sqlite`、`--principal hermes:jianghaidong`、`--agent buyer-agent:hermes`、`--catalog-url`、`--a2a-skip-dns-check`）已移植到插件副本的 `mcp.json`；Hermes 现在只有一个源（工具前缀 `mcp__kb__*`，9 个工具）。同时刷新了 `~/.hermes/skills/kiwi-buyer/SKILL.md`（原为 2026-09-04 的旧副本，不含双来源规则；备份 `.bak-20260926`），并更新了 `kiwi-purchase-execution` 里指向旧前缀的参考文件。**后果**：工具前缀从 `mcp__kiwi_buyer_mcp__*` 变为 `mcp__kb__*`，其它引用该前缀的笔记/提示词需同步。
2. **测试副本的 `mcp.json` 指向本地构建**：`~/.hermes/plugins/kiwi` 是拷贝，不是仓库；仓库内仍 pin 0.8.0。结束后应删除或还原该副本。
3. **pin 未升级**：线上用户（插件目录安装）仍是 0.8.0，看不到 `network_search`；升级属发布流程（工作包 D）。
4. ~~**WorkBuddy 互联网工具未知**~~ **已确认可用（2026-09-26）**：客户端 trace 显示专家会话真实调用过 `WebSearch`；无头复现也走通两路。设计 §15 的「共享互联网适配器」不必启动。
5. **`hermes plugins validate` 的既有告警**：`skill:kiwi-buyer: metadata must map string keys to string values`（`metadata.hermes.tags` 是数组），本次改动未引入，未处理。
