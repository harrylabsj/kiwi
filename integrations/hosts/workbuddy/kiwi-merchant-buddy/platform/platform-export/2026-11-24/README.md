# WorkBuddy kiwi 商家智能体 V7 配置回读

2026-11-24（北京时间），从 WorkBuddy 开放平台的应用配置编辑页导出。确认行业配置和市场配置与 V7 候选包的 JSON 内容逐项一致后，同日在平台提交审核。提交回执显示「配置审核中 v7」。

| 文件 | SHA-256 |
| --- | --- |
| industry-config.json | 2c67b086d2d652e49109c40f37f1b358016f5c831113ee208f4d7f89bb2463bd |
| market.json | d4693c5c860726a5905cd9898e5c412bd841bf70bebae740b87ada9c5e456b6a |

行业配置原件同时放在 `platform/import/industry-config.platform-import.json`。平台行业配置的结构字段 `version` 仍为 `1`，应用发布序号以 WorkBuddy 列表的 v7 为准。

注册开通依次显示「注册账号、邮箱验证、一键上云、发布名片、上线检查、升级接待」。「已有账号」引导商家打开 Kiwi 商家后台。快照保留平台模型、授权和专家关联。

本地生成结果与平台快照的差异记录在 `expected-diffs.json`。运行 `npm run verify:workbuddy-platform` 检查。
