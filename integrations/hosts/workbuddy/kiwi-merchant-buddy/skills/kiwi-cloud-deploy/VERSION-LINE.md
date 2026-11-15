# kiwi-cloud-deploy 版本线（2026-11-14）

本目录有多个来源，容易混淆；发布前先确认自己在改哪一条线。

| 线 | 版本 | 位置 | 状态 | 用途 |
|---|---:|---|---|---|
| 平台已发布独立技能 | **0.3.2** | `skills/candidate-archives/kiwi-cloud-deploy/0.3.2/` | 已发布（approved，2026-11-05） | 平台市场「Kiwi 云端接待部署」的线上版本 |
| 本仓活动源 | **0.2.6** | `skills/kiwi-cloud-deploy/` | 历史线，**禁止直接重打包覆盖线上** | 含 `references/release.json` 与 `package/` 审核副本，供旧流程/审阅使用 |
| 开通顾问内嵌候选 | **0.3.6** | `experts/kiwi-onboarding-advisor-0.1.9/skills/kiwi-cloud-deploy/` | 本地候选，未独立发布 | 专家包内副本；真实安装/升级语义 |

## 规则

1. **不要把活动源 0.2.6 打成平台更新包**。`build-asset-zips.mjs` 会把它标为 HOLD（版本与平台 0.2.5 快照不一致），不要绕过。
2. 若要发布独立技能更新，从 **0.3.2** 或 **0.3.6** 起版本号递增，先作为新候选归档并走平台审核；不要直接把 0.2.6 改成 0.3.2。
3. 0.3.2 仍保留 `executionAuthorized:false` 的 test-only 门；0.3.6 才改为“用户明确要求 + 完整性校验通过即执行”。两者不能混用文档。
4. 平台不提供包哈希回读；线上内容以平台资产版本与审核状态为准，本仓归档只能证明候选来源。
5. **provenance 范围（0.3.6 起，有意收窄）**：0.3.2 要求全依赖树每个包都有 Sigstore attestation；npm audit 对大量无 attestation 的传递依赖本就非零退出，0.3.6 收窄为**仅目标包 `@harrylabsj/kiwi-merchant-cloud` 强制 attestation**（SRI + SAN + subject digest + OID 1.13 source commit 全部钉死），传递依赖改由 `npm install --ignore-scripts` 与 audit 输出兜底。这是放宽，不是收紧；平台侧若要求全链 provenance，从这里回退。
6. 0.3.6 的 verify 对 `AUDIT_NOT_CLEAN/TARGET_NOT_VERIFIED/AUDIT_FAILED` 自动重试一次（同一 session、同版本同 tarball，2s 后），应对 attestation 读取的瞬时失败；确定性失败重试后仍会停止。
