# WeChat Social Assistant

本地优先的微信社交记录助手 MVP：从电脑版微信的可见窗口截图，使用 macOS 系统 OCR 识别文字，写入本地 SQLite，并生成关系跟进建议。

它不读取微信数据库，不破解加密，不注入微信进程，也不会自动发送消息。

## Agent 生态（v1.1）

`wsa` CLI 是跨 agent 生态的稳定底座。Hermes、OpenClaw、Codex、Claude Code 等工具都可以通过本地命令使用同一套能力，而不需要复制业务逻辑。v1.1 提供 MCP stdio server、关系质量层、关系驾驶舱、本地反馈闭环、群聊/活动候选人发现、可回读 Obsidian 手工补充的关系知识库、本地多入口关系来源导入、OCR 校正队列，以及本地数据审计、备份、导出和按联系人删除。

仓库提供：

- `agent/agent.json`：通用 agent manifest，描述命令、权限、数据边界和安装方式。
- `agent/hermes/wechat-social-assistant/SKILL.md`：Hermes Skill，可让 agent 按安全流程调用本地 `wsa`。
- `agent/hermes/wechat-social-assistant/scripts/doctor.py`：本地自检脚本。
- `agent/openclaw/wechat-social-assistant.md`：OpenClaw 插件、MCP 和 Skill fallback 使用说明。
- `agent/openclaw/wechat-social-assistant-plugin/`：OpenClaw 原生插件，默认只注册读工具，内部复用 MCP。
- `wsa-mcp` / `python3 -m wsa.mcp_server`：本地优先 MCP server。
- `docs/architecture.md`：分层架构、数据流、权限边界和 OCR/官方连接演进路线。
- `docs/roadmap.md`：从 v0.2 到 v1.1 的产品路线图。

Hermes 可用 raw URL 安装：

```bash
hermes skills install https://raw.githubusercontent.com/harrylabsj/wechat-social-assistant/main/agent/hermes/wechat-social-assistant/SKILL.md --yes
```

OpenClaw 原生插件（版本支持时）：

```bash
openclaw plugins install ./agent/openclaw/wechat-social-assistant-plugin
openclaw plugins enable wechat-social-assistant
```

本地自检：

```bash
python3 agent/hermes/wechat-social-assistant/scripts/doctor.py
```

启动 MCP stdio server：

```bash
WSA_ALLOWED_ROOT="$PWD" wsa-mcp
# 或从源码目录运行
WSA_ALLOWED_ROOT="$PWD" python3 -m wsa.mcp_server
```

MCP 会在进程启动时启用路径策略；`db_path`、截图目录和日志路径必须位于 `WSA_ALLOWED_ROOT` 下。OpenClaw 原生插件会从 `allowedRoot` 配置自动传递该变量。

v1.1 暴露的 MCP tools 大部分只读：`get_status`、`get_audit_report`、`search_contacts`、`get_contact_brief`、`get_next_followup`、`get_daily_report`、`get_weekly_report`、`get_relationship_quality`、`get_relationship_dashboard`、`list_relationship_sources`、`list_relationship_candidates`、`list_feedback`、`list_recent_captures`、`get_capture_observations`、`list_ocr_reviews`。其中 `get_capture_observations` 返回每条 OCR 文本的 confidence、归一化 bbox 和低置信度 speaker candidate；`list_ocr_reviews` 展示待人工校正的低置信度 observation。写入工具还包括 `record_ocr_review`，必须带 `confirmation_text="review OCR observation"`；其它写入工具仍分别要求 `record local feedback` 和 `confirm relationship candidate`。MCP stdio 进程会把 `db_path`、截图目录和日志路径限制在可信的 `WSA_ALLOWED_ROOT` 下。Resources 包括 `wsa://status`、`wsa://audit`、`wsa://contacts`、`wsa://daily-report`、`wsa://weekly-report`、`wsa://relationship-quality`、`wsa://relationship-dashboard`、`wsa://relationship-sources`、`wsa://relationship-candidates`。截图、本地来源导入、数据导出/删除、Obsidian 导入/导出和停止进程仍然走 CLI，并要求用户显式确认。

