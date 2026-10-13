# 方案 B 提示词（普通 WorkBuddy 任务执行云端接待部署）

> **使用条件**：本技能所在会话没有平台发布工具 `workbuddy_sites_deploy`（V1 实测：Buddy 会话有 sites_deploy/sites_unpublish 与本地读写、Bash；若本会话连 sites_deploy 也没有，走本方案）。
> **使用方法**：向商家说明情况后，把下面分隔线之间的整段提示词**原样**输出，让商家复制到一个**普通 WorkBuddy 任务**（不是本应用会话）里运行。执行中出现的平台弹窗由商家本人确认。
> **回填要求**：提示词里的 `{{PACKAGE_VERSION}}`、`{{AGGREGATE_DIGEST}}`、`{{NPM_INTEGRITY}}` 必须先按 `references/release.json` 的回填值替换后再交给商家；未回填时不可使用，应告知商家等待发布参数就绪。

---

请帮我把我名下的 Kiwi 商家云端接待服务发布上线。请严格按顺序执行，每一步把真实回执（成功或报错原文）贴出来，不要伪造成功，也不要跳步。全程只需要我在平台弹窗出现时亲自点确认，其余步骤由你完成。注意：我们不用任何云端模块（数据库/登录/存储/LLM 都不开），所以不需要"开通云服务"之类的步骤；如果你发现会话里有 publishableKey、token 之类凭据字段，不要贴出来。

1. 取部署包（在本任务的工作目录执行）：
   ```
   npm pack @harrylabsj/kiwi-merchant-cloud@{{PACKAGE_VERSION}}
   ```
   然后解压 tarball，读取包内 build-manifest.json 的 artifact_sha256，必须等于 {{AGGREGATE_DIGEST}}；另用 `npm view @harrylabsj/kiwi-merchant-cloud@{{PACKAGE_VERSION}} dist.integrity` 取 npm 侧完整性，必须等于 {{NPM_INTEGRITY}}。任何一项不符，停下来告诉我两边的值各是什么，不要换版本、换源或重新下载试试。不要用 curl 执行脚本、不要拉源码现场构建、不要 npm install。
2. 首次发布取公网地址：用会话里的平台发布工具 workbuddy_sites_deploy（工具名或参数以会话实际提供的为准）把当前工作目录发布一次，目的是拿到公网地址（形如 https://xxx.app.workbuddy.host）和应用标识。完成后原样贴出公网地址与应用标识。如果发布失败或拿不到地址，先和我一起确认账号里是否已经有一个叫「Kiwi商家接待」的应用，确认没有才再次创建，不要重复建。如果回执出现配额不足、cloud_service_unavailable 或 useLocalImplementation:true，停下来如实告诉我，不要做任何本地替代实现。
3. 准备部署目录（把 <公网链接> 换成第 2 步拿到的地址，<部署目录> 用绝对路径）：
   ```
   node package/prepare.mjs --origin <公网链接> --out <部署目录> --admin-bootstrap
   ```
   成功会打印 JSON 回执（部署目录、artifact_sha256、版本），把回执贴给我并核对摘要仍等于 {{AGGREGATE_DIGEST}}；其中一次性工作台口令也要贴出来，我需要用它首次登录工作台（只在这里展示这一次，我自己保存）。
4. 同一应用再次发布：用 workbuddy_sites_deploy 把第 3 步的部署目录发布，必须复用第 2 步的同一个应用（不要新建，否则公网域名会变，后续验证全部作废）。失败就贴报错原文，不要改动目录内容重试（尤其不要改 cloud.config.json 里的 origin）；成功贴回执，并确认公网地址与第 2 步一致。
5. 自检（把 <公网链接> 替换后逐条执行）：
   ```
   curl -sS -o /dev/null -w '%{http_code}\n' <公网链接>/livez
   curl -sS <公网链接>/readyz
   curl -sS <公网链接>/.well-known/agent-card.json
   ```
   要求：/livez 返回 200；agent-card 的 url 字段等于公网链接。/readyz 里 identity/storage/policy 必须通过；products 一项在我导入商品并完成 Catalog 授权之前不通过属预期，不要因此说部署失败，提醒我去工作台导入商品即可。刚部署后的第一个请求可能慢几秒，可以稍候重试探测；仍失败就贴响应原文，不要谎报成功。
6. 完成后告诉我三件事：公网链接；一次性工作台口令（只在这里展示这一次，我会自己保存好）；我接下来要做什么——用口令登录工作台先导入商品、查看配对码，再到 Kiwi 的 Catalog 授权页核对两处配对码一致后，亲自点「连接此服务并发布」。

---

**技能侧补充（不复制给商家）**：商家在普通任务里完成第 6 步后，回到本应用的「上线检查」（`kiwi_catalog_get_service_status`）核对最终上线状态——只有 `card.published && presence=fresh` 才能对商家说已上线。普通任务会话没有 `kiwi_catalog_get_service_status`，不要在那里代替核对。
