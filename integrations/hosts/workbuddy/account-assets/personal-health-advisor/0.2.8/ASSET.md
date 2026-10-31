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