OCR 数据采用“原始证据 + 可审计校正”两层存储：`captures` 保存一次采集的业务记录，`ocr_observations` 保存每条 OCR 观察的文本、置信度、空间坐标、来源和 speaker 候选，`ocr_reviews`/`ocr_review_events` 保存用户对低质量 observation 的接受、排除或修正；原始 OCR 不会被覆盖，分析使用 `captures.corrected_text` 的生效文本。数据库通过 `schema_migrations` 显式升级，`wsa backup --yes` 使用 SQLite backup API 生成一致快照。完整字段和迁移策略见 [`docs/architecture.md`](docs/architecture.md)。

## 快速开始

```bash
cd wechat-social-assistant
python3 -m wsa.cli init
```

手动导入一段文本：

```bash
python3 -m wsa.cli ingest --contact 张三 --text "张三
下周约饭吗？我想聊聊你那个新项目"
```

`ingest` 会在命令行结果里回显识别到的联系人和中文关系信号，例如 `contact=张三 signals=约时间,项目/合作`；没有识别到关系信号时会显示 `signals=无`，方便立刻判断这段内容是否被正确识别。

生成跟进建议：

```bash
python3 -m wsa.cli suggest --out reports/outreach.md
```

只导出某个人，或某个群来源下的跟进建议：

```bash
python3 -m wsa.cli suggest --contact 群成员A
python3 -m wsa.cli suggest --contact 项目交流 --out reports/outreach-kates.md
```

`suggest`、`profiles`、`brief`、`next` 和 `analyze` 都会自动初始化本地数据库；还没有采集内容时会输出空状态，不需要先手动运行 `init`。
带 `--contact` 过滤但没有匹配时，输出会保留查询词，例如“没有找到匹配「群成员A」的跟进建议”，方便判断是名字没识别出来，还是这个联系人暂时没有可跟进内容。
联系人过滤会忽略空格和括号等标点，所以 `项目交流群3` 可以匹配 `项目交流群（3）`，`陈明daniel` 可以匹配 `陈明 DANIEL`。
`contacts --query` 和 `profiles --contact` 还会匹配身份线索、机构/公司、链接、文件和最近内容，所以也可以用 `示例资本`、`DanielChen` 这类线索找人。`suggest --contact` 和 `next --contact` 会先用这些线索定位到联系人，再筛选跟进建议；如果只是想看低优先级草稿，可以加 `--min-score 0`。
当 `suggest --contact` 或 `next --contact` 精确命中某个联系人姓名时，只会返回这个人的建议；如果别人只是“提到”这个名字，不会混进结果。精确命中群聊名称时则会保留该群里的群内联系人建议。
当联系人确实有低优先级草稿、但被默认阈值过滤掉时，`suggest` 和 `next` 会提示当前阈值、被过滤建议的最高分，并给出 `--min-score 0` 的查看方式，避免误以为系统没有记录到这个人。
指定 `--contact` 时，`profiles` 和 `analyze` 会先在全量联系人里搜索，再应用 `--limit` 限制展示数量；即使联系人比较久没出现，也不会因为默认或手动 limit 被提前截掉。

查看当前系统识别到的联系人、群聊和群内联系人名称：

```bash
python3 -m wsa.cli contacts
python3 -m wsa.cli contacts --query 项目交流
python3 -m wsa.cli contacts --contact 群成员A
```

`contacts` 会输出可用于 `--contact` 的名称、类型、来源群/会话、最近出现时间、身份/机构线索和关系信号。拿不准系统把某个人识别成什么名字时，先跑这个命令；过滤时可以用 `--query`，也可以用和其他命令一致的 `--contact`。

把某个联系人/线索的档案和下一步草稿合在一起看：

```bash
python3 -m wsa.cli brief 群成员A
python3 -m wsa.cli brief --contact 群成员A
python3 -m wsa.cli brief 示例资本
```

