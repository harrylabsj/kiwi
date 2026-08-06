# kiwi-spec — Kiwi Negotiation 公开 spec / schema 托管

`harrylabsj/kiwi-spec` 是 Kiwi Negotiation 协议公开托管面，通过 GitHub Pages 部署到
`https://kiwi.harrylabsj.com`。UCP namespace authority 绑定要求（架构基线 §8.2 / §8.3）
spec / schema 必须托管在 namespace 对应的真实域名源上。

| URL | 内容 |
| --- | --- |
| `/a2a/extensions/negotiation/1.0` | KNP/1.0 协议正文（镜像自 kiwi 仓库 `docs/protocol/kiwi-negotiation-protocol-1.0.md`） |
| `/schemas/negotiation/1.0/schema.json` | KNP/1.0 Envelope JSON Schema（UCP schema origin，capability `com.harrylabsj.kiwi.shopping.negotiation`） |

## 维护约定

- 协议正文的权威源在 **`harrylabsj/kiwi`（私有）`docs/protocol/kiwi-negotiation-protocol-1.0.md`**；
  本仓库是发布镜像，协议修订后需同步复制到 `a2a/extensions/negotiation/1.0`。
- `schemas/negotiation/1.0/schema.json` 独立维护；action 级 payload schema（§9–§17 九类核心对象）
  为基线 §41 #7 的后续冻结工作。
- `CNAME` 声明自定义域 `kiwi.harrylabsj.com`；Cloudflare DNS 需添加 `kiwi → harrylabsj.github.io` 记录。

## 部署

GitHub Pages，source = main 分支根目录。push 到 main 即发布。
