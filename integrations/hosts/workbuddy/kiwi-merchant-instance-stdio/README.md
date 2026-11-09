# Kiwi 商家实例 stdio 适配器（WorkBuddy 构建候选）

状态：**本地候选，未提交 WorkBuddy、未做平台实测**。只读；不经过 kiwi-hk 共享网关。

## 使用

```bash
# 1. 商家本人在受控页面绑定唯一实例并完成 OAuth PKCE
kiwi-workbuddy-adapter setup
# 打开输出的 127.0.0.1 地址，输入实例 HTTPS /mcp 与分享凭据

# 2. 查看绑定/授权状态（不显示 token/sharecode）
kiwi-workbuddy-adapter status

# 3. WorkBuddy 配置本机 stdio（见 mcp.json）
kiwi-workbuddy-adapter serve
```

`setup` 只监听本机随机端口；分享凭据仅进入本机加密 token store（0600，密钥文件 0600），用于门禁请求和续期，不进入模型/stdout/日志。OAuth discovery/register/token 都带 `X-Share-Code`；浏览器授权 URL 仅按需带 `sharecode` query。默认只申请 `merchant:read`；只有实例声明支持且商家本人勾选时才申请 `merchant:owner`。

## 边界

- 只访问 `setup` 时绑定的固定实例；工具不接受 URL/merchant_id 参数。
- 只读工具：连接状态、运营报告、磋商列表/详情、只读对话；不提供写工具。
- `serve` 未绑定/未授权时退出 2，不会回退到共享网关或任意 URL。
- token 过期用 refresh token + 已加密的分享凭据续期；`logout` 尝试撤销本次 access+refresh 并清除本地存储，不撤旧授权。状态写入有数据目录级跨进程锁：锁内读取最新绑定/token、判断过期、执行一次有界 refresh 并保存；浏览器授权等待不持锁；崩溃遗留锁 fail-closed，不按 TTL 删除。
- 需 WorkBuddy 平台确认 stdio 包分发、命令解析和工具清单刷新；当前只是构建候选。
