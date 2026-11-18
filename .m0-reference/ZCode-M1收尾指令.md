# ZCode 开发指令：M1 收尾接线

将下面整段贴给 ZCode。只做 M1 收尾，不要开始 M2。

---

你已完成的 M1 核心模块已通过独立验收：`npm run typecheck` 0、`npm run lint` 0、5 个定向测试 39/39 通过。当前只差启动接线与集成验证；请只做 M1 收尾，完成后停下报告，不要开始 M2。

## 工作区

- 只在 `/Users/jianghaidong/coding/kiwi-top1-3` 工作。
- 分支 `feat/top1-3-m0`。
- 禁止 `git commit` / `push` / `checkout` / `reset`；禁止部署、发布、改生产数据。
- 不修改 KNP wire、A2A 协议、公开 action。
- `.m0-reference/` 只读，不提交、不改。

## 现状

- 已有：`src/merchant-core/migrations/{ledgers,runner}.ts`、`src/merchant-core/context-governance/*`、`src/merchant-core/ownership/instance-ownership.ts`、`ops/schema.ts` v2 的 `instance_ownership` 表、5 个测试文件。
- 未完成：这些模块还没有接入 `src/cloud/bootstrap.ts` 的启动/装配路径；没有心跳续约；没有“第二进程 fail-closed”的启动级验证。

## 本工作包要做什么

### 1. 启动接线

在 `src/cloud/bootstrap.ts` 的 `state.sqlite` 装配处（约 725 行附近）接入：

- 调用 `registerGovernanceLedgers(db)`，确保三个独立账本与 `data_grants` 在功能装配前就绪；失败即 fail-closed，不启用新功能。
- 解析 governance feature flags（用 `loadGovernanceFeatureFlagsFromEnv` 或等价配置注入），默认全关。
- 仅当 `learning_enabled || memory_enabled || jobs_enabled` 为 true 时，才创建 `InstanceOwnershipService` 并 `acquire`：
  - `leaseMs` 默认 60_000；
  - `owner_id` 必须进程唯一（如 boot id / randomUUID），不能复用固定字符串；
  - 获取失败：**不启动新功能**，记录明确错误；现有接待/经营路径保持原行为；
  - 若你判断更安全的是直接启动失败，请先记录理由，但不得破坏现有路径的默认关闭行为。
- `customer_delivery_enabled` 必须保持 false；true 时启动失败（已有测试）。

### 2. 心跳与关闭

- 获取成功后启动心跳续约，间隔建议 `leaseMs / 3`（20 秒），timer `unref()`。
- 续约失败（`not_owner` / `lease_expired`）：
  - 停止新功能写入，记录 `ownership_lost`；
  - 不回滚已提交结果，不删除表；
  - 现有接待路径不受影响。
- 进程退出/关闭时尽力 `release`；释放失败只记录，不阻塞退出。
- 所有新功能入口在写入前调用 `assertOwner`（或注入的守卫）；旧 owner 提交必须被拒。

### 3. 集成测试

新增/补充测试，至少覆盖：

1. 三个开关全关：启动不 acquire、不改变现有路径；`registerGovernanceLedgers` 仍幂等执行。
2. 任一开关开启：启动 acquire 成功；心跳续约成功。
3. 第二个 `InstanceOwnershipService` 对同一商家 acquire 失败，且不启用新功能。
4. 租约过期后第二实例可接管，fencing 递增；旧实例 `assertOwner` 被拒。
5. 续约失败后新功能写入被拒，现有路径仍可运行。
6. `customer_delivery_enabled=true` 启动失败。

如果 bootstrap 集成测试成本过高，可先抽出 `initializeGovernanceRuntime({ db, flags, ownerId, now, leaseMs })` 纯函数/类，在测试中验证，再由 bootstrap 调用；不要为了测试复制一套逻辑。

### 4. 不做

- 不实现 M2 的 QuestionSpec、submitCorrection、候选/评测/发布、skill_summaries。
- 不实现 M3/M4 的记忆、检索、规则、任务执行。
- 不新增对外接口或 KNP 字段。
- 不提交、不部署。

## 验证与报告

运行：

```sh
npm run typecheck
npm run lint
npx vitest run tests/context-governance-actor-grants.test.ts tests/context-governance-migrations.test.ts tests/context-guard.test.ts tests/governance-feature-flags.test.ts tests/instance-ownership.test.ts
# 若有新增集成测试，一并运行
```

报告：

```
M1 收尾
改动文件：
接线位置：
新增测试与结果：
typecheck/lint：
未决问题：
下一步建议：
```

完成即停，不要进入 M2。
