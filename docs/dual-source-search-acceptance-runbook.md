# 双来源搜索 · 两端验收 runbook

版本：v0.1（2026-09-25）
依据：《Kiwi-Buyer 双来源搜索设计文档 v1.1》§12/§19；场景清单 `tests/fixtures/dual-source-search-cases.json`
状态：Hermes 一侧已按本文步骤实测通过（证据见 §4）；**WorkBuddy 一侧未实测**（§3）。

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

## 3. WorkBuddy 验收步骤（待执行）

前置未知项：**专家会话是否能使用宿主互联网检索/网页读取工具**——包内不能声明（`package.mjs` 禁止 `tools` 键），工作台宿主环境已启用 `agent-browser` / `playwright-cli` 插件，但专家是否可见未实测。

1. 把专家包安装/更新到 1.1.0（平台提交后）或本地预览态加载 `integrations/hosts/workbuddy/kiwi-procurement-expert`。
2. 在专家会话依次走以下提示，逐条对照 §12 判据（清单见 fixture）：

   - 「帮我找 316 不锈钢保温杯，2 个，杭州」→ 期望：Network 与（若有工具）互联网分区展示
   - 「只看 Kiwi Network，找保温杯」→ 期望：只查网络一路，不暗示查过互联网
   - 「帮我比一比刚找到的这些」→ 期望：无 `task_id` 也能比较；页面价/资料价标明性质，不称报价
   - 「跟第一家询价」→ 期望：仅 `inquiry_available=true` 的商家可询价；M0 商家返回 `merchant_inquiry_unavailable` 时如实说明
   - 若会话无互联网工具 → 期望：明确说明「未检索互联网」，不得宣称双来源

3. 记录：是否出现互联网工具、分区是否符合、措辞是否守住「无匹配 vs 查询未完成」的边界。

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

1. **两个 kiwi MCP 源同时在场**：`~/.hermes/config.yaml` 里有直连 `kiwi-buyer-mcp`（全局安装的 `@harrylabsj/kiwi@0.8.0`，cwd 指向本仓），插件又注册了 `kb`。会话可能任选一套（会话 1 就选了直连那套）。验收前应明确用哪一套，或收敛为单一来源，避免「以为在测新版、其实在用旧版」。
2. **测试副本的 `mcp.json` 指向本地构建**：`~/.hermes/plugins/kiwi` 是拷贝，不是仓库；仓库内仍 pin 0.8.0。结束后应删除或还原该副本。
3. **pin 未升级**：线上用户（插件目录安装）仍是 0.8.0，看不到 `network_search`；升级属发布流程（工作包 D）。
4. **WorkBuddy 互联网工具未知**：若不开放，按设计 §15 记录阻塞并另行设计共享适配器，不得以文案代替能力。
5. **`hermes plugins validate` 的既有告警**：`skill:kiwi-buyer: metadata must map string keys to string values`（`metadata.hermes.tags` 是数组），本次改动未引入，未处理。
