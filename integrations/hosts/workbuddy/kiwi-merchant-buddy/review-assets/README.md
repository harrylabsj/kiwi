# Kiwi Buddy 提审材料索引

本目录是 17 项 WorkBuddy 技能、专家、专家团和商家连接器的离线证据入口。唯一机器清单是 [`registry.json`](registry.json)：10 个技能、5 个专家、1 个专家团、1 个连接器。每项分别记录本地材料路径、原提交 ZIP 的 SHA-256、ZIP 成员字节、头像字节、审核资产 ID、市场引用 ID 和有证据的状态快照。

本材料将 `reviewAssetId` 与 `marketReferenceId` 分开保存。`oe_`、`os_`、`oc_` 是平台提审资产 ID；`ex_`、`skill_` 和 `kiwi-merchant` 是 Buddy 市场配置中的引用。它们属于不同命名空间，不能互换。未知引用留为 `null`。专家/专家团的 `ex_` 值来自当前 v3 草稿中对应分类的实际位置；该导出没有记录具体专家版本，所以清单不推断版本。现有技能市场引用也只记录已发布映射能证明的条目；较新但在审的包不会继承旧包的市场引用。

## 当前官方记录

`official/2026-10-13/buddy-app-v2-rejected-official-export.zip` 保存被驳回的 v2 导出。`official/2026-10-13/buddy-app-v3-current-draft-unsent.zip` 保存最近的小鸟头像草稿，其中已移除买方连接器；它**尚未重新提审**。七个新增技能（其回执 ledger 归档于 `official/2026-10-13/seven-new-skill-submission-ledger.json`）仍在审核中，正常选择器当前不能选用这些在审项，因此应用重提审和平台端 E2E 保持暂停。`official/2026-10-13/references/buddy-app-three-published-skills-reference-only.zip` 只是已发布技能引用的取证快照，不是最新应用草稿。

技能与资产状态都是有时间边界的快照，不代表平台实时状态。能从回执读出的 UTC 时间会标为回执记录的观察时间，不会表述成平台提交时间；没有精确观察时间时使用 `observedAtUtc: null` 并保留日期、状态来源和证据文件。七项新增技能的原官方 ledger 保持字节不变，但其中的头像/回执字段是历史采集路径（含 `/private/tmp` 或无法定位的相对路径），不是可移植文件链接。`official/2026-10-13/seven-skill-local-path-map.json` 提供仓库内可解析的头像与实际找回回执映射；商品源事实核验的相对回执字段可解析到一份历史提交页截图并已原样归档，但截图本身不含资产 ID/版本，因此明确标注其单项关联未验证；没有用别的记录冒充单项回执。CS 准备技能 0.1.1 的官方列表记录为已发布；云端部署 0.2.3 和商品导入 0.1.3 的回执记录为审核中。洽谈审批官 0.1.2 的先前官方快照记录为已发布；其余专家、团队和连接器状态保留原观察快照。

六个专家包在 `../experts/` 中按原 ZIP 成员完整展开，包括隐藏的 `.codebuddy-plugin/plugin.json`、agent 文件、内嵌技能及头像。展开后的内嵌技能保留其提交时字节；不要用独立技能的较新版本替换。10 项独立技能（7 项新增、3 项既有，其中 2 项重新提审）的原提交 ZIP 都保存在 `submissions/2026-10-13/`。商家连接器原 ZIP 也保存在该目录；ZIP 中 `connector-meta.json`、`mcp.json`、`icon.svg` 与既有 canonical 连接器文件 SHA 完全一致，因此没有复制第二份连接器实现。

`history/repository-before-20261013/` 保存 A686 之前三个独立技能的冻结内容和逐文件 SHA 清单；`history/portfolio-products/` 保存更新 portfolio 连接器状态前的原始条目。新技能材料、历史冻结和应用草稿在 registry 中分开登记。10项技能的 `originPath` 现在指向可读、按 SHA 验证的真实外部原包路径；这些路径依赖用户输出目录，长期可移植的提交内容仍以本目录保存的精确ZIP为准。根目录 `portfolio-products.json` 的商家连接器保留 `release/` 发布 artifact 契约，并另用 `submission_archive` 指向审查用归档 ZIP；资产 ID 与审核状态是 2026-10-13 的有界快照。其他产品记录、版本和发布 gates 未改。

## 离线检查与重建

在仓库根目录运行：

```sh
python3 integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/tools/validate_review_assets.py --self-test
```

这会核对 17 项唯一性、ID 命名空间、官方导出中的引用位置、官方状态证据文件哈希、每个原提交 ZIP 的整体 SHA 与成员、真实外部源 ZIP 路径、七项本地路径映射、提取后的专家完整目录、内嵌引用、头像和 portfolio 连接器条目。`--self-test` 会注入缺失市场引用、错误七技能证据、CS状态不一致和历史映射缺失等负控，并以累积错误决定最终状态和退出码。

可从原始提交 ZIP 重建各项提交内容到一个新目录：

```sh
python3 integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/tools/rebuild_submission_assets.py --dest-root /tmp/kiwi-buddy-rebuilt
```

重建工具只读取 registry 与留存 ZIP，把原始成员字节写入调用者指定的目录；会拒绝目标目录、任意父路径或目标文件上的符号链接（包括 dangling symlink），重复运行只接受完全相同的普通文件，不覆盖不同内容。它不生成平台 `out/`、不重打包 ZIP，也不修改官方草稿或运行时语义。
