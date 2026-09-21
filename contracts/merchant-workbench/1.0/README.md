# Merchant Workbench contracts 1.0

- `problem.schema.json`：`/merchant/api/v1/*` 的 RFC 9457 错误外壳；不用于 A2A/MCP/legacy 管理 API。
- `money.schema.json`：精确非负金额，`amount_minor` 为十进制整数字符串。

运行时注册表与转换实现位于 `src/http/merchant-management/problem.ts` 和 `src/merchant/application/money.ts`。Schema 校验不代表 WebAuthn、平台或业务验收通过。
