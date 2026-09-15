# WorkBuddy 实机联调检查单（Kiwi Merchant Buddy）

本检查单覆盖无法离线自动化的联调步骤。离线已自动化部分见
`tests/merchant-buddy/`（oauth-e2e / acceptance-groups / stage1/2/4-acceptance）。

## 前置

- staging 部署：`deploy/merchant-bundle/install.mjs` 安装，`kiwi merchant runtime start` 运行；
  MCP 服务 `merchant_mcp.auth_mode: oauth` + `public_url: https://<staging 域名>`。
- 连接器 zip：`package-merchant-connector.mjs --bundle=oauth --out <path>.zip`（token 过渡包用缺省 --bundle=token）。
- Buddy 应用配置：`integrations/hosts/workbuddy/kiwi-merchant-buddy/`（buddy-app.config.json + README）。

## 步骤与预期

### 1. 连接器上架与首次绑定（OAuth）

1. 提交 OAuth 连接器包审核 → 市场可见。
2. Buddy 应用绑定连接器 → 应弹出商家 OAuth 授权页（显示商家名 + merchant:read/write scope）。
   - 预期：同意 → 回调成功；拒绝 → access_denied 且不产生 token。
3. 首次调用 `kiwi_merchant_list_products` → 返回真实目录（白名单字段）。
   - 证据：截图/录屏 + 工具返回 JSON 留存。

### 2. 重连与续期

1. 等待 access_token 过期（1 小时）或重启 WorkBuddy → 再次调用工具。
   - 预期：WorkBuddy 自动用 refresh_token 续期，用户无感知。
2. 服务重启（`runtime stop` → `start`）后已绑定连接仍可用（refresh_token 落盘 oauth.sqlite）。
   - 证据：重启前后同一调用均成功。

### 3. 权限撤销

1. 用户在连接器设置中断开/撤销授权。
   - 预期：服务端 revoke 后工具调用 401；列表/读取全部拒绝。
   - 证据：撤销前后两次调用对比。

### 4. 写闭环两阶段确认

1. `kiwi_merchant_prepare_inventory_update` 登记候选 → 不执行（库存未变）。
2. `kiwi_merchant_execute_approved`（command_id）→ 执行并回读。
3. 重复执行同一 command_id → 拒绝（不重复执行）。
   - 证据：三步的工具返回 + 库存回读值。

### 5. MCP Apps 资源

1. 宿主支持时：resources/list 出现 7 个 `kiwi-merchant://presentation/*` 资源，read 返回 JSON + 文本摘要。
2. 宿主不支持时：仅用工具文本结果完成同等业务（降级不丢字段）。

### 6. 故障演练（staging）

1. 停 shopping-cli → 报价 decline（temporarily_unavailable），能力探测落盘报告不可用，不演示价接待。
2. 停 A2A（runtime stop a2a）→ 管理入口 `kiwi merchant runtime start`/restart 恢复。
3. 备份恢复演练：备份 → 删除状态目录 → 恢复 → 磋商记录完整（RPO=0）。

### 7. 证据留存

- 每步留存：操作时间（UTC）、输入、返回 JSON/截图、预期/实际对比。
- 归档到发布申请附件；平台审核问题逐条回填到本检查单。

## 版本组合（联调基线）

见 `deploy/merchant-bundle/versions.lock.json`（kiwi 0.8.0 / shopping-cli >=2.0.0 <3.0.0 / WorkBuddy >=4.24.0）。
