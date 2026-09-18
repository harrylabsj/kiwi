# 商家连接器部署说明：网关与商家实例同机隔离部署

状态：部署说明（2026-09-17）。依据：[商家连接器发布计划](generic-merchant-connector-release-plan.md)、[第 1 版设计](../v1-product-flow-and-onboarding-design.md)。配套资产：`deploy/gateway/`。

**适用范围**：一台服务器上同时运行 **Kiwi 商家连接器网关**（`merchant.kiwi.harrylabsj.com`，Kiwi 运营的共享入口）与**某个商家自部署的 Kiwi Merchant 实例**（如 `veyquo.com`，本文以 Veyquo 为例）。两个域名指向同一 IP，靠反向代理按 Host/路径分流。

**不适用范围**：多商家生产形态下把商家实例与网关长期共置（见 §12）。

---

## 1. 角色、域名与端口

| 角色 | 域名 | 对内监听 | 对外暴露 | 进程 |
| --- | --- | --- | --- | --- |
| 商家连接器网关 | `merchant.kiwi.harrylabsj.com` | `127.0.0.1:9200` | 整站（`/health`、`/mcp`、`/oauth/*`、`/connect/*`） | `kiwi merchant gateway serve` |
| 商家实例 MCP（管理入口） | `veyquo.com` | `127.0.0.1:9100` | **仅 `/admin/*`**（商家写操作人工确认页） | `kiwi merchant mcp serve` |
| 商家实例 A2A（接待） | `veyquo.com` | `127.0.0.1:9000` | 其余路径（买家 RFQ 接待、`/.well-known/agent-card.json`） | `kiwi merchant start` / `runtime` |
| 目录（身份权威） | `catalog.kiwi.harrylabsj.com` | — | Kiwi 运营方维护 | `kiwi-catalog` |

关键约束：**实例的 `/mcp` 与 `/oauth/*` 不经过公网**，只由网关走 loopback 调用；实例的 OAuth 授权服务器对公网不可达，也就不会被误绑成第二个 WorkBuddy 连接器。

## 2. 目录布局与隔离

```text
/opt/kiwi-gateway/            # 网关前缀（OS 用户：kiwi-gateway）
├── app/                      # dist/ + package.json + 生产依赖
├── data/                     # oauth.sqlite（会话/令牌/加密凭据）、gateway/env 关联
├── gateway.env               # 0600：KIWI_CATALOG_CONNECTOR_TOKEN / KIWI_GATEWAY_CREDENTIAL_KEY / 实例内部令牌
└── tenants.json              # 0600：商家实例注册表（无密钥）

/opt/kiwi-veyquo/             # 商家实例前缀（OS 用户：kiwi-veyquo）
├── app/
├── config/profile.yaml
├── data/                     # 实例状态、shopping-cli 私有状态、oauth.sqlite、admin-credentials.json
└── .kiwi/credentials.env     # 0600：KIWI_MERCHANT_TOKEN 等
```

隔离要求：

- **两个不同 OS 用户**，各自 `0700` 前缀；网关用户不得读 `kiwi-veyquo/data`（否则共置失去意义）。
- 两个数据卷独立（`/opt/...` 各自挂载或至少各自目录），备份各自独立。
- 防火墙/安全组：公网只开 443；`9000/9100/9200` 仅 loopback（`ss -ltnp` 应显示全部绑定 `127.0.0.1`）。

## 3. 反向代理（按 Host + 路径分流）

### Caddy

```caddy
merchant.kiwi.harrylabsj.com {
	# 网关：全量放行（/health、/mcp、/oauth/*、/connect/*）
	reverse_proxy 127.0.0.1:9200
}

veyquo.com {
	# 实例的 MCP 与 OAuth 不对公网开放：网关走 loopback 直连
	@closed path /mcp /mcp/* /oauth/* /.well-known/oauth-*
	respond @closed 404

	# 商家写操作人工确认页（必须可达，否则 prepare_* 候选无人批准而过期）
	# 建议再加 IP 白名单 / Basic Auth（Caddy: basicauth）
	@admin path /admin /admin/*
	reverse_proxy @admin 127.0.0.1:9100

	# 其余（A2A 接待、agent card）走 A2A 节点
	reverse_proxy 127.0.0.1:9000
}
```

