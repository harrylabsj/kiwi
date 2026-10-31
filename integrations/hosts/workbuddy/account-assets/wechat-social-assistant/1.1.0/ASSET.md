# 微信社交助手 — 1.1.0（HOLD: WorkBuddy 包映射未证实）

- WorkBuddy 资产：本任务主代理于 2026-10-31 现场读取列表项为已发布 `1.1.0`，ID `oe_fb2328a0981a9614`；平台未提供上传文件哈希。
- 指定来源仓 `wechat-social-assistant` 有精确版本候选 commit `f79dce30af72a31cd72eca95150832183d9e35ca`：`pyproject.toml` 与 `agent/agent.json` 均为 `1.1.0`。它不是 v1.1.0 tag；该 commit 被后续 v1.4+ tags 包含。归档的是受跟踪应用源码快照，过滤了 tests、data、reports、work、数据库、截图与运行记录。
- WorkBuddy 对应仍为 HOLD：commit 的 `agent/agent.json` ecosystems 写 Hermes、OpenClaw、Codex、Claude Code，没有 WorkBuddy；`agent/` 树内没有 WorkBuddy 专家包；源码仓没有 ZIP。故不能把这个源提交或 wheel 认定为平台 `oe_fb2328a0981a9614` 的上传包或完整专家源码。
- 已用指定仓 .venv（setuptools 84.0.0）从该归档源码构建两次 Python wheel；均成功且各为 102381 字节，但 SHA-256 不同。因此不随档附上这个非 WorkBuddy、非确定性构建物，也不把它当作平台 ZIP。
- 来源 commit 没有显式 LICENSE 文件或 `pyproject.toml` license 字段，本归档不推定授权。原始 WorkBuddy 上传包及 SHA-256 缺失；不生成冒充原上传包的重打包 ZIP。
