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

云端和独立工作台均可使用。直接打开本实例的 `/merchant/weixin`，用店主身份登录后会回到该页；也可从 `/merchant/` 的「微信通道」进入。点击「生成微信二维码」，用手机微信扫一扫并确认；如果微信显示数字配对码，在配对页输入。页面成功收到微信同步响应才显示「已连接」。向机器人发送 `/ping` 并收到回复，才能确认收发都正常。

- 默认只响应配对账号的 `/ping`。若实例启用了 `KIWI_WEIXIN_OWNER_REPLIES=1`，新绑定在手机微信确认后就同时授权对该店主账号的规则回信，不需要再点一次。旧绑定、已停止的回信不会自动启用，可在微信通道页手动开启。扫码不授权调用大模型，也不接管普通聊天，不通过微信做审批、主动通知或群发。
- 微信里起草后，可在本实例的 `/merchant/weixin` 登录查看、修改或放弃草稿，无需进入完整工作台。草稿正文不会因打开此页而发到微信；保存或放弃都不会发送给买家。
- 凭证保存在实例数据目录 `weixin-workbench/` 下，按商家隔离，不与 `kiwi weixin` 或
  `kiwi merchant watch` 共用。后台重启后会尝试恢复连接；同一数据目录的同一商家仅一个后台进程可接收消息。
- 「断开连接」会停止同步并删除工作台本地凭证，不会在手机微信中解除原绑定。
  如果微信提示已有绑定，请先在手机上解除原绑定再重试。

## 配置店主对话模型

以店主身份打开「微信通道 → 店主微信对话模型」，选择服务商，填写模型 ID 和本商家申请的 API Key。点击「测试并保存」时，Kiwi 通过 Pi 验证文本回复与询价工具调用，两个测试通过后才保存和立即应用。测试使用合成消息，可能计入模型用量。

密钥加密保存在本商家实例的持久数据目录。再次编辑同一服务商时，密钥框留空可继续使用，填写新密钥可更换。更换服务商时输入对应的新密钥。迁移实例时需要一起迁移模型配置和该实例的模型加密密钥文件。

配置只作用于店主微信对话。保存后，在同页绑定微信并点击「授权 Kiwi 模型对话」。切换模型或更换密钥会撤回原模型授权，已授权的基础回信仍可使用。运行环境显式设置 `KIWI_WEIXIN_OWNER_REPLIES=0` 或 `KIWI_WEIXIN_OWNER_AGENT=0` 时，工作台无法覆盖停用设置。

```bash
kiwi merchant model --profile ./merchant.yaml --data-dir /path/to/merchant-state
kiwi merchant model status --profile ./merchant.yaml --data-dir /path/to/merchant-state
kiwi merchant model test --profile ./merchant.yaml --data-dir /path/to/merchant-state
```

`--data-dir` 须与商家运行时一致。交互向导与工作台使用同一组服务商。命令行交互向导选择服务环境中的密钥变量名。向导在确认后发送两条合成测试请求，通过后才保存。`status` 读取本地配置，`test` 发起合成测试。

通过命令行保存后需重启运行时，并分别设置 `KIWI_WEIXIN_OWNER_REPLIES=1` 与 `KIWI_WEIXIN_OWNER_AGENT=1`。工作台保存的配置在重启后自动加载。

## 安全

- 登录复用 `/admin/login`（admin-credentials.json，0600；会话 `kiwi_admin`）。
- 写请求要求会话绑定的 CSRF 头；配置 `--public-url`/`merchant_mcp.public_url`
  时按该 Origin 精确校验。
- 非 loopback 监听不会自动信任任意 Origin；未配置公网 origin 时只允许本机
  `127.0.0.1`/`localhost` 的写请求。
- 报价规则仍走草稿 → 确认流程；底价金额不在 API 响应中回显。