`brief` 会复用联系人过滤规则，用姓名、来源群、机构、身份线索、链接、文件或最近内容定位联系人；可以直接写 `brief 群成员A`，也可以用和 `suggest`/`profiles`/`next` 一致的 `brief --contact 群成员A`。它默认显示低优先级的轻量问候草稿，适合在真正发微信前快速确认“这个人是谁、来自哪里、最近聊了什么、下一句可以怎么开口”。精确匹配联系人姓名时会优先展示这个人；如果线索同时命中群聊和群内联系人，简报会列出所有匹配对象，并单独标明下一步建议实际面向谁；下一步里也会显示跟进强度，避免把低分轻量问候误当成必须立即发送。
简报还会显示“最近采集证据”，包括会话名、采集时间、来源和截图路径；如果简报里有下一步建议，证据会优先跟随建议对象，群内联系人会按群聊发言人解析回溯到来源群里的最近本人发言截图，避免把“别人提到这个人”的截图误当成他的发言证据。
如果给 `brief` 设置了更高的 `--min-score`，而草稿只是被阈值过滤掉，简报会在“下一步”里说明当前阈值、最高分和 `--min-score 0` 的查看方式。

查看关系质量层，也就是“关系运营台”：

```bash
python3 -m wsa.cli quality
python3 -m wsa.cli quality --contact 群成员A --min-score 0
```

`quality` 会按联系人生成可解释的关系质量卡，包含总分、关系强度、最近互动、互惠、场景、风险、资料缺口和下一步动作。每个分数都会附带本地采集证据，包括来源会话、采集时间、摘要和截图路径（如果有），避免出现无法追溯的玄学评分。

查看每日关系驾驶舱：

```bash
python3 -m wsa.cli dashboard
python3 -m wsa.cli dashboard --min-score 0 --limit 12
```

`dashboard` 会把日常操作视图压成一个页面：优先联系、降温关系、新人机会、待处理承诺、高价值群聊、噪音群聊和最新来源线索。它复用关系质量、跟进建议、人脉候选人和多入口来源，不自动发送消息，只给出下一步动作和草稿。

把联系人资料、微信归档和本地记忆合成“关系跟进驾驶舱”：

```bash
python3 -m wsa.cli cockpit --dry-run
python3 -m wsa.cli cockpit \
  --vault "$HOME/Hbrain" \
  --wechat-manifest "$HOME/Library/Mobile Documents/com~apple~CloudDocs/微信归档/聊天文件-全量-2026-05-11/manifest-all.tsv" \
  --out reports/relationship-cockpit.md \
  --yes --replace-wechat-archive \
  --min-score 0
```

`cockpit` 会先导入 Hbrain/Obsidian 联系人资料，再按文件名和路径安全扫描微信归档 manifest，把高价值文件线索写入本地 `relationship_sources`，刷新关系信号和联系人档案，最后输出 `reports/relationship-cockpit.md`。这一部分不是聊天记录导入；它只读取归档清单里的文件元数据，不读取微信私有数据库、不解析聊天数据库、不自动发送消息。默认会跳过简历、合同、发票、身份证等高敏感文件名，只有显式加 `--include-sensitive` 才纳入。

发现群聊/活动里值得认识的人：

```bash
python3 -m wsa.cli candidates --min-confidence 45
python3 -m wsa.cli candidates --sync --min-confidence 45
python3 -m wsa.cli candidate-confirm 张三 --source-chat "AI路演群（12）" --yes
```

`candidates` 会从群聊发言人和活动类群名中提取候选人，保留来源群、证据摘录、置信度、理由和一版克制的破冰草稿。默认只读；加 `--sync` 才会把候选人写入本地 `relationship_candidates` 表。`candidate-confirm` 必须带 `--yes`，确认后才会把候选人标为 `confirmed` 并进入本地联系人记忆。

记录用户反馈，让系统逐渐学习你的社交风格：

```bash
python3 -m wsa.cli feedback 李四 too_pushy --note "太主动，放轻一点"
python3 -m wsa.cli feedback 李四 good_draft
python3 -m wsa.cli feedback 李四 snooze --until 2026-05-30T09:00:00+08:00
python3 -m wsa.cli feedback-list --contact 李四
```