### nginx

```nginx
server {
	listen 443 ssl http2;
	server_name merchant.kiwi.harrylabsj.com;
	# ssl_certificate / ssl_certificate_key ...
	location / { proxy_pass http://127.0.0.1:9200; proxy_set_header Host $host; }
}

server {
	listen 443 ssl http2;
	server_name veyquo.com;
	# ssl_certificate / ssl_certificate_key ...

	location ~ ^/(mcp|oauth|\.well-known/oauth-) { return 404; }

	location /admin/ {
		proxy_pass http://127.0.0.1:9100;
		proxy_set_header Host $host;
		# 建议：allow <办公网出口>; deny all;
	}

	location / {
		proxy_pass http://127.0.0.1:9000;
		proxy_set_header Host $host;
	}
}
```

注意：不要把 `veyquo.com` 的 `/` 反代到 9100（那会把实例 MCP 重新暴露出去）；也不要把 `catalog.kiwi.harrylabsj.com` 的路径透传到这两个 vhost。

## 4. 网关配置

```sh
# /opt/kiwi-gateway/gateway.env（0600，属主与服务用户一致：kiwi-gateway）
KIWI_CATALOG_CONNECTOR_TOKEN=<目录发给的 connector token>
KIWI_GATEWAY_CREDENTIAL_KEY=<凭据加密密钥，高熵>
VEYQUO_MCP_TOKEN=<与实例 KIWI_MERCHANT_MCP_TOKEN 同一个值>
```

`KIWI_GATEWAY_CREDENTIAL_KEY` 缺失时网关**仍会启动**，但依赖加密存储的功能
（第 0 版目录工具、第 1 版实例路由）会被标记为未启用——`--check` 的功能清单会
如实显示，不会静默降级。生成方式：`openssl rand -base64 48`。

`tenants.json` 可以先用空注册表（`{"tenants": []}`）：商家走 `/instance` 页面
**自助绑定**（配对码或粘贴内部令牌），无需运维预置静态配置。

```sh
kiwi merchant gateway serve \
  --public-url https://merchant.kiwi.harrylabsj.com \
  --catalog-url https://catalog.kiwi.harrylabsj.com \
  --host 127.0.0.1 --port 9200 \
  --data-dir /opt/kiwi-gateway/data \
  --tenant-config /opt/kiwi-gateway/tenants.json
```

- 绑定 loopback 时**不需要** `--tls-cert` / `--trusted-proxy`（TLS 由反代终止）；若改为直接对外监听，则必须提供 TLS 材料或显式声明受信代理，否则拒绝启动。
- 商家**自助绑定**有两条路径（登录态打开 `${publicUrl}/instance`）：
  1. **配对码（推荐）**：在实例机器上 `kiwi merchant mcp pair` 生成一次性码（10 分钟、单次），填入页面 → 网关向实例兑换内部凭据并加密保存；
  2. **粘贴内部令牌**：直接填地址 + 令牌，网关探活（initialize + tools/list）通过后保存。
  两条路径都先过同一套 URL 策略；也可由运维用 `tenants.json` 预置（静态配置优先，未命中时查商家自绑）。
- 令牌只经该页面提交（不进对话/模型），落库前 AES-256-GCM 加密；解绑即删除地址与凭据，目录资料不受影响。
- 服务单元见 `deploy/gateway/kiwi-gateway.service.template`（把 `__PREFIX__` / `__PUBLIC_URL__` / `__CATALOG_URL__` 替换后安装）。

## 5. 商家实例配置

```sh
# 实例 env（0600）：只给本机网关使用
KIWI_MERCHANT_MCP_TOKEN=<与 VEYQUO_MCP_TOKEN 同一个值>
```

