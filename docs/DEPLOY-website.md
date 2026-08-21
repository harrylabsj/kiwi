# Kiwi 官网部署手册（kiwi.harrylabsj.com）

> 状态：2026-08-17（线上部署已核实）。页面源在 kiwi 仓库 `docs/website/`
> （页面 HTML/CSS 与 favicon 共同构成宣传页）。
> 本手册 2026-08-08 从 `docs/website/DEPLOY.md` 移至 `docs/DEPLOY-website.md`
> （部署手册不属于站点内容，避免被静态部署发布）。

## 当前部署方式（实际在用）：wrangler 直传 Cloudflare Workers 静态资源

`kiwi.harrylabsj.com` 当前由 **wrangler 直传** 托管（commit `c1fc0ea` 引入，非
git 集成）。配置在仓库根 `wrangler.jsonc`：

```jsonc
{
  "name": "kiwi",
  "compatibility_date": "2026-08-08",
  "assets": { "directory": "./docs/website" },
  "routes": [ { "pattern": "kiwi.harrylabsj.com", "custom_domain": true } ]
}
```

部署（首次需 `wrangler login` 一次，浏览器 OAuth）：

```sh
cd <kiwi 仓库根>
npx wrangler deploy        # 读取 docs/website/，上传差异资产，绑定自定义域
```

- 直传模式以本地 `docs/website/` 为准：改文案/样式后直接 `npx wrangler deploy`
  即生效，与 git 提交/推送无关；已删除的本地文件会在部署后从线上移除
  （边缘缓存随后重新校验，必要时用 `?v=<随机>` 验证绕过缓存）。
- Workers 静态资源的 clean-URL 行为：`/buyers.html` 会 307 → `/buyers`；
  页内链接用 `.html` 也能正常跳转。
- 2026-08-17 已核实：首页两行 h1、恢复版卖家页（英文为主）已上线；
  `merchant-promo.css` 与 `kiwi-merchant-demo.mp4` / `-poster.png` 已删除，
  线上全部 404。

## 历史背景（已解决）

早前 `kiwi.harrylabsj.com` 曾被 `harrylabsj/kiwi-spec` 的 Cloudflare Pages 占用
（托管协议文档）；当前该域已由本手册的 wrangler 直传站点接管，迁移前置已消除。
协议文档（spec/schema）另有独立托管面，不与官网冲突。

## 备选路径（如需更换托管方式）

### 路径 A：用现有 kiwi 仓库接 Cloudflare Pages（git 自动重建）

1. **Cloudflare Pages 新建项目**
   - 控制台 → Workers & Pages → Create → Pages → Connect to Git
   - 选 `harrylabsj/kiwi`（如未授权需先连接 GitHub App）
   - 构建配置：Framework preset = **None**（纯静态）；Build command = 留空；
     **Build output directory = `docs/website`**
   - Deploy → 得到临时域名 `<project>.pages.dev`，先验证页面正常
2. **域名迁移**：新项目 → Custom domains → 添加 `kiwi.harrylabsj.com`
   （若已被其他项目占用，先到该项目移除该域名）
3. **验证**：`curl -I https://kiwi.harrylabsj.com` → 200

### 路径 B：新建公开仓库 `harrylabsj/kiwi-website`（代码公开化）

如需官网独立仓库（与源码仓库分离）：

1. 创建公开仓库（需仓库管理员授权/手动）：`gh repo create harrylabsj/kiwi-website --public`
2. 同步页面：拷贝 `docs/website/*.html`、`style.css`、`favicon.svg` 到仓库根
3. Cloudflare Pages 连接该仓库（build output directory = 根目录 `/`）
4. 域名迁移同路径 A 第 2 步

## 发布后维护

- 页面源仍在 kiwi 仓库 `docs/website/`；改文案/样式 → `npx wrangler deploy` 生效。
- 部署到生产前建议先本地起静态服务确认样式（尤其中文字体/nowrap 折行），或看
  wrangler 部署后的线上再确认。

## 部署后验证清单

```text
[ ] https://kiwi.harrylabsj.com            → 首页两行 h1 + hero ▶ 动画演示 + 中文导航
[ ] /buyers                               → 安装命令 + 工作方式四步 + 诚实边界（中文）
[ ] /merchants                            → 安装命令 + 数据引擎自动装；注册商家账号（中文）
[ ] /demo                                 → Hermes × Kiwi Buyer 完整动画演示（示例数据有明确标注）
[ ] /case-template / /case-template.md   → 404（2026-08-21 移除公开案例——内部信息）
[ ] /developers                           → 源码/构建/代码位置（中文）
[ ] /favicon.svg                          → 浏览器标签图标返回 200
[ ] 页脚 Contact 行（email + 微信）
[ ] 移动端宽度（≤640px）无横向滚动
[ ] /merchant-promo.css、/kiwi-merchant-demo.mp4（-poster.png）→ 404（已删资源不下线）
```
