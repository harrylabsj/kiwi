# WorkBuddy 已发布资产：个人健康管理顾问 0.2.8

- 类型：WorkBuddy 专家；平台状态：已发布（由 Root 于本轮在线核实）
- 来源仓库/提交：`healthCare` / `bddce2b3be83e1c93002111fe9e1251e7f506c31`
- 明确对应的发布 ZIP：`personal-health-advisor-expert-0.2.8.zip`
- ZIP 字节：17,520,199；SHA-256：`10a361d000a5b912865468c44c59cb16aba5d222904f01bd5f286139f83d4102`
- 源码许可证：Apache-2.0；`LICENSE` 来自来源仓库。ZIP 内第三方 wheels 保持原包内元数据。
- 构建命令：`python3 scripts/build_advisor_expert.py --zip`（在 `source/` 目录中）。`source/` 是从 Git 跟踪文件筛选的构建材料，原项目通用 README 中一条含用户 profile ID 的示例被省略；仅构建期安全扫描正则中的同一字面值改为通用 sentinel，以避免复制个人标识，不改变发布 ZIP 内运行代码。以保留的已发布 ZIP 为发布字节来源。

在隔离 `git archive HEAD` checkout 上重建时，pip 构建隔离因无法取得 `setuptools>=68` 停止；因此重建结果未验证。来源 ZIP sidecar 与 ZIP SHA 一致；`unzip -t` 通过，原项目 `validate_expert()` 对解包包体检查 50 个文件通过。ZIP 共 59 个条目，无绝对/目录穿越路径。包内没有健康档案或口令；第三方 wheels 为构建依赖，不应把它们解释为用户档案数据。

## 2026-10-31 独立归档重建补充

在网络可用环境中，使用本归档 `source/` 的 `python3 scripts/build_advisor_expert.py --zip` 已生成 0.2.8 ZIP 并通过构建自检。重建 ZIP 的 SHA-256 为 `db3895c6761ed70b3c757dfb4b201659127153d5bb2fe37769d07c17926b23ae`；与原始上传包的文件数均为 50，但部分第三方 wheel 版本/文件不同，故不是逐文件可复现的上传原件。原始 ZIP 已归档，精确重现依赖仍需把上游的构建依赖锁定至上传版本，不得声称当前重建包与线上完全一致。


## Upstream validation and lint scope

The upstream expert package validator passed on the archived package (50 files). The upstream test suite contains a version assertion for 0.2.7, so it was not used as a 0.2.8 test result. The archived `health-advisor-mcp.mjs` intentionally retains upstream text: its `delimiter` import is unused, and two empty catches handle absent optional `current` and `installed-wheel` marker files. Kiwi's ESLint config exempts only this exact archival file: `delimiter` remains the sole ignored binding, and `no-empty` still reports empty blocks outside catch clauses. The archived source and published ZIP are unchanged.

## 安全扫描记录

本仓 PR #121 的 CodeQL 扫描对归档中的 `workbench_template.html` 报告了10项高严重性“DOM text reinterpreted as HTML”。初始独立源码审阅确认相应 `innerHTML` 接收点存在，正常数据路径中的自由文本经过转义，未转义字段主要是枚举和数值；当时未证明普通用户输入可利用。客户端没有完整校验宿主返回模型，因此需要按不可信模型字段处理并做本地安全修订。原始上传 ZIP 与其内 wheel 保持不变；不能仅凭静态审阅宣称远端扫描通过或告警已由 CodeQL 确认消除。

## 2026-10-31 安全重建源码修订

PR121 对应的归档源码模板已作安全修订：对模型返回的文本和属性值执行 HTML 上下文转义，对状态/模式类名使用固定枚举，对进度宽度限幅，并为恶意模型字段及正常内容添加离线回归测试。原始上传 ZIP 及其内 wheel 均保持原样；本归档源码不再与原 ZIP 中的模板逐字节相同，基于此源码生成的包也不能称为上游原版或原始上传包。当前修订仅完成本地源码与离线测试，尚未获得 PR121 远端 CodeQL 复扫结果；不得将告警表述为已由远端扫描确认通过。
