# 部署：本地 Buyer ↔ 阿里云 Merchant + shopping-cli

发布包（2026-08-14）：npm `@harrylabsj/kiwi@0.7.5`、PyPI `shopping-cli==3.2.0`、
`kiwi-catalog==0.2.1`（未变）。本文把"本地跑 buyer、服务器跑 merchant + shopping-cli"
落到可复制命令。

## 设计理念（Data Flow & Responsibility Boundary）

Kiwi 是"任何 AI Agent 都可调用的开放询价、采购与商业磋商层"。职责边界严格划分：

```
本地（host 侧）                            阿里云服务器（supply 侧）
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ 宿主 Agent：hermes / openclaw│        │ kiwi-catalog（发现/路由索引）  │
│ / 其他通用 Agent              │        │   catalog.kiwi.harrylabsj.com │
│        │                     │        └──────────┬───────────────────┘
│        ▼                     │  catalog 发现      │
│  kiwi buyer（kiwi-buyer-mcp）│ ──────────────────▶│
│        │  A2A/KNP 直连磋商    │                   │
│        └─────────────────────┼────▶ kiwi merchant │
│                              │        │ 唯一可直接调用 │
│                              │        ▼              │
│                              │   shopping-cli        │
└──────────────────────────────┘   （真实商品/库存数据）┘
```

**核心不变量**：
- **宿主本地**：kiwi buyer（`kiwi-buyer-mcp`）跑在 host 侧，宿主为 hermes、openclaw
  及其他通用 AI Agent。buyer 提供 7 个高层 Sourcing Tools（`kiwi_search` /
  `kiwi_request_quotes` / `kiwi_get_task` / `kiwi_negotiate` / `kiwi_accept_agreement` /
  `kiwi_get_agreement` / `kiwi_handoff`）。
- **只连 catalog 做发现**：buyer 经 `catalog.kiwi.harrylabsj.com`（公网入口）做商家
  发现与路由 —— `/v1/listings/search` 商品搜索 + `/v1/agents/search` 商家身份/
  Agent Card。buyer **不直连 shopping-cli**。
- **A2A 直连 merchant**：发现后 buyer 直接与 kiwi merchant 经 A2A/KNP 磋商（RFQ →
  报价 → 还价 → 非绑定 Agreement → handoff），不经 catalog 转发消息。
- **只有 kiwi merchant 可直接调用 shopping-cli**：merchant 是 shopping-cli 的唯一
  消费者，经 `KIWI_COMMERCE_URL`（`127.0.0.1:8765`）读真实商品/库存。shopping-cli
  绑 127.0.0.1，对外不可达。
- **服务器跑 supply 侧**：kiwi-catalog + kiwi merchant + shopping-cli 都运行在阿里云
  服务器；merchant A2A 与 catalog 经公网域名（nginx 反代）暴露。

## 架构

```
本地电脑                                  阿里云服务器（公网 IP 假设 1.2.3.4）
┌──────────┐   A2A/KNP（公网）  ┌──────────────────────────────┐
│ kiwi      │ ───────────────▶ │ kiwi merchant start（A2A:PORT）│──┐
│ buyer     │  发现 catalog     │   └─ productSource ─▶ shopping-cli api（127.0.0.1:8765）
│ 0.7.5     │ ──▶ 1.2.3.4:8600 │ kiwi catalog serve（0.0.0.0:8600）│ 商品事实
└──────────┘                   │ shopping-cli（SQLite + CSV 导入） ┘
```

- Buyer 经 catalog（`1.2.3.4:8600`）发现 merchant → 直连 merchant A2A 端口协商。
- Merchant A2A 节点经 HTTP 读 shopping-cli 的 `/products/{sku}`（`KIWI_COMMERCE_URL`）。
- 云安全组放行：`8600`（catalog）、`PORT`（merchant A2A）。

## 入站认证：`KIWI_A2A_AUTH`（设计意图：任何 kiwi buyer ↔ 任何 kiwi merchant）

| 模式 | 行为 | 何时用 |
| --- | --- | --- |
| `none` | 匿名放行（无认证） | 显式可信网络 / 内测 |
| `bearer:<token>` | 预共享 token（**违背开放互操作**——每个 buyer 都要先拿到 token） | 不推荐公开形态 |
| `signature`（推荐，0.7.6+） | **RFC 9421 HTTP Message Signature**：匿名按 T0 放行（任何 buyer 可磋商，无预共享密钥）；签名请求按 keyid→公钥验签（未知 key → 403）；card 发布节点公钥 | 公开 merchant |

**服务器已用 `signature`**：card 的 `securitySchemes["kiwi-signature"]` 携带节点 Ed25519 公钥
（keyid = 广告 origin）。配合 `KIWI_A2A_THROTTLE=1` 反滥用限流。

> 签名认证的信任闭环：merchant 要验签某个 buyer 的签名请求，需要把该 buyer 的公钥
> 放进 merchant 的 trusted resolver（运行时 `resolveA2aSignatureResolver(own, extraKeys)`
> 支持；运营侧 trusted-keys 注册表 / card-fetch 自动解析是后续）。**未配置时**：匿名 buyer
> 照常磋商（T0），未知签名者被 403——设计意图不受影响。

