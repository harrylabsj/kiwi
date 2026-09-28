# 方案 B 提示词（普通 WorkBuddy 任务执行云端接待部署）

> **使用条件**：本技能所在会话没有平台云发布工具（inspect / activate / deploy）——V1 未验证时的兜底路径。
> **使用方法**：向商家说明情况后，把下面分隔线之间的整段提示词**原样**输出，让商家复制到一个**普通 WorkBuddy 任务**（不是本应用会话）里运行。执行中出现的平台弹窗由商家本人确认。
> **回填要求**：提示词里的 `{{PACKAGE_VERSION}}`、`{{AGGREGATE_DIGEST}}`、`{{NPM_INTEGRITY}}` 必须先按 `references/release.json` 的回填值替换后再交给商家；未回填时不可使用，应告知商家等待发布参数就绪。

---

请帮我把我名下的 Kiwi 商家云端接待服务发布上线。请严格按顺序执行，每一步把真实回执（成功或报错原文）贴出来，不要伪造成功，也不要跳步。全程只需要我在平台弹窗出现时亲自点确认，其余步骤由你完成。

0. 前置说明：所有云端模块（数据库/登录/存储/LLM）都不要勾选；费用以平台弹窗显示为准，不要承诺免费；完成后也不要承诺 7×24 在线。
1. inspect：列出当前账号下已注册的应用及其 applicationId，不要修改任何已有应用。按应用名「Kiwi商家接待」查找：
   - 恰好找到一个：记住它的 applicationId 和公网链接，第 2 步用 reuse 复用；
   - 一个都没有：第 2 步用 create 新建；
   - 找到多个同名：停下来列给我看，由我确认用哪一个，你不要擅自选择或新建。
2. activate：按上一步结论新建（appName 用「Kiwi商家接待」）或复用（applicationId）云端应用：
   - 不勾选任何云端模块；若面板强制至少勾选一项，如实告诉我并让我选择，不要替选；
   - 弹出的授权确认框由我本人点击；
   - 完成后原样贴出：applicationId、公网链接（形如 https://xxx.app.workbuddy.host）、publicConfig 里的 resourceId 和 endpoint；publishableKey 不要贴出来；
   - 如果返回配额不足、cloud_service_unavailable 或 useLocalImplementation:true，停下来如实告诉我，不要做任何本地替代实现。
3. 取部署包（在本任务的工作目录执行）：
   ```
   npm pack @harrylabsj/kiwi-merchant-cloud@{{PACKAGE_VERSION}}
   ```
   然后解压 tarball，读取包内 build-manifest.json 的聚合摘要，必须等于 {{AGGREGATE_DIGEST}}；另用 `npm view @harrylabsj/kiwi-merchant-cloud@{{PACKAGE_VERSION}} dist.integrity` 取 npm 侧完整性，必须等于 {{NPM_INTEGRITY}}。任何一项不符，停下来告诉我两边的值各是什么，不要换版本、换源或重新下载试试。不要用 curl 执行脚本、不要拉源码现场构建、不要 npm install。
4. 准备部署目录（把 <公网链接> 换成第 2 步的公网链接，<部署目录> 用绝对路径）：
   ```
   node package/prepare.mjs --origin <公网链接> --out <部署目录> --admin-bootstrap
   ```
   成功会打印 JSON 回执（部署目录、聚合摘要、版本），把回执贴给我；其中一次性工作台口令也要贴出来，我需要用它首次登录工作台。
5. deploy：把第 4 步的部署目录发布为在线应用，applicationId 必须复用第 2 步的（不要新建应用，否则公网域名会变，后续验证全部作废）。失败就贴报错原文，不要改动目录内容重试（尤其不要改 cloud.config.json 里的 origin）；成功贴回执（deployedAs/sandboxId/verified），并确认公网链接与第 2 步一致。
6. 自检（把 <公网链接> 替换后逐条执行）：
   ```
   curl -sS -o /dev/null -w '%{http_code}\n' <公网链接>/livez
   curl -sS <公网链接>/readyz
   curl -sS <公网链接>/.well-known/agent-card.json
   ```
   要求：/livez 返回 200；/readyz 返回 200 且 ready:true（identity/storage/products/policy 全过）；agent-card 的 url 字段等于公网链接。刚部署后的第一个请求可能慢几秒，可以稍候重试探测；仍失败就贴响应原文，不要谎报成功。
7. 完成后告诉我三件事：公网链接；一次性工作台口令（只在这里展示这一次，我会自己保存好）；我接下来要做什么——用口令登录工作台查看配对码，再到 Kiwi 的 Catalog 授权页核对两处配对码一致后，亲自点「连接此服务并发布」。

---

**技能侧补充（不复制给商家）**：商家在普通任务里完成第 7 步后，回到本应用的「上线检查」（`kiwi_catalog_get_service_status`）核对最终上线状态——只有 `card.published && presence=fresh` 才能对商家说已上线。普通任务会话没有 `kiwi_catalog_get_service_status`，不要在那里代替核对。
