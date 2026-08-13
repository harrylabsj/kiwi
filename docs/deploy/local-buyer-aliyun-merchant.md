# 部署：本地 Buyer ↔ 阿里云 Merchant + shopping-cli

发布包（2026-08-14）：npm `@harrylabsj/kiwi@0.7.5`、PyPI `shopping-cli==3.2.0`、
`kiwi-catalog==0.2.1`（未变）。本文把"本地跑 buyer、服务器跑 merchant + shopping-cli"
落到可复制命令。

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
