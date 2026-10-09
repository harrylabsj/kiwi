# 管理 Origin 与可信确认边界

本合同覆盖 2-17、3-37、3-38、3-39；不同 Origin 检查承担不同职责，不能统一成宽松“允许 localhost”规则。

| 场景 | 权威与规则 | 未提供 Origin / HTTP |
|---|---|---|
| 管理 API 会话 | `merchant-management/api.ts` 的 session cookie、角色/merchant权限；变更及定价预览 POST 再核 session-bound CSRF | 合法非浏览器调用可无 Origin，但不能无 CSRF；存在 allowedOrigins 时，提供的 Origin 必须精确命中 |
| cloud 装配 | `cloud/bootstrap.ts` 显式 `allowedOrigins: [config.publicOrigin]` | 不把请求 Host/XFF 自动纳入 allowlist；省略 allowedOrigins 的独立装配仍必须保 CSRF |
| WebAuthn | credential/challenge 的精确 HTTPS origin、RP ID及实际验证过的 authenticator 绑定 | 本地 HTTP 不支持可信确认；配置/强确认环节明确提示 HTTPS。不能放宽 requireHttpsOrigin；HTTP 自检、普通读取/OAuth并非因此整体被禁 |
| enrollment/runtime binding | Catalog 签名授权绑定 runtime_origin、merchant/agent/key/服务epoch与有效窗口 | 按签名协议验证完整原绑定；不以管理 allowlist、Host 或“同属 localhost”替换。本机HTTP自检支持不自动扩展到签名声明或WebAuthn；当前runtime binding claims字段按HTTPS URL校验，grant另按其签名合同核对 |

定价预览是有限计算接口，不是订单/支付效果。POST 复用 CSRF/Origin 门是纵深保护，仍要求有效 session 与 products:read；不能因有 CSRF就免角色检查，也不能因它是计算就跳过 session。此文没有证明浏览器跨站攻击已发生。

WebAuthn 提示来自可信配置 `webauthnRegistration.origin`，否则来自唯一 allowedOrigin（cloud publicOrigin）。无可靠配置时不猜 Host/请求来源，仍由原未配置/严格 HTTPS/RP 校验拒绝。含多个 Origin 的装配应显式配置注册 origin，不能据宽松列表给整个确认面背书。提示只在强确认/注册环节生效；独立注册授权 callback、session、CSRF与权限门均保留。

公开 endpoint 或 RP 变更应先检查已登记 credential/challenge 的精确 origin 绑定，不能通过 trim/大小写/路径“归一化”悄悄改变旧凭据身份。本次不轮换凭据、不迁移 enrollment、不新增 OAuth 或确认能力。