```sh
kiwi merchant mcp serve \
  --profile /opt/kiwi-veyquo/config/profile.yaml \
  --host 127.0.0.1 --port 9100 \
  --data-dir /opt/kiwi-veyquo/data
```

profile 中：

```yaml
merchant_mcp:
  # 网关路由形态：/mcp 使用静态内部令牌（网关持有同一个值）；
  # 写操作确认页 /admin/* 在两种认证模式下都会挂载。
  auth_mode: token
  token_env: KIWI_MERCHANT_MCP_TOKEN
```

- 为什么是 **token 模式**：网关按 `merchant_id` 路由时需要一个静态内部凭据；而 WorkBuddy 只连网关、不直连实例，实例不需要面向用户做 OAuth。
- 写候选批准仍走实例的 `/admin/*`（会话 + 一次性确认凭证），需先执行
  `KIWI_MERCHANT_ADMIN_PASSWORD=… kiwi merchant mcp admin-passwd` 初始化管理员口令。
- A2A 侧按原有配置（如 `KIWI_A2A_PUBLIC_URL=https://veyquo.com`），由 9000 端口对外接待。

## 6. 目录（kiwi-catalog）侧配置

```sh
KIWI_CATALOG_CONNECTOR_TOKEN=<同一 connector token>
KIWI_CATALOG_CONNECTOR_RETURN_URLS=https://merchant.kiwi.harrylabsj.com   # 只允许网关，不含 veyquo.com
KIWI_CATALOG_PUBLIC_BASE_URL=https://catalog.kiwi.harrylabsj.com           # 连接确认页链接基准
# 可选：KIWI_CATALOG_CONNECTOR_MERCHANT_TOKEN_TTL_SECONDS（缺省 90 天）
```

## 6.1 目录的安装与升级：只用 PyPI 公开发布物

**规则**：服务器上的 kiwi-catalog **只从 PyPI 公开发布版安装**，不在服务器上
`git pull` / `pip install -e` 源码。理由有两条，缺一不可：

1. **与用户拿到的是同一个东西**。PyPI 上的 wheel 就是用户 `pip install kiwi-catalog`
   装到的制品；用源码目录就地安装会让线上跑的代码与公开发布物产生分叉，
   线上问题无法在用户环境复现（反之亦然）。
2. **制品已被发布流程校验过**。wheel/sdist 由 `portfolio-release.yml` 的
   `publish=true` 受保护发布产生，并经 fail-closed 的 `verify-registry` 回读校验；
   源码目录没有这层保证。

kiwi-catalog 自己也这么定位：其 `docs/releasing.md` 写明本仓库是
「portfolio release 的 **PyPI 消费者**」，回滚走「上一个已验证的 tag」，
**不在服务器上直接 `git pull`**。

### 升级步骤

```sh
# 1) 备份（三件套；DB 必须用 sqlite backup API，直接 cp 会漏掉 WAL 里已提交的内容）
TS=$(date +%Y%m%d-%H%M%S)
sudo python3 - "$TS" <<'PY'
import sqlite3, sys, os
ts = sys.argv[1]
src = sqlite3.connect("/var/lib/kiwi-catalog/catalog.sqlite")
dst = sqlite3.connect(f"/opt/kiwi-catalog-backups/catalog.sqlite.bak-{ts}")
with dst:
    src.backup(dst)           # 在线一致快照，包含 WAL 内容
dst.close(); src.close()
os.chmod(f"/opt/kiwi-catalog-backups/catalog.sqlite.bak-{ts}", 0o600)
PY
sudo sh -c "/opt/kiwi-catalog/.venv/bin/pip freeze > /opt/kiwi-catalog-backups/venv-freeze-$TS.txt"
sudo tar czf /opt/kiwi-catalog-backups/kiwi-catalog-src-$TS.tgz -C /opt kiwi-catalog

# 2) 从官方 index 安装（见下方「注意」：本机默认 index 是阿里云镜像）
sudo /opt/kiwi-catalog/.venv/bin/pip install --upgrade \
  --index-url https://pypi.org/simple/ 'kiwi-catalog[api]==<version>'

# 3) 重启服务
sudo systemctl restart kiwi-catalog

# 4) 显式跑一次 schema 迁移（见下方「注意」：重启本身不会迁移）
sudo -u kiwi-catalog /opt/kiwi-catalog/.venv/bin/python - <<'PY'
from kiwi_catalog.db.session import open_connection
conn = open_connection("/var/lib/kiwi-catalog/catalog.sqlite")   # 触发 init_db -> run_migrations
print("schema user_version =", conn.execute("pragma user_version").fetchone()[0])
conn.close()
PY
```

