# 海纳·旅行专家 — 0.1.2

- WorkBuddy 资产：平台列表由本任务主代理于 2026-10-31 现场读取为已发布 `0.1.2`，ID `oe_c0a888644f31507f`。此为列表观察，不含平台上传文件哈希。
- 精确来源候选：独立源码仓 `travel-expert` 的历史 commit `a1d837f0c1457817231f179aeb87ce68d31a6b1b`（2026-09-19；当时插件清单版本 `0.1.2`）。该 commit 的 deterministic builder 重建本归档 ZIP，SHA-256 完全匹配 `3871abcad4f762543c40f1c7796db0ab031191cc6061e684a3c3254a985e659e`。
- 随附 ZIP 取自来源仓 `dist/expert/haina-travel-0.1.2.zip` 本地构建物，校验和侧车相符。**没有平台回执或平台哈希，不能确认其字节就是线上上传件**。
- 当前来源仓 HEAD 的同版本重建仅头像文件不同，哈希为 `09c4700d…a414a44`；归档固定到上面历史 commit，因为它是能重建所留 ZIP 的来源版本。
- 来源仓 README 把该版本描述为开发输入，称非可直接安装/上架包；WorkBuddy 列表则显示 0.1.2 已发布。保留这项状态差异，ZIP 按“可复现来源分发候选”记录。
- 构建输入仅含该 commit 的 `02_workbuddy/`、`02_contracts/`、`src/haina_travel/`、`03_reference/validator.py`、`assets/haina.png` 与 `scripts/build_expert.py`。未复制样例、评测运行记录、账号数据或用户材料。来源仓未发现显式 LICENSE 文件，故本归档不推定其授权。
- 重建命令（在 `source/` 执行）：`python3 scripts/build_expert.py --out /tmp/travel-build --avatar assets/haina.png`。构建成功并输出相同哈希；builder 提示头像 PNG 为调色板模式（不是构建失败）。
