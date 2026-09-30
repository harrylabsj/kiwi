# 云工作台目录直连与商品发布

0.12.1 候选新增已部署 Runtime 的目录连接入口。候选测试通过不代表线上更新、配对或最终 Buddy 平台配置完成。

## 使用顺序

1. 在同一云应用管理员工作台登录，进入 `/merchant/`，确认商品与导入显示实际文件表商品。
2. 在概览点击「开始连接 Kiwi 目录」，由本人点击查看配对信息，在 Catalog 使用独立测试商家账号登录，核对运行时地址和店铺信息后确认连接及名片发布。配对码不要发送给助手。
3. 工作台状态须为 `published=true`；同时核对 Catalog 当前 ACTIVE 绑定及新鲜名片/心跳。历史 enrollment 或 `/health=200` 不能替代这些证据。
4. 在商品与导入填写显式 SKU 与分类，预览公开名称、SKU、分类及有效期；本人确认后才发布商品。价格、库存、供货私注与凭据不进入公开商品投影。
5. 买家按商品词发现该 listing，使用正确单位与起订量询价，验收报价、磋商时间线和报告。验收停在报价阶段，不创建成交、订单或支付。
6. 同一应用再次部署，核验商家身份、公钥、商品、绑定、磋商和报告保留。

## 接口与安全边界

- `GET /merchant/api/v1/catalog/connect`：默认安全摘要，不含配对码或设备凭据。
- `GET /merchant/api/v1/catalog/connect/pairing`：owner 本人显式查看配对信息；no-store。
- `POST /merchant/api/v1/catalog/connect/begin`：owner 会话、CSRF/Origin、持久幂等回执；结果不确定时先查状态。
- `POST /merchant/api/v1/products/publication-drafts`：只创建公开预览，输入仅显式选择的 SKU/category。
- `GET /merchant/api/v1/products/publication-drafts/<id>`：owner 查看原草稿与脱敏回执。
- `POST /merchant/api/v1/products/publication-drafts/<id>/commit`：owner + CSRF + 冻结摘要 + `confirm_publication:true`，使用冻结 payload/固定幂等键；部分失败保留原草稿续办。

绑定中的 `merchant_id` 仅来自验真的 Catalog binding claim。首签 claim 短期 TTL 不等于长期绑定结束；已发布路径每次使用当次公开重签声明核验。直连与旧部署向导互斥，后台 reconcile 不创建授权。关闭运行时等待在途绑定对账结束后再关闭数据库。

## 更新与限制

正式制品必须来自受保护的 Portfolio release workflow，先 dry-run 后同 SHA publish。更新同一固定部署目录及应用，不重发管理员首登口令，不改 `/workspace/.kiwi-runtime` 或平台部署绑定。

文件商品发布是显式选择与确认的功能，未新增全量自动同步、自动撤回或自动续鲜。listing 有效期最多 30 天且不晚于商品有效期，到期重新预览确认。精确金额 v1 商品库保持独立，文件表价格保持原 major-unit 语义。