### 注意（两条实测踩到的坑）

- **本机 pip 默认走阿里云镜像**（`mirrors.cloud.aliyuncs.com`），新版本往往滞后数小时
  到数天。升级时必须显式 `--index-url https://pypi.org/simple/`，否则会报
  `No matching distribution found`（镜像上确实没有该版本，不是发布失败）。
- **重启不会自动跑迁移**。服务对 DB 是懒加载：`/health` 不碰库，进程要等到第一个
  **碰库的请求**才会 `open_connection()` → `init_db()` → `run_migrations()`。
  刚重启完直接查 `user_version` 会看到旧值，容易误判成「迁移失败」。生产上请用
  上面第 4 步**显式触发**，可控且可观察。

### 验证清单（升级后）

```text
[ ] curl -s https://catalog.kiwi.harrylabsj.com/health                      → 200
[ ] curl -s http://127.0.0.1:8600/v1/agent-catalog/agents                  → 200（既有读取路径正常）
[ ] PRAGMA integrity_check → ok；user_version → 目标版本
[ ] 既有数据行数与升级前一致（merchants / merchant_accounts / catalog_agents / commerce_listings）
[ ] POST /v1/connector-identity/requests 无 token → 403（fail-closed）
[ ] POST /v1/connector-identity/requests 带正确 token → 不再 403（鉴权通过，进入参数校验）
```

### 回滚

```sh
sudo /opt/kiwi-catalog/.venv/bin/pip install --upgrade \
  --index-url https://pypi.org/simple/ 'kiwi-catalog[api]==<上一个已验证版本>'
sudo systemctl restart kiwi-catalog
```

迁移**只增不减**（`create table if not exists` + `user_version` 门，整链包在 SAVEPOINT 里
原子执行）：旧版本代码不会读新表，因此回滚不需要降级数据库；但如果新版本已写入
新表数据，那些数据在回滚后不可见（保留在库中，再次升级即恢复）。

## 6.2 存活信号（WP6）

| 参数 | 位置 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `KIWI_AGENT_HEARTBEAT_SECONDS` | 商家实例进程 | 300 | A2A 节点向目录上报心跳的间隔；`0` 关闭（关闭后商家会在 TTL 后被判离线） |
| `KIWI_CATALOG_AGENT_FRESH_TTL_SECONDS` | kiwi-catalog | 900 | 读时判定"新鲜"的窗口（60–86400，超范围自动夹取）；**必须显著大于心跳间隔** |

A2A 节点在注册成功后会**立即心跳一次**（不等待首个间隔），随后按上表间隔循环——因此刚上线的商家不会被注册时的验证结论拖成"离线"。缺 owner 凭据时注册会退回匿名自助、心跳返回 403（fail-closed，不会静默）——生产部署必须配置 `KIWI_CATALOG_OWNER_TOKEN_SECRET` 或商家自己的 owner token。

判定是**读时派生**且只降不升：商家服务器下线后，超过 TTL 即不再显示"可实时询价"（公开资料仍可查）；重新上线心跳一次即恢复。治理状态（suspended/rejected）优先，不因心跳复活。

## 7. 凭据清单与轮换

