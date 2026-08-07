# Kiwi 官网部署手册（kiwi.harrylabsj.com）

> 状态：2026-08-07。页面源在 kiwi 仓库 `docs/website/`（markdown 文案为规范源）。
> 目标域名 `kiwi.harrylabsj.com` **当前被 `harrylabsj/kiwi-spec` 的 Cloudflare
> Pages 占用**（协议文档托管中）——发布官网前必须先做域名迁移。

## 前置事实（已核实）

- `kiwi.harrylabsj.com` → Cloudflare Pages，200 响应，托管 kiwi-spec 协议文档；
- kiwi-spec 的 Pages 配置在 Cloudflare 侧（GitHub API 查不到），域名解绑/换绑
  必须由账号持有人（项目维护者）在 Cloudflare 控制台操作；
- `harrylabsj/kiwi` 仓库是 **private**——Cloudflare Pages 可连接 private
  仓库（经 Cloudflare GitHub App 授权），只部署 `docs/website/` 目录，
  源码不进站点。

## 路径 A：用现有 kiwi 仓库部署（推荐，不需要新仓库）

1. **Cloudflare Pages 新建项目**
   - 控制台 → Workers & Pages → Create → Pages → Connect to Git
   - 选 `harrylabsj/kiwi`（如未授权需先连 GitHub App，允许访问 private 仓库）
   - 构建配置：Framework preset = **None**（纯静态）；Build command = 留空；
     **Build output directory = `docs/website`**
   - Deploy → 得到临时域名 `<project>.pages.dev`，先验证页面正常
2. **域名迁移（关键步骤）**
   - 新项目 → Custom domains → Add custom domain → 输入 `kiwi.harrylabsj.com`
   - Cloudflare 会提示域名已被 kiwi-spec 项目使用 → 到 **kiwi-spec 项目的
     Custom domains** 移除该域名（页面短暂 404 可接受）
   - 回官网项目完成域名添加（DNS 记录自动由 Pages 管理）
3. **验证**：`curl -I https://kiwi.harrylabsj.com` → 200；浏览器打开首页

## 路径 B：新建公开仓库 `harrylabsj/kiwi-website`（代码公开化）

如需官网独立仓库（与源码仓库分离）：

1. 创建公开仓库（需项目维护者授权/手动）：`gh repo create harrylabsj/kiwi-website --public`
2. 同步页面：拷贝 `docs/website/*.html` + `style.css` 到仓库根
3. Cloudflare Pages 连接该仓库（build output directory = 根目录 `/`）
4. 域名迁移同路径 A 第 2 步

## 发布后维护

- 页面源仍在 kiwi 仓库 `docs/website/`；改文案/样式 → 同步到部署目标
  （路径 A：push kiwi 仓库 main 即自动重建；路径 B：手动拷贝 + push kiwi-website）
- 部署到生产前建议先看 `.pages.dev` 临时域名确认样式（尤其中文字体/nowrap 折行）

## 部署后验证清单

```text
[ ] https://kiwi.harrylabsj.com            → 首页 hero 双入口
[ ] /buyers.html  #install                 → 安装命令块渲染
[ ] /merchants.html #install               → 自动安装说明
[ ] /developers.html                       → 源码/构建/代码位置
[ ] 页脚 Contact 行（email + 微信）
[ ] 移动端宽度（≤640px）无横向滚动
```