支持的反馈动作包括 `mark_done`、`snooze`、`not_relevant`、`too_pushy`、`good_draft`、`wrong_person`、`already_close`、`do_not_contact`。这些反馈会保存在本地数据库里，可审计、可列出；后续建议会据此调整频率、阈值和语气，例如 `snooze` 会暂时隐藏建议，`mark_done` 会在有新证据前隐藏当前建议，`too_pushy` 会降低分数并让草稿更克制，`good_draft` 会轻微增强同类草稿。

只查看当前最值得跟进的一条，并直接显示可改写的微信草稿：

```bash
python3 -m wsa.cli next
```

完整 `next` 输出会显示跟进强度和最近采集证据，包括来源会话、时间和截图路径，低强度表示没有强关系信号，可以先不主动联系或只轻量问候。

如果只想复制草稿正文，可以运行：

```bash
python3 -m wsa.cli next --draft-only
```

也可以只查某个人，或某个群来源下的下一条跟进：

```bash
python3 -m wsa.cli next --contact 群成员A
python3 -m wsa.cli next --contact 项目交流 --draft-only
```

生成以联系人/群聊为中心的关系档案：

```bash
python3 -m wsa.cli profiles --out reports/contact-profiles.md
```

只查看某个人、群，或来自某个群的群内联系人档案：

```bash
python3 -m wsa.cli profiles --contact 群成员A
python3 -m wsa.cli profiles --contact 项目交流
```

查看当前采集状态：

```bash
python3 -m wsa.cli status
```

`status` 会汇总数据库、原始联系人数量、联系人档案数量、采集数量、按当前规则即时计算的关系信号数量、截图数量、首要跟进对象及强度、自动截图是否仍在运行、质量提示、最近一次采集和 `watch.log` 的最后一行。联系人档案数量会包含从群聊里识别出来的发言人，适合在暂停自动截图后快速判断这轮记录了什么；最近一次采集会使用 `YYYY-MM-DD HH:MM` 这种短时间格式。如果没有 45 分以上的跟进建议，但存在低强度草稿，`top followup` 会显示最高低分建议，并提示用 `suggest --min-score 0` 查看低分草稿，而不是只写 `none`。

审计、导出和删除本地数据：

```bash
python3 -m wsa.cli audit
python3 -m wsa.cli export-data --out ./wsa-export.json --yes
python3 -m wsa.cli delete-contact 张三 --dry-run
python3 -m wsa.cli delete-contact 张三 --yes
```

`audit` 只读输出本地表计数和路径；`export-data` 写出本地 JSON 快照，必须带 `--yes`；`delete-contact` 只删除一个联系人相关的本地记录，建议先 `--dry-run` 看影响面，再用 `--yes` 执行。

一键分析并生成报告：

```bash
python3 -m wsa.cli analyze
```

只分析某个人，或某个群来源下的档案和跟进建议：

```bash
python3 -m wsa.cli analyze --contact 群成员A
python3 -m wsa.cli analyze --contact 项目交流
```

`analyze` 会自动初始化数据库、按当前规则刷新历史采集里的关系信号、打印本轮状态摘要，包括数据库联系人数量、生成的联系人档案数量、跟进建议数量、首要跟进对象及强度、首条草稿预览、最近采集短时间、自动截图是否仍在运行，以及样本偏少/没有关系信号/只基于已暂停数据等质量提示。带 `--contact` 过滤时，摘要会同时显示全库联系人数量、本次匹配联系人数量和匹配对象最近出现时间，避免把过滤后的结果和全库总数/全库最新采集混淆。它会写出：

- `reports/contact-profiles.md`
- `reports/outreach.md`

如果暂时还没有采集到联系人，联系人档案会明确显示“暂无联系人档案”，而不是只留下一个空标题。
如果某个联系人暂时只有链接、文件或身份线索，没有可展示的聊天内容，该档案会显示“暂无最近联系内容”。