| 凭据 | 持有方 | 作用范围 | 轮换方式 |
| --- | --- | --- | --- |
| `KIWI_CATALOG_CONNECTOR_TOKEN` | 网关 + 目录 | 仅创建/兑换一次性身份授权请求，**无商家数据访问** | 两侧同步改值 → 重启网关 |
| `KIWI_GATEWAY_CREDENTIAL_KEY` | 仅网关 | 加密保管 `cmt_` 目录凭据与实例凭据 | **轮换会使已存凭据失效**：换新值后商家需重新连接一次（旧值建议保留一个维护窗口） |
| `cmt_…`（商家目录凭据） | 网关（密文） | 读写该商家公开资料；发布仍须门户确认 | 重新连接即签发新凭据；`POST /v1/connector-identity/revoke` 可撤销 |
| `KIWI_MERCHANT_MCP_TOKEN` | 实例（+ 运维） | 实例 `/mcp` 的静态入口；网关也可用它绑定（粘贴方式） | 改 env → 重启实例；网关需重新绑定 |
| **配对凭据** `pair_…` | 仅实例签发、网关持有 | 网关 → 该实例的 MCP 调用（配对方式） | 实例上重跑 `kiwi merchant mcp pair` → 网关重新配对即轮换（旧凭据立即失效）；`kiwi merchant mcp unpair` 即吊销 |
| 实例管理员口令 | 商家 | `/admin/*` 登录 | `kiwi merchant mcp admin-passwd`（`KIWI_MERCHANT_ADMIN_PASSWORD` 环境变量传入） |
| WorkBuddy 用户 OAuth token | WorkBuddy + 网关（摘要） | 用户 ↔ 网关 | 平台侧撤销/重连；入口只存摘要 |

## 8. 明确不要做的事

1. 不要让任何 WorkBuddy 连接器指向 `veyquo.com`：实例的 `connectorSource` 与网关同为 `kiwi-merchant`，回调 URI 相同，同 source 的两个连接器会互相干扰。WorkBuddy 只连网关。
2. 不要把实例的 `/mcp`、`/oauth/*` 放进公网路径，也不要用 `https://veyquo.com/mcp` 作为网关的后端地址（同机走 loopback 少一跳暴露面）。
3. 不要把实例的 `/v1` 之类的目录接口透传出去：这两个域名都不承载目录服务。
4. 不要在网关进程里放商家实例的私有状态路径；网关只需要实例的 URL 与内部令牌。
5. 不要让实例域名解析到内网/云元数据地址：网关出站会解析一次并按该 IP 建连（钉住），解析结果落在私网/保留段（含公网域名解析到 `127.0.0.1`）一律拒绝——这是防 SSRF 与 DNS 重绑定的硬门，不是配置项。
5. 不要复用 `deploy/merchant-bundle` 的单商家 OAuth 连接器包指向 Veyquo 实例上架（发布计划 §4 已明确 Veyquo 单实例包不可作为通用商家包）。

## 9. 部署后验收

```sh
# 1) 网关就绪（含实例注册计数与功能开关）
KIWI_CATALOG_CONNECTOR_TOKEN=… KIWI_GATEWAY_CREDENTIAL_KEY=… VEYQUO_MCP_TOKEN=… \
  kiwi merchant gateway serve --public-url https://merchant.kiwi.harrylabsj.com \
  --catalog-url https://catalog.kiwi.harrylabsj.com --tenant-config /opt/kiwi-gateway/tenants.json --check

# 2) 网关公网可达
curl -sS https://merchant.kiwi.harrylabsj.com/health
curl -sS https://merchant.kiwi.harrylabsj.com/.well-known/oauth-authorization-server | jq .issuer

# 3) 实例的 MCP/OAuth 对外不可达、A2A 可达、管理页可达
curl -sS -o /dev/null -w '%{http_code}\n' https://veyquo.com/mcp            # 期望 404
curl -sS -o /dev/null -w '%{http_code}\n' https://veyquo.com/.well-known/agent-card.json  # 期望 200
curl -sS -o /dev/null -w '%{http_code}\n' https://veyquo.com/admin/login    # 期望 200

# 4) 绑定与监听只在内网
ss -ltnp | grep -E ':(9000|9100|9200)'
```

