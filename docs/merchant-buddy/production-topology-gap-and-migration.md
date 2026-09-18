# 现网拓扑实测与迁移清单（kiwi-hk / 47.243.241.218）

状态：2026-09-18 实测（只读侦察 + 域名切换后复验）。

**目的**：把服务器上**实际跑着什么**记下来，与[部署说明](merchant-connector-deployment.md)的**目标拓扑**逐项对照，给出可独立回滚的迁移步骤。部署说明描述的是"应该长什么样"，本文描述的是"现在长什么样"，两者目前有实质差异。

---

## 1. 现网实测

| 服务 | 前缀 | OS 用户 | 监听 | 对外域名 | 版本 | 职责 |
| --- | --- | --- | --- | --- | --- | --- |
| `kiwi-gateway` | `/opt/kiwi-gateway` | `kiwi-gateway` | `127.0.0.1:9200` | `merchant.kiwi.harrylabsj.com`（2026-09-18 切换） | 0.9.0 | WorkBuddy 商家连接器入口（OAuth + MCP + `/instance`） |
| `kiwi-merchant-v2` | `/home/kiwi-merchant-v2` | `kiwi-merchant` | `127.0.0.1:9000`(A2A)<br>`127.0.0.1:9100`(MCP) | 切换前挂 `merchant.kiwi.harrylabsj.com`；现 A2A 与 `/admin/*` 仍在其上 | 0.8.0 | **商家实例**：`merchant runtime start` 拉两个子进程（`merchant start --no-chat` + `merchant mcp serve`），异常退出自动重启 |
| `kiwi-merchant` | `/home/kiwi-merchant` | `kiwi-merchant` | `127.0.0.1:8700` | **`veyquo.com`** | 0.8.0 | **旧** `kiwi merchant chat`（tmux `while true` 守护，交互式 REPL，自带一份 npm 装的 kiwi） |
| `kiwi-shopping-api` | `/home/kiwi-merchant/venv` | `kiwi-merchant` | `127.0.0.1:8765` | 不对外 | — | shopping-cli 数据引擎，库 `/home/kiwi-merchant/data/veyquo.sqlite` |
| `kiwi-catalog` | 运行于 site-packages（源码目录 `/opt/kiwi-catalog` 已不参与运行） | `kiwi-catalog` | `127.0.0.1:8600` | `catalog.kiwi.harrylabsj.com` | 0.3.0 | 目录（身份权威） |
| `caddy` | — | — | `:80` / `:443` | 三个域名 | 2.11.4 | 反向代理，TLS 终结 |

切换后的 `merchant.kiwi.harrylabsj.com` 分流：

```
/admin /admin/*                          → 实例 9100（写候选人工确认页）
/mcp /oauth/* /connect* /instance* /health
/.well-known/oauth-*                     → 网关 9200
其余（agent card、ucp、A2A 接待）         → 实例 A2A 9000
```

## 2. 与「三套」理解的对照

| # | 你的理解 | 核对结果 |
| --- | --- | --- |
| 1 | 网关，域名 `merchant.kiwi.harrylabsj.com` | ✅ 完全正确 |
| 2 | 服务器上安装了**一套**商家 A2A 7×24 的 kiwi merchant + kiwi 商家端，与 buyer 做 A2A | ⚠️ **大体正确，但"一套"不准确——实际有两套在跑**，见下 |
| 3 | shopping-cli 只被 kiwi merchant 调用 | ✅ 正确（只监听 loopback `8765`；不过**两套** merchant 的配置都指向它） |

**关于第 2 点**：服务器上同时存在两个商家侧 A2A 节点，同属商家 `mkt_veyquo_A0UPvj7XuYk`（Veyquo）：

- **v2**（`9000`）：`kiwi-merchant-v2` 托管，**目录里登记的就是它** ——
  `https://merchant.kiwi.harrylabsj.com/.well-known/agent-card.json`。
- **旧 chat**（`8700`）：`veyquo.com` 指向它，且它也在正常提供 agent card（自述 `https://veyquo.com/`），
  但**没有任何目录指向它** → 对买方不可发现。

**还有一条你没列的下行链路**：商家实例会**直连目录**（profile 的 `catalog_url`、env 的 `KIWI_CATALOG_URL` / `KIWI_MERCHANT_TOKEN`），用于注册与 WP6 心跳。所以不是"只调用 shopping-cli"，而是 `shopping-cli`（数据）+ `catalog`（身份/发现）两条。

## 3. 影响迁移决策的实测事实