`analyze` 默认只输出分数不低于 45 的跟进建议，避免把刚刚采集、没有强信号的会话误列为需要问候。如果某个联系人只有低分建议，状态摘要和 `reports/outreach.md` 会明确提示这些建议低于当前阈值。如果想看全量建议，可以运行：

```bash
python3 -m wsa.cli analyze --min-score 0
```

跟进建议表会显示分数、跟进强度和最近互动时间，并把时间压成 `YYYY-MM-DD HH:MM`，方便判断优先级，而不只是看到草稿内容。
同一联系人近 14 天内的最近几条采集会合并判断关系信号和草稿主题；如果上一屏刚提到“下周聊项目”，下一屏只是补了文章/链接，跟进建议仍会保留“约时间/项目”这类强信号，不会被最后一条轻内容冲掉；更早的旧信号不会因为最近轻发言被重新抬成近期跟进。`next` 和 `brief` 里的证据时间/截图也会优先指向贡献强信号的那条采集，群内联系人会按本人发言块回溯证据。
单独运行 `suggest` 时也默认只输出 45 分及以上的建议；如果想看全量低优先级建议，可以运行 `suggest --min-score 0`。
联系人档案里的“最近出现”也使用同样的短时间格式，报告会更容易扫读。

档案会尽量抽取：

- 私聊或群聊来源
- 群内发言人
- 最近重要联系内容
- 链接和文件
- 名片里的姓名/英文名等身份线索
- 带上下文的机构/公司线索
- 问题、项目/合作、感谢、约时间等中文关系信号；“用得上”“往哪个方向做”“先做起来”等协作讨论也会归入项目/合作

“待回复”信号会看一点上下文：`你还没回复我`、`我还没回复你`、`你上次提到的问题，我这边还没回复` 这类双方之间的未回复会提高优先级；`我还没回复某项目/某人` 这类自述进度不会被当成对方催我补回复，避免误把普通项目讨论抬成高优先级。

当同一次采集里既有聊天内容又有纯链接/文件名时，报告会把链接和文件放在独立字段里，避免它们重复占用“最近联系内容”。已结构化成身份线索或机构/公司的孤立 OCR 碎片也会从最近内容中清理掉。
如果某次采集只有链接或文件名、没有可读的聊天文本，档案会保留链接/文件字段，并在“最近联系内容”里显示暂无内容，避免把附件本身当成对话摘要。

群聊整体档案会保留本屏出现过的链接、文件和关系信号；群内联系人档案只保留该发言人自己发言块里的链接、文件和关系信号，降低多人群聊里的误归因。
群聊里遇到时间分隔线后，如果后续内容没有再次出现发言人姓名，系统会把它保留在群聊整体档案里，但不会继续归给上一位群内联系人；这能减少把自己右侧发出的消息误记到别人名下。
群聊里的机构/公司线索也会按发言人消息块归因：某位群成员说“来自某机构”时，只会写入这位成员的档案，不会复制到同群所有联系人身上。
群聊截图入库时，系统也会把识别到的群内发言人作为联系人写入本地 `people` 表；`analyze` 会对旧采集做一次回填，所以 `status` 里的 `contacts` 会同时包含私聊/群聊会话和已识别出的群内联系人。

## 本地多入口来源

除了微信可见截图，v0.8 可以导入用户主动提供的本地文件，并把它们合并到联系人档案、简报、关系质量、搜索和报告里。当前支持：

- `.vcf` 通讯录：姓名、公司、职位、邮箱、电话、备注。
- `.ics` 日历：活动标题、时间、描述、参会人。
- `.md` / `.txt` 会议记录：标题、日期、参会人和摘要。
- Obsidian Vault 的 `社交圈/人脉/*.md`：手工补充的人脉线索。
- `.eml` 邮件：发件人、收件人、主题、日期和正文摘要。
- 微信归档 manifest：只读取 `manifest-all.tsv` 的文件元数据，作为项目/联系人关系线索；这不是聊天记录导入。

导入前先 dry-run：

