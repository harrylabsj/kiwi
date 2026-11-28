# 首次发布取址入口（first-publish）

这是 Kiwi 开通顾问技能包内**固定**的首次发布启动入口，只用于在 `prepare.mjs` 之前取得 WorkBuddy 公网地址（`--origin`）。

## 内容

- `index.js`：无第三方依赖的 Node 启动脚本，监听 `HOST`（默认 `0.0.0.0`）与 `PORT`（默认 `3000`）。
- `package.json`：仅声明 `node index.js` 启动方式；`private: true`，无 dependencies，不固定云端运行时版本。
- 本说明。

## 使用

1. 先固定一个专用于「Kiwi商家接待」的发布目录，位置在该技能目录之外。
2. 只把本目录的 `index.js` 与 `package.json` 原样复制到该发布目录；不要把技能目录或 `scripts/` 一起复制，也不要加入商家数据或凭据。
3. 可在发布目录本地运行 `node index.js` 做启动检查：
   - `GET /livez` 返回 HTTP 200。
   - `GET /readyz` **故意**返回 HTTP 503 和 `ready:false`，避免把取址占位页误报为正式运行时已就绪。
   - `GET /` 返回最小占位页，仅说明正在取址。
4. 用当前会话实际提供的 WorkBuddy 发布能力发布该固定目录，记录公网地址、应用标识和目录绝对路径。
5. `prepare.mjs` 完成后，用正式部署文件覆盖同一发布目录中的 `index.js` 与 `package.json`，再复用同一应用发布。取址入口到此结束，不参与正式运行时。

## 边界

- 本目录**不**解析、下载或安装 `@harrylabsj/kiwi-merchant-cloud`，也不固定任何云端包版本；版本只由 `scripts/cloud-session-cli.mjs stage` 对 npm `latest` 一次解析、锁定并验证。
- 本目录不是商家运行时，不包含商家数据、凭据、配对码、token 或密钥。
- 本目录不参与执行授权判断；真实发布仍以当前会话真实提供的工具、商家本人确认和平台回执为准。本占位入口只用于取址，不代表正式运行时已就绪。