## 阿里云服务器

前置：Node ≥22、Python ≥3.11。

```sh
npm install -g @harrylabsj/kiwi@0.7.5
pip install shopping-cli==3.2.0 kiwi-catalog==0.2.1

mkdir -p ~/kiwi-merchant && cd ~/kiwi-merchant
export SHOPPING_DB_PATH=~/kiwi-merchant/shopping.sqlite

# 1) shopping-cli：建商家 + 导入商品（Adapter SDK / CSV 首条路径）
shopping-cli --db "$SHOPPING_DB_PATH" merchant create --id <mid> --name "<商家名>" --city <城市>
shopping-cli --db "$SHOPPING_DB_PATH" import-csv-excel --file products.csv --merchant <mid>

# 2) shopping-cli 商品 API（merchant 节点读它；0.0.0.0 可选，缺省本机）
shopping-cli --db "$SHOPPING_DB_PATH" api serve --host 127.0.0.1 --port 8765 &

# 3) kiwi-catalog：Agent 发现（外部 buyer 用）
kiwi catalog serve --db ~/kiwi-merchant/catalog.sqlite --host 0.0.0.0 --port 8600 &

# 4) merchant A2A 节点（连 shopping-cli 数据源 + 公网地址 + bearer 认证）
export KIWI_COMMERCE_URL=http://127.0.0.1:8765      # 读 shopping-cli /products
export KIWI_CATALOG_URL=http://127.0.0.1:8600
export KIWI_MERCHANT_TOKEN="$(openssl rand -hex 16)" # catalog 注册 token
export KIWI_A2A_AUTH=bearer:"$(openssl rand -hex 16)" # 公网必配：入站 A2A 认证
export KIWI_A2A_PUBLIC_URL=http://1.2.3.4:PORT       # 对外公告的 merchant 地址
kiwi merchant init --merchant-id <mid> --name "<商家名>"   # 生成 ~/.kiwi/kiwi.yaml
kiwi merchant start --port PORT &

# 5) 发布商家进 catalog（buyer 才能发现）
export SHOPPING_DB_PATH=~/kiwi-merchant/shopping.sqlite
kiwi merchant publish --shopping-cli-merchant <mid>

# 可选：固定公网地址用 systemd / nohup 守护（示例见下）。
```

校验：
```sh
curl -s http://127.0.0.1:8600/v1/agents | head   # catalog 返回商家
curl -s http://127.0.0.1:8765/products/VQ-003     # shopping-cli 返回商品价
curl -s http://1.2.3.4:PORT/.well-known/agent-card.json   # 公网可达（自测需本机代理）
```

## 本地（buyer）

```sh
npm install -g @harrylabsj/kiwi@0.7.5

kiwi buyer init --agent-id <buyer-id>
export KIWI_A2A_CLIENT_BEARER="<与服务器 KIWI_A2A_AUTH 相同的 token>"
export KIWI_CATALOG_URL=http://1.2.3.4:8600

# 交互式 buyer（自然语言描述需求 → 发现 → 询价 → 议价 → Agreement）
kiwi buyer start --catalog http://1.2.3.4:8600
# 或非交互搜索：
kiwi buyer search "保温杯 200 个" --catalog http://1.2.3.4:8600
```

- 出站 bearer：buyer 侧 `KIWI_A2A_CLIENT_BEARER` 必须等于服务器 `KIWI_A2A_AUTH=bearer:<token>`
  的 token 值（`KIWI_A2A_AUTH` 的值是 `bearer:<token>` 整串，token 取冒号后部分）。
- buyer 发现 merchant 后直连 `KIWI_A2A_PUBLIC_URL` 指向的地址（服务器需能从公网访问）。

## systemd 守护（阿里云可选）

`/etc/systemd/system/kiwi-merchant.service`：
```ini
[Unit]
Description=Kiwi merchant A2A node
After=network.target

[Service]
Environment=KIWI_COMMERCE_URL=http://127.0.0.1:8765
Environment=KIWI_CATALOG_URL=http://127.0.0.1:8600
Environment=SHOPPING_DB_PATH=/root/kiwi-merchant/shopping.sqlite
Environment=KIWI_A2A_AUTH=bearer:<token>
Environment=KIWI_A2A_PUBLIC_URL=http://1.2.3.4:PORT
ExecStart=/usr/bin/kiwi merchant start --port PORT
Restart=on-failure
```

## 故障排查

| 症状 | 检查 |
| --- | --- |
| buyer 找不到商家 | catalog 服务 /v1/agents；`kiwi merchant publish` 是否成功；`KIWI_MERCHANT_TOKEN` 一致 |
| buyer 协商 401 | 服务器 `KIWI_A2A_AUTH` 与本地 `KIWI_A2A_CLIENT_BEARER` 的 token 不一致 |
| merchant 报价"商品源不可用" | `curl /products/{sku}`；`KIWI_COMMERCE_URL`；CSV 导入是否成功（merchant_id 归属） |
| 公网连不上 | 云安全组放行 PORT/8600；`KIWI_A2A_PUBLIC_URL` 是否对外可达 |