```bash
python3 -m wsa.cli import-source ./contacts.vcf --dry-run
python3 -m wsa.cli import-source ./calendar.ics ./meeting.md --dry-run
python3 -m wsa.cli import-wechat-archive --dry-run
```

确认后写入本地数据库：

```bash
python3 -m wsa.cli import-source ./contacts.vcf --yes
python3 -m wsa.cli import-source "$HOME/Documents/Obsidian Vault" --kind obsidian --yes
python3 -m wsa.cli import-wechat-archive --yes --replace
```

查看已经导入的来源：

```bash
python3 -m wsa.cli sources
python3 -m wsa.cli sources --contact 张三
python3 -m wsa.cli sources --type calendar
```

这些记录保存在本地 SQLite 的 `relationship_sources` 表中；不会读取微信私有数据库，也不会连接邮箱、通讯录或日历云账号。

档案和跟进建议会尽量合并 OCR 因屏幕换行拆开的半句话，例如把 `OpenClaw 和` / `Hermes` 这类相邻行还原成一条更完整的内容。

跟进建议会区分私聊和群聊：私聊草稿会称呼联系人，群聊草稿会使用“群里上次聊到...”这类语气，避免把群名当成单个人来称呼。
如果群聊里能识别出具体发言人，且该发言人有项目/合作等关系信号，跟进建议会优先指向这个群内联系人，并在原因和草稿里标出来源群，减少只对着群名跟进的情况。
低强度轻量问候会尽量区分名片/自我介绍、个人想法、内容分享、纯链接/文件和项目推进；群内联系人也适用这套低分草稿。名片类内容会用更自然的“看到你的介绍”，个人想法类内容会先压成主题摘要再轻量关心近况，文章/公众号/报告等内容分享会顺着内容继续聊；如果这一屏只有链接或文件，草稿会保守写成“你分享的链接/文件我收到了”，避免把附件或文章分享硬说成“最近进展怎么样”。

## Obsidian 双向知识库

可以把当前关系记忆导出到 Obsidian Vault 的 `社交圈` 目录：

```bash
python3 -m wsa.cli export-obsidian --vault "$HOME/Documents/Obsidian Vault"
```

默认会写入：

- `社交圈/人脉/联系人名.md`：每个联系人一个文件，包含来源群、身份/机构线索、带补充建议的资料缺口、最近联系内容、证据截图和下一步草稿。
- `社交圈/人脉/索引.md`：先列出优先跟进对象和草稿，再按最近出现时间汇总联系人、群聊、来源、关系信号和资料缺口，适合每天快速扫一遍人脉库并立刻行动。
- `社交圈/分析报告/YYYY-MM-DD.md`：每日分析报告，包含人脉结构分析、质量提示、有关系信号的人脉、最近出现的人脉、需要补充信息的人脉及补充建议、应该主动联系的人、原因和发送内容初稿。
- `社交圈/分析报告/YYYY-Www.md`：周报，汇总本周应联系的人、手工补充、资料缺口和最近人脉变化。

如果要指定报告日期：

```bash
python3 -m wsa.cli export-obsidian --date 2026-05-27
```

联系人文件里的 `## 手工补充` 可以在 Obsidian 里编辑，支持 `公司`、`职位/角色`、`认识场景`、`标签`、`备注`、`下次跟进`。回读到本地数据库：

```bash
python3 -m wsa.cli import-obsidian --vault "$HOME/Documents/Obsidian Vault" --dry-run
python3 -m wsa.cli import-obsidian --vault "$HOME/Documents/Obsidian Vault" --yes
```

导入后，手工补充会进入 `contact_enrichments` 表，并在下一次 `export-obsidian`、`contacts`、`profiles`、日报和周报里消解对应资料缺口。

只生成周报到终端或文件：

```bash
python3 -m wsa.cli weekly-report --date 2026-05-27
python3 -m wsa.cli weekly-report --out reports/weekly.md
```

## 数据备份与 OCR 校正

数据库使用 SQLite WAL、5 秒 busy timeout 和显式 schema migration。写入前可以生成一致快照：

