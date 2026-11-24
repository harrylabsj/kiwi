# 独立部署商家工作台（`kiwi merchant workbench serve`）

面向独立部署的 Kiwi merchant：在商家自己的主机上提供 `/merchant/` 页面与
`/merchant/api/*` 管理 API，复用云端工作台同一份页面/契约。

## 启动

```bash
# 1) 设置本实例 owner 登录口令（只从环境变量读取，不写入 shell history）
KIWI_MERCHANT_ADMIN_PASSWORD='至少 8 位' \
  kiwi merchant mcp admin-passwd --profile ./merchant.yaml

# 2) 启动工作台（缺省 127.0.0.1:9102）
kiwi merchant workbench serve --profile ./merchant.yaml

# 需要对外暴露时显式给公网 origin（同时用于写请求 Origin 校验）
kiwi merchant workbench serve \
  --profile ./merchant.yaml \
  --host 0.0.0.0 --port 9102 \
  --public-url https://merchant.example.com
```

打开 `http://127.0.0.1:9102/merchant/`，会跳到 `/admin/login` 完成本地 owner
登录。目录 `/portal/account` 的「管理报价规则」按钮按活动 runtime binding 的
`runtime_origin` 派生 `https://<origin>/merchant/`，因此独立实例把工作台暴露在
同一 origin 的 `/merchant/` 即可被目录直接链接。

## 能力边界

| 页签 | 独立部署行为 |
| --- | --- |
| 服务状态 | 可用；服务状态/就绪/暂停恢复来自本地运行中 policy 与商品源 |
| 商品 | 只读列表来自 shopping-cli `/search/products`；不装配商品导入 |
| 报价规则 | 可用；读写同一份运行中 merchant policy |
| 待审批 | 可用；与 MCP/管理面同一候选存储 |
| 微信通道 | 店主扫码绑定个人微信；支持连接测试、断开和重绑 |
| 目录连接/接入方式 | 不装配（无云端 onboarding），对应接口 503 |
| 会话旁观/运营报告/商品经营/销售工作台 | 首版不装配，对应接口 503 |

商品上架/下架与有效期仍由目录商家后台 `/portal/account` 管理；工作台只展示
状态，不在本地改写目录发布状态。

## 连接个人微信

云端和独立工作台均可使用。以店主身份登录 `/merchant/`，打开「微信通道」，
点击「生成微信二维码」。用手机微信扫一扫并在手机上确认；如果微信显示数字配对码，
在工作台输入后继续。工作台成功收到微信同步响应才显示「已连接」。此时可在微信中
向机器人发送 `/ping`，收到回复即可确认收发都正常。

- 只响应配对账号的 `/ping`，不接管普通聊天，不通过微信做审批、主动通知或群发。
- 凭证保存在实例数据目录 `weixin-workbench/` 下，按商家隔离，不与 `kiwi weixin` 或
  `kiwi merchant watch` 共用。后台重启后会尝试恢复连接；同一数据目录的同一商家仅一个后台进程可接收消息。
- 「断开连接」会停止同步并删除工作台本地凭证，不会在手机微信中解除原绑定。
  如果微信提示已有绑定，请先在手机上解除原绑定再重试。

## 安全

- 登录复用 `/admin/login`（admin-credentials.json，0600；会话 `kiwi_admin`）。
- 写请求要求会话绑定的 CSRF 头；配置 `--public-url`/`merchant_mcp.public_url`
  时按该 Origin 精确校验。
- 非 loopback 监听不会自动信任任意 Origin；未配置公网 origin 时只允许本机
  `127.0.0.1`/`localhost` 的写请求。
- 报价规则仍走草稿 → 确认流程；底价金额不在 API 响应中回显。
