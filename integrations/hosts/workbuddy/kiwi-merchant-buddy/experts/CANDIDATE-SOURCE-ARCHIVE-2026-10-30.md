# WorkBuddy 审核候选源码归档（2026-10-30）

本目录归档的是本轮主任务现场确认已提交审核的候选版本源码。提交回执路径与资产 ID 未在本次交接材料中提供；平台当前审核状态、资产状态及是否已发布均未核实。记录仅用于防止源码丢失，不表示审核通过、发布或线上启用。

## 包与源码对应

每个源码目录均逐文件从对应候选 ZIP 解包，并与候选 `PACKAGE-MANIFEST.json` 中的文件路径、字节数和 SHA-256 核对。`kiwi-cloud-deploy` 是独立 22 文件技能的版本化归档；其位置为 `skills/candidate-archives/kiwi-cloud-deploy/0.3.2/`。两个专家目录按主库现有版本化目录惯例新增。

| 资产 | 候选版本 | 文件数 | 源码树 SHA-256 | ZIP SHA-256 | ZIP 文件 |
|---|---:|---:|---|---|---|
| `kiwi-cloud-deploy` | 0.3.2 | 22 | `aef6035f2a32fcf4ac26ad63b5c25d1f29d036b2cbc4714ccf000c7938963416` | `15a141e42bb25d6faeb4fa8574cfebfbe451be314b216f007591a2951de8ecc8` | `kiwi-cloud-deploy-0.3.2-candidate.zip` |
| `kiwi-onboarding-advisor` | 0.1.4 | 26 | `6b7f90dbd1f2021d27a66df31af9ded4c5989022bc7265127d7213951528c05d` | `b2c7ec350aadec396a4277115018fbd01bd3407170f85b8030d487fff097fd02` | `kiwi-onboarding-advisor-0.1.4-candidate.zip` |
| `kiwi-launch-team` | 0.1.3 | 43 | `dcacaae0c78f990f618d43ff8f6775c934a12823cdac1888e38c3e2de90a2e6a` | `c9cdce7c40c0477a5fdb138764ad83ebc4c6a94458a9ed66d647f2a11fd211a1` | `kiwi-launch-team-0.1.3-candidate.zip` |

## 构建关系与边界

- 两份专家源码目录分别是 WorkBuddy 专家候选 ZIP 的清洁源码快照；`skills/kiwi-cloud-deploy/` 子目录中的同名技能是专家包内嵌副本，不替代独立技能资产。
- 独立 `kiwi-cloud-deploy` 候选的 22 个文件归档在 `skills/candidate-archives/kiwi-cloud-deploy/0.3.2/`，而非现有 canonical `skills/kiwi-cloud-deploy/`。
- 本次仅新增版本化归档，不替换 canonical 技能、专家旧版本、包构建输入或 Buddy 应用绑定。是否切换规范源/绑定须另行核对构建器与平台状态。
- 归档内容不包含工作区 `__pycache__`；ZIP 清单本身共 22 个文件。