```bash
python3 -m wsa.cli backup --out data/backups/social-$(date +%Y%m%d-%H%M%S).db --yes
```

截图导入后，如果 Vision confidence 较低，先查看校正队列：

```bash
python3 -m wsa.cli ocr-review --max-confidence 0.75
```

人工确认后可以接受、排除或修正一条 observation。原始 `raw_text`、截图和原始 observation 保留不变，修正只写入独立 review 表：

```bash
python3 -m wsa.cli ocr-review \
  --observation-id 12 \
  --action correct \
  --corrected-text "修正后的聊天内容" \
  --note "人工核对截图" \
  --yes
```

## OCR 采集

第一次使用截图/OCR 时，macOS 可能会要求给终端或 Codex 屏幕录制权限。

```bash
python3 -m wsa.cli capture --contact 张三 --mode window
```

`--mode window` 会定位当前前台窗口的 window id，只截取该窗口；`--mode screen` 才会截取整个屏幕，后者仅作为显式 opt-in。
截图采集完成后，命令行也会回显 `contact=... person=... signals=... image=...`，其中 `signals` 使用中文关系信号，没有信号时显示 `signals=无`，方便马上判断 OCR 入库是否有效。
如果 OCR 文本和已有记录重复，`capture/watch` 会显示 `duplicate`；系统会把这次解析出的关系信号补回既有记录，避免旧库漏掉线索。已有记录缺少截图时会把新图片补挂上去并输出 `image_attached=...`，同时把该记录的证据时间、来源和联系人最近出现时间更新为这次截图；已有记录已经有可用截图时才删除这次刚截的新图片并输出 `duplicate_image_removed=...`，避免截图目录被重复画面撑大。

如果想用快捷键随时手动补采一次当前微信画面，可以用更适合快捷方式绑定的命令：

```bash
python3 -m wsa.cli quick-capture
```

`quick-capture` 默认使用 `--mode window --crop-preset none --source hotkey`，等价于“马上抓当前前台窗口并入库”。也可以显式传 `--contact NAME`。

扫描间隔可以保存成默认设置：

```bash
python3 -m wsa.cli watch-interval
python3 -m wsa.cli watch-interval 10
```

设置会写到 `data/settings.json`。`watch` 如果没有显式传 `--interval`，每轮都会读取这个保存值；用快捷方式改完后，下一轮轮询就会使用新间隔。已经用 `--interval` 启动的进程会以命令行参数为准，需要重启后才会改用默认设置。

macOS 下可以把项目里的两个脚本绑定成全局快捷键：

```text
tools/wsa-quick-capture.command
tools/wsa-set-interval.command
```

在“快捷指令”App 里新建快捷指令，动作选择“运行 Shell 脚本”，脚本内容填上对应 `.command` 文件路径，然后在信息面板里添加键盘快捷键。建议 `Option+Command+W` 用于快捷采集，`Option+Command+I` 用于弹窗设置扫描间隔。

也可以先自己截图，再 OCR：

```bash
python3 -m wsa.cli ocr-image ./some-screenshot.png
```

如果截图已经来自手机微信、AirDrop 或其它截图工具，可以直接 OCR 并入库，同时把原图路径保存为证据：

```bash
python3 -m wsa.cli import-image ./phone-screenshot.png --contact 张三
```

也可以一次导入多张连续截图：

```bash
python3 -m wsa.cli import-image ./phone-001.png ./phone-002.png ./phone-003.png --contact 张三
```

如果你把手机截图集中放进了一个文件夹，也可以直接传文件夹：

```bash
python3 -m wsa.cli import-image ./phone-screenshots --contact 张三
```

