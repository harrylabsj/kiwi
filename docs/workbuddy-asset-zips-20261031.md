# WorkBuddy Kiwi asset ZIP build entry

This entry creates **one ZIP per asset**. It does not create a combined ZIP that could be mistaken for a platform upload. The manifest keeps the 2026-10-27 published inventory separate from the 2026-10-31 live observations and identifies local review candidates independently.

## Build

Run from the repository root with Node.js and the system `zip`/`unzip` commands available:

```sh
node integrations/hosts/workbuddy/build-asset-zips.mjs --out-dir /absolute/path/to/a/new-output-directory
```

The output directory must not already exist and must be outside the repository. Each locally buildable asset gets `<asset-id>-v<version>.zip` plus a `.manifest.json` sidecar. `BUILD-REPORT.json` records built items and HOLD reasons. Review candidates are packaged separately and labelled `CANDIDATE_PACKAGE_BUILT`; the label does not assert the local ZIP is byte-for-byte the platform submission.

The output path check also resolves its existing parent to block paths that appear external but pass through a symlink into the repository. The builder refuses an existing output directory without changing its contents. Run its boundary checks with:

```sh
node --test integrations/hosts/workbuddy/test/build-asset-zips.test.mjs
```

This test command passed 4/4 checks on 2026-10-31, including a complete temporary build, existing-directory preservation, direct repository-path rejection, and symlink-resolved repository-path rejection.

## Package checks

- Standalone experts and expert teams use the official basic layout: one root directory containing `.codebuddy-plugin/plugin.json`, its declared agent/skill/avatar files, and `README.md`. Local version must match the manifest row. ZIP entries are compared with the enumerated files and `unzip -t` is run.
- Standalone skills use the official basic layout: one root directory containing `SKILL.md`, with only `references/`, `scripts/`, `templates/`, or the existing cloud skill `package/` content as subresources. Required frontmatter fields and exact version are checked. ZIP entries are compared with the allowlisted files and `unzip -t` is run.
- Connector ZIPs are produced by the existing connector-specific project packagers, which validate their declared package structure. The package ZIP hash is recorded in its sidecar.
- No directory is zipped wholesale. Experts derive included content from `plugin.json` references; skill subresources are restricted to named resource directories. Symlinks and path traversal are rejected.

## Status and limits

The 2026-10-27 inventory recorded seven Kiwi experts/teams, ten Kiwi merchant skills, and two connectors as published at that time. The 2026-10-31 live read-only observation reported the merchant connector published, buyer connector 1.0.4 reviewing, launch team 0.1.3 and onboarding advisor 0.1.4 reviewing, shopping expert/skill versions reviewing, cloud deployment skill 0.3.2 reviewing, and other Kiwi merchant skills published. The manifest records these as observations; they are not queried by the build script.

The packageable historical/source-matched set is five merchant experts plus expert team version 0.1.1, ten skills at their historical published versions, and the merchant connector 1.2.0. The procurement expert's exact published 1.0.1 source is unresolved; its local 1.1.0 package is separately marked candidate. The currently reviewing procurement connector 1.0.4 is HOLD because this worktree contains only 1.0.3 source. The 1.1.0 Kiwi shopping agent is HOLD because only local 1.2.0 source was found. The locally built review candidates are not evidence of the exact ZIP uploaded to WorkBuddy.

### Build result from this worktree

The run produced **17 local packages**, **6 candidate packages**, and **2 HOLD entries**. Every produced ZIP passed exact staged-entry comparison and `unzip -t`; connector builds also passed their existing project packager checks. The package files themselves were written to a temporary output directory, not committed to the repository.

Historical/source-matched local packages:

| Asset | Version | ID |
|---|---:|---|
| 开通顾问 | 0.1.2 | `oe_eee5ab6349f00203` |
| 报价助理 | 0.1.2 | `oe_a2d0c6cc725719bd` |
| 运营分析师 | 0.1.1 | `oe_85c8bf08203ad422` |
| 客服教练 | 0.1.2 | `oe_ee7df761fbcdefee` |
| 洽谈审批官 | 0.1.2 | `oe_8033777b83a3de05` |
| Kiwi开店团队 | 0.1.1 | `oe_a1da12ace3d9c62c` |
| Kiwi云端接待部署 | 0.2.5 | `os_1ea25f81ce98fea3` |
| Kiwi商品导入表整理 | 0.1.3 | `os_32c612d72d2c3bcd` |
| Kiwi商家AI客服准备 | 0.1.1 | `os_dc3a52407574eb77` |
| Kiwi商家询价单整理 | 0.1.0 | `os_fe982aad31a98bfb` |
| Kiwi商品目录发布预检 | 0.1.0 | `os_50c0414417e25586` |
| Kiwi商家人工审批摘要 | 0.1.0 | `os_03cf120a20b00aae` |
| Kiwi三平台交易入口校验 | 0.1.0 | `os_9bc616f4fb80a452` |
| Kiwi商品源事实核验 | 0.1.0 | `os_6aedc97ac49e2d5b` |
| Kiwi商家报价方案准备 | 0.1.0 | `os_053e9e8722df80e6` |
| Kiwi商家运营数据解读 | 0.1.0 | `os_e64be8878bbb4349` |
| Kiwi商家运营连接器 | 1.2.0 | `oc_0053ad85c92a6587` |

Separate local review candidates:

| Asset | Version | ID | Limit |
|---|---:|---|---|
| Kiwi采购询价专家 | 1.1.0 | `oe_37aed7f0a679e6d4` | Local candidate; historical 1.0.1 source not established |
| Kiwi开店团队 | 0.1.3 | `oe_a1da12ace3d9c62c` | Review state known; submitted ZIP identity unknown |
| 开通顾问 | 0.1.4 | `oe_eee5ab6349f00203` | Review state known; submitted ZIP identity unknown |
| Kiwi云端接待部署 | 0.3.2 | `os_1ea25f81ce98fea3` | Review state known; submitted ZIP identity unknown |
| 网购助手 | 1.2.0 | `oe_6038d999d6308c6b` | Review state known; submitted ZIP identity unknown |
| 网上购物助手 | 1.2.0 | `os_b8010c654e343791` | Review state known; submitted ZIP identity unknown |

HOLD entries from this build:

- Kiwi采购询价连接器 1.0.4 (`oc_bd73f860e3e2b5d3`): source metadata in this worktree is 1.0.3, so the builder refuses to package it as the reviewing 1.0.4. The script reads `connector-meta.json` at build time and will proceed only when it equals 1.0.4, then run `scripts/package-production.mjs`.
- Kiwi购物智能体 1.1.0: no matching source was found; the available local expert is 1.2.0.

The historical packages for procurement expert 1.0.1, online shopping expert 1.1.0, and online shopping skill 1.1.0 also remain unavailable. They are listed as held historical items in `BUILD-REPORT.json`; their later candidate packages do not replace them.

Local structure checks do not prove review approval, exact platform bytes, current publication state, or live runtime behavior. Recheck platform states before any upload or use. Official package references: [WorkBuddy Skill structure](https://open.workbuddy.cn/docs/skill) and [WorkBuddy Expert structure](https://open.workbuddy.cn/docs/expert).