端到端链路（发布闭环 + 自助绑定 + 配对码 + 实例路由 + 租户隔离 + 解绑）用仓库脚本在本地跑：

```sh
bash scripts/v1-merchant-connector-acceptance.sh   # 17 项断言；loopback 形态
```

## 10. 回滚

1. **暂停入口**：反代把 `merchant.kiwi.harrylabsj.com` 改为返回 503（或摘掉 vhost），网关进程可继续运行（已连接商家不受影响，仅无法新建连接）。
2. **停网关**：`systemctl stop kiwi-gateway`。此时：目录里的公开资料**不受影响**（它们存在 catalog），商家的商品/库存/接待**不受影响**（在实例与 shopping-cli 上）。
3. **恢复实例公网可达（仅在需要商家直接用旧入口时）**：把 `veyquo.com` 的 `/mcp` 从 404 改回 9100；但要注意这会重新暴露实例 MCP，且其 OAuth 与网关同 source。
4. **凭据失效处理**：若回滚涉及替换 `KIWI_GATEWAY_CREDENTIAL_KEY`，商家需重新走一次连接流程；`cmt_` 凭据可用 `POST /v1/connector-identity/revoke` 显式撤销。
5. **平台侧**：若新商家连接器已提交审核，回滚前先撤回或标记；不要在连接器指向未验证入口的情况下保留已发布状态。

## 11. 备份与隔离检查清单

- [ ] 网关 `data/oauth.sqlite` 纳入备份（丢失 = 所有商家需重新连接；`cmt_` 凭据密文也在此）。
- [ ] `KIWI_GATEWAY_CREDENTIAL_KEY` 单独备份到密钥库：**只有密文没有密钥等于没有备份**。
- [ ] 实例 `data/` 单独备份（含 shopping-cli 状态与管理页凭据），恢复演练按 `restoreBackup` 的 sha256 校验执行。
- [ ] 两个前缀分属不同 OS 用户、`0700`；网关用户无法读实例数据目录（用 `sudo -u kiwi-gateway ls /opt/kiwi-veyquo/data` 实测应失败）。
- [ ] 三份凭据互不相同（对照 §7 表格逐项核对）。
- [ ] 防火墙只开 443；`9000/9100/9200` 非公网可达（外部探测验证）。
- [ ] `/admin/*` 有额外保护（IP 白名单或 Basic Auth），且管理员口令已初始化（`admin-credentials.json` 存在，0600）。
- [ ] 恢复演练：停网关 → 恢复 `oauth.sqlite` → `--check` → 启动 → 商家无需重新连接即可调用工具（用 `kiwi_catalog_get_merchant_profile` 验证 `connected: true`）。

## 12. 何时必须拆到独立主机

共置意味着**信任域与故障域合并**：网关主机失陷 = 该商家私有状态（订单、底价、库存、审批）一起失陷；网关发版重启期间，Buddy 侧管理操作短暂不可用（A2A 接待不受影响）。因此：

- **可接受**：该商家是试点/演示主体，或与网关同属一个信任域（同一运营方自持）；
- **必须拆开**：接入第二个真实商家之前。届时把实例迁移到独立主机（或至少独立容器 + 独立数据卷 + 独立凭据域），网关只经受控网络/隧道访问 `mcp_url`，注册表把该条改成 `https://<商家域名>/mcp` 即可——**网关侧不需要改代码**。

## 参考

- [商家连接器开发计划](v1-merchant-connector-development-plan.md)
- [商家连接器独立发布计划](generic-merchant-connector-release-plan.md)
- [平台核验记录](workbuddy-connector-platform-verification-2026-09-17.md)
- `deploy/gateway/kiwi-gateway.service.template`、`deploy/gateway/tenants.example.json`、`deploy/merchant-bundle/`（实例侧部署包）
