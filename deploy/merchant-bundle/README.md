# deploy/merchant-bundle — Kiwi Merchant 配套实例部署包（V2 阶段一）

一个商家一个配套运行实例：Kiwi Merchant（A2A 接待 + MCP 管理）+ shopping-cli（数据引擎）+ 持久数据卷 + 服务托管单元 + 版本锁。

## 部署拓扑（阶段一：单活）

```text
客户 AI Agent ──HTTPS/A2A──▶ 反代（Caddy/Nginx，自有 TLS）
                                │
                                ▼
                kiwi merchant runtime start（管理进程，自动重启）
                     ├─ a2a：kiwi merchant start --no-chat（接待）
                     └─ mcp：kiwi merchant mcp serve（OAuth 管理入口）
                                │
                                ▼
                shopping-cli（商品/库存/交期权威源）

WorkBuddy Buddy ──OAuth/MCP──▶ MCP 管理服务（查看/控制长期运行实例）
```

- **单活 + 自动重启 + 持续备份**：runtime manager 前台监控受管子进程，异常退出按退避自动重启；systemd `Restart=always` / launchd `KeepAlive` 托管管理进程本身。持续备份走 `merchant-runtime/jobs.ts` 的 backup 接缝（实现留阶段四）。
- **主备 + fencing 租约切换留阶段四**（设计说明）：同一状态目录只允许单 owner 写入（V2 §5.3），不提前引入双活。届时设计：主备两实例各自持完整数据副本（持续备份回放或文件级复制），外部健康探测发现主实例失效后，备实例先获取 fencing 租约（租约文件 + 过期时间 + 写入方身份，过期才允许接管）再启动写路径，杜绝双实例同时报价；租约与 fencing 的具体实现届时单独评审，不在本包内。
- 当前备份目标目录为 `data/backups`（runtime CLI 形态）或 `<prefix>/backups`（bundle 形态）；生产建议把备份目录放到独立卷/远端（防范整盘故障），恢复演练定期执行（`restoreBackup` 按 manifest sha256 校验，不完整拒绝恢复）。
- **生命周期解耦**：WorkBuddy 关闭/退出不停止已部署的接待服务；暂停接待、商品下架、停数据引擎、撤销连接器授权是四个独立动作。

## 目录布局

```text
<prefix>/
├── app/            # Kiwi 部署物（dist/；安装器不复制，由部署流程放置）
├── config/         # install.json、服务单元（systemd/launchd）
├── data/           # 状态目录（单 owner 写；state.sqlite / a2a / oauth.sqlite / capability-probe.json）
├── run/            # pid 文件
├── logs/           # 服务日志
└── backups/        # 持续备份目标（阶段四）
```

## 安装器

```sh
node deploy/merchant-bundle/install.mjs --prefix /srv/kiwi-merchant --confirm-new-instance \
  [--shopping-bin /usr/local/bin/shopping] [--dry-run]
```

fail-closed 行为：

- 新实例必须显式 `--confirm-new-instance`；
- 检测到已有安装（`data/` 非空或 `state.sqlite` 存在）→ 拒绝安装，**绝不新建空库替代已有安装**；升级路径留阶段四；
- shopping-cli 版本不在已验证范围（`>= 2.0.0 < 3.0.0`，见 `versions.lock.json` 与 `src/product-compat.ts` 单一来源）→ 拒绝安装；
- `--dry-run` 只输出布局与版本锁，不写盘。

## 服务托管

- systemd：`config/kiwi-merchant.service`（安装时由模板渲染，含 `__PREFIX__` 替换）；
- launchd：`config/com.kiwi.merchant.plist`（macOS）；
- 两者都托管 `merchant runtime start`（管理进程），由它再管 a2a/mcp 子进程。

## 健康与诊断

- `kiwi merchant runtime status` — 受管进程状态；
- `kiwi merchant runtime health` — 分项健康（进程/商品源/目录可写/磁盘）；
- 商品源能力探测记录：`data/capability-probe.json`（`mcp serve` 启动时刷新）。