1. **两套 A2A 并行，只有一套可发现**。买方经目录找到的是 v2；旧 chat 那套对外可达但无人指向。这既是资源浪费，也是隐患（`veyquo.com` 上挂着一个与目录不一致的商家身份）。
2. **当前几乎没有真实交易流量**。`kiwi-shopping-api` 近 24 小时共 1443 条请求，其中 **1441 条是每 60 秒一次的 `/health` 探测**（来自 v2 运行时的分项健康检查）；非探测请求只有 **4 条**（近 7 天 13 条），全是零星商品读取（`GET /products/VQ-00x`、`GET /search/products`）。`veyquo.sqlite` 的最后写入时间是 **09-04**。→ 现在做迁移，业务影响面很小。
3. **Caddy 没有配置 access log**，journal 里只有 ACME 证书维护记录。**现在无法从日志回答"某域名有多少真实请求"** —— 迁移前后要做流量对比的话，得先把 access log 打开（见 §5 步骤 A）。
4. **旧 chat 不是 systemd 托管的服务**，而是 `tmux` 里的 `while true` 循环。重启语义、日志、退出码都不受 systemd 管理，出问题难排查。

## 4. 与部署说明目标拓扑的差异

| 项 | 部署说明（目标） | 现网实际 | 影响 |
| --- | --- | --- | --- |
| 实例前缀 | `/opt/kiwi-veyquo` | `/home/kiwi-merchant-v2`，且数据引擎在 `/home/kiwi-merchant` | §2 的目录布局与隔离清单不能照用；备份/权限脚本要按实际路径写 |
| 实例对外域名 | `veyquo.com` 承载实例 A2A + `/admin/*` | `merchant.kiwi.harrylabsj.com` 承载（切换后 A2A 与 `/admin/*` 仍在它上面） | §3 的 Caddy 目标配置与现网不一致 |
| `merchant.kiwi.harrylabsj.com` 归属 | 仅网关 | 网关 + 实例 A2A + 实例 `/admin/*` | 本次有意保留两处（见 §1 分流说明），未按文档整体切走 |
| 实例 MCP 认证模式 | `token`（`KIWI_MERCHANT_MCP_TOKEN`） | `oauth` | 网关按 `merchant_id` 路由需要一份凭据；`oauth` 模式下静态令牌路径不通 |
| 实例版本 | 未约定 | 0.8.0（**无 `merchant mcp pair`**） | 配对码自助绑定暂不可用 |
| 单实例前缀原则 | 一个前缀一个 OS 用户 | 实例横跨 `/home/kiwi-merchant-v2` 与 `/home/kiwi-merchant` | "共置隔离"的边界比文档描述的更模糊 |

## 5. 迁移步骤（四步，每步可独立回滚）

### A. 先补观测（低风险，建议先做）

给 Caddy 加 access log，否则后续任何"切换有没有影响流量"的判断都没有依据。

```caddy
# 全局或站点级
log {
	output file /var/log/caddy/merchant-access.log
	format json
}
```

验证：`/var/log/caddy/*.log` 开始出现访问记录。回滚：删掉该段 + `systemctl reload caddy`。

### B. 实例升到 0.9.0（可选，但配对能力依赖它）

现网实例为 0.8.0，没有 `merchant mcp pair`，商家无法用配对码自助绑定。升级方式与网关一致：本地从 npm 包构建 `app/` → 投递 → 重启（沿用这台机器既有的布局惯例）。

风险：实例承载 A2A 接待，升级有停机窗口。回滚：保留旧 `app/` 目录，改回即恢复。

### C. 决定 `8700` 旧 chat 的去留（**关键决策，缺它无法继续**）

- **若确认不再使用**：`systemctl stop kiwi-merchant && systemctl disable kiwi-merchant`，
  并把 `veyquo.com` 从 Caddy 摘掉（或改指实例）。
- **若仍在用**：需要说明用途，再重新规划它的端口与域名，避免与实例的对外身份混淆。

### D. 若要完全对齐文档目标拓扑

把实例的 A2A 与 `/admin/*` 迁到 `veyquo.com`，`merchant.kiwi.harrylabsj.com` 只留网关。这一步必须**同时**做三件事，否则会打断买家发现：

1. 改实例 profile 的两处 `public_url`；
2. 改 Caddy：`veyquo.com` → 9000 + `/admin/*` → 9100；`merchant.kiwi.harrylabsj.com` → 仅 9200；
3. **更新目录里登记的 `agent_card_url`** —— 它会改变买方发现地址，属于对外行为变更，
   需要单独评估（旧地址要不要保留一段重定向、要不要通知已发现该商家的买家）。

## 6. 待决策

| # | 事项 | 为什么需要你定 |
| --- | --- | --- |
| 1 | `8700` 旧 chat 服务还在用吗？ | 决定步骤 C 是"下线"还是"重新规划"；也决定 `veyquo.com` 这个域名要不要保留 |
| 2 | 是否把实例身份迁到 `veyquo.com`？ | 会改变目录登记的发现地址，属对外变更，需要评估与公告 |
| 3 | 实例是否升到 0.9.0？ | 决定配对码自助绑定（第 1 版实例路由）何时可用 |
| 4 | 是否先开 Caddy access log？ | 决定后续所有流量判断有没有依据 |

## 参考

- [商家连接器部署说明](merchant-connector-deployment.md)（目标拓扑）
- [商家连接器独立发布计划](generic-merchant-connector-release-plan.md)
- [实例配对安全设计](merchant-instance-pairing-design.md)