`import-image` 和 `ingest-image` 是同一个命令，适合处理手机微信截图或手动保存的电脑截图；它会逐张 OCR、逐张入库，并复用 `capture/watch` 的信号识别和去重逻辑，但不会删除你传入的原始图片。传入目录时，它只导入这一层目录里的常见图片文件（png/jpg/jpeg/heic/tif/tiff），并按文件名的自然数字顺序处理，所以 `IMG_2` 会排在 `IMG_10` 前面；如果路径不存在、直接传了非图片文件，或目录里没有可导入图片，命令会明确提示，而不是安静退出或抛出难懂的 OCR 错误。命令行会每张图回显一行 `contact=... person=... signals=... image=...`，方便确认截图是否被正确归到联系人档案里；一次导入多张图时，末尾还会显示 `summary images=... inserted=... duplicate=... image_attached=...` 汇总。

## 显式 watch 模式

如果你希望它在一段时间内自动记录当前前台微信窗口：

```bash
python3 -m wsa.cli watch
```

这会按 `watch-interval` 保存的间隔检查一次前台应用，默认是 60 秒。只有当前台应用名是 `WeChat` 或 `微信` 时才截图、OCR、入库。前台运行时按 `Ctrl-C` 停止；也可以临时用 `--interval 10` 覆盖本次运行。

如果 `watch` 在后台运行，可以先预览将要停止的进程，再停止：

```bash
python3 -m wsa.cli stop-watch --dry-run
python3 -m wsa.cli stop-watch
```

`stop` 是同一个命令的短别名：

```bash
python3 -m wsa.cli stop
```

如果安装后使用命令行入口 `wsa watch` 启动，`status`、`stop-watch` 和 `stop` 也会识别并处理这个进程。

`watch` 默认使用前台窗口捕获和 `--crop-preset none`，避免后台任务截取其它应用或重复套用整屏裁剪。只有需要兼容旧的整屏工作流时才显式传：

```bash
python3 -m wsa.cli watch --interval 60 --mode screen --crop-preset none
```

如果你的微信窗口位置和大小固定，也可以手动指定裁剪区域：

```bash
python3 -m wsa.cli watch --interval 60 --mode screen --crop 540,70,2460,1770
```

调试日志会写到数据库同目录的 `watch.log`。默认是：

```text
data/watch.log
```

每次成功截图入库时，`watch.log` 的 `capture` 行会带上 `inserted`/`duplicate`、联系人、中文信号和图片路径；如果是重复 OCR，日志里也会显示 `duplicate_image_removed=...`，便于暂停后判断这段时间到底新增了什么。

暂停 `watch` 后，可以直接生成状态摘要、联系人档案和跟进建议；摘要里会显示自动截图是“运行中”还是“未运行”：

```bash
python3 -m wsa.cli analyze
```

如果要重新开始一轮干净采集，可以先预览会清空多少数据，再显式确认清空数据库记录和截图文件：

```bash
python3 -m wsa.cli reset --dry-run
python3 -m wsa.cli reset --yes
```

`reset` 只清空本工具的 SQLite 关系记忆和 `data/captures/` 里的截图图片，不会删除 `watch.log` 或其他非图片文件。

连续处于非微信前台时，`watch` 会自动降低重复 skip 日志频率。默认每 30 次重复状态写一次心跳；如果想调得更密或更安静：

```bash
python3 -m wsa.cli watch --interval 60 --mode screen --quiet-skip-every 10
python3 -m wsa.cli watch --interval 60 --mode screen --quiet-skip-every 120
```

如果日志里出现 `app=unknown`，说明当前运行环境拿不到 macOS 前台应用名。在 Codex 沙箱里启动时可能会这样；从普通终端启动，或让 Codex 以授权方式启动 watch，通常可以拿到前台应用名。

## 数据位置

默认数据库：

```text
data/social.db
```

截图默认保存在：

```text
data/captures/
```

## 建议使用方式

- 先对几个重要联系人用 `capture --contact NAME --mode window`。
- 每天或每周运行 `analyze` 生成联系人档案和跟进计划。
- 如果想单独生成跟进建议，可以运行 `suggest --min-score 45`。
- 只把 AI 生成内容当草稿，自己判断是否发送。

## 隐私边界

这个 MVP 的设计原则是“只看你明确展示给它的内容”。不要用它记录与你无关、未经授权的对话，也不要把自动化结果用于批量打扰别人。
