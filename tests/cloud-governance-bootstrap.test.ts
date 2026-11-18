/**
 * M1 收尾：bootstrap 真实入口的 governance 接线集成验证（X12 / D-M0-08 / D-M0-09）。
 *
 * 独立审查指出的启动顺序问题：bootstrap 在 openMerchantOperationsFacade 的
 * ops 迁移之前调用 initializeGovernanceRuntime——新库首启 + 开关开启时，
 * acquire 曾因 instance_ownership 表不存在而失败（ownership_acquisition_failed:
 * no such table）。修复后由 runtime.start() 先行幂等迁移 merchant_ops schema。
 *
 * 本文件用真实 bootstrapCloudRuntime + 全新 dataDir 验证：
 *   1. 全新库 + 开关开启：启动即 acquire 成功（fencing=1、HELD），日志无
 *      acquisition_failed / no such table；三账本与 data_grants 已就绪；
 *   2. 全新库 + 全关：不 acquire、无所有权事件、现有路径默认行为不变；
 *   3. 同库顺序重启：释放后重新 acquire，fencing 递增（接管语义在真实入口生效）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapCloudRuntime, type CloudInstance } from "../src/cloud/bootstrap.js";
import { writeAdminCredentials } from "../src/auth/merchant-sessions.js";
import { stringify } from "yaml";
import { testProfile } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = typeof server.address() === "object" ? (server.address() as { port: number }).port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * 全新 dataDir（无 state.sqlite）：直接复现首次部署场景。
 * 目录位于 coding 工作区内的本次独占前缀下（mkdtemp 保证唯一）；不触碰
 * 生产持久目录（~/.kiwi），也不设置/覆盖 HOME 等 env——路径安全策略
 * （DATA_DIR_EPHEMERAL 等检查）照常生效。
 */
function freshState(): { dataDir: string; profilePath: string } {
  const base = path.join(process.cwd(), ".kiwi-cloud-test-m1");
  mkdirSync(base, { recursive: true });
  const dataDir = mkdtempSync(path.join(base, `governance-${process.pid}-`));
  dirs.push(dataDir);
  const profile = testProfile({
    commerce: { ...testProfile().commerce, allow_demo_price_fallback: false },
  });
  const profilePath = path.join(dataDir, "merchant.yaml");
  writeFileSync(profilePath, stringify(profile), { mode: 0o600 });
  writeAdminCredentials(dataDir, {
    principalId: profile.agent_id,
    merchantId: profile.owner_id,
    password: "fixture-governance-password",
  });
  return { dataDir, profilePath };
}

async function boot(
  dataDir: string,
  profilePath: string,
  governanceEnv: Record<string, string>,
  logs: string[],
): Promise<CloudInstance> {
  const port = await freePort();
  return bootstrapCloudRuntime({
    artifactRoot: path.resolve("."),
    catalogFetchImpl: async () => {
      throw new Error("UNEXPECTED_EXTERNAL_FIXTURE_CALL");
    },
    env: {
      KIWI_CATALOG_URL: "https://catalog.test",
      PORT: String(port),
      KIWI_CLOUD_BIND_HOST: "127.0.0.1",
      KIWI_CLOUD_PUBLIC_ORIGIN: "https://fixture-governance.example",
      KIWI_CLOUD_DATA_DIR: dataDir,
      KIWI_CLOUD_PROFILE: profilePath,
      KIWI_CLOUD_A2A_AUTH: "bearer:FIXTURE_GOVERNANCE_TOKEN",
      FIXTURE_GOVERNANCE_TOKEN: "fixture-only-token",
      ...governanceEnv,
    },
    log: (line: string) => logs.push(line),
  });
}

function governanceLines(logs: string[]): string[] {
  return logs.filter((line) => line.includes("governance:"));
}

function readOwnership(dataDir: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(dataDir, "state.sqlite"));
  try {
    return db
      .prepare("SELECT owner_id, fencing, state FROM instance_ownership ORDER BY merchant_id")
      .all() as unknown as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("bootstrap governance 接线（全新库 + 开关场景）", () => {
  it("全新库 + memory_enabled=true：启动即 acquire 成功，无 no-such-table", async () => {
    const { dataDir, profilePath } = freshState();
    const logs: string[] = [];
    const instance = await boot(dataDir, profilePath, { KIWI_GOVERNANCE_MEMORY_ENABLED: "true" }, logs);
    try {
      // 修复前症状：ownership_acquisition_failed: no such table: instance_ownership。
      const events = governanceLines(logs);
      expect(events.join("\n")).toContain("ownership_acquired fencing=1");
      expect(events.join("\n")).not.toContain("ownership_acquisition_failed");
      expect(logs.join("\n")).not.toContain("no such table");

      // 所有权真实落库：HELD、进程唯一 owner。
      const rows = readOwnership(dataDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fencing: 1, state: "HELD" });
      expect(String(rows[0]!.owner_id)).toMatch(/^boot_/);

      // 功能装配前就绪：三账本 + data_grants。
      const db = new DatabaseSync(path.join(dataDir, "state.sqlite"));
      try {
        const ledgerCounts = db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM learning_schema_migrations) AS learning," +
              "(SELECT COUNT(*) FROM customer_memory_schema_migrations) AS memory," +
              "(SELECT COUNT(*) FROM operations_jobs_schema_migrations) AS jobs",
          )
          .get() as { learning: number; memory: number; jobs: number };
        expect(ledgerCounts).toEqual({ learning: 3, memory: 5, jobs: 3 });
        // data_grants 存在且为空（M1 无授权写入路径）。
        expect(db.prepare("SELECT COUNT(*) AS n FROM data_grants").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    } finally {
      await instance.close();
    }
    // 关闭释放所有权。
    expect(governanceLines(logs).join("\n")).toContain("ownership_released");
    expect(readOwnership(dataDir)).toMatchObject([{ state: "RELEASED" }]);
  });

  it("全新库 + 全关：不 acquire、无所有权事件，账本仍注册（现有路径默认行为不变）", async () => {
    const { dataDir, profilePath } = freshState();
    const logs: string[] = [];
    const instance = await boot(dataDir, profilePath, {}, logs);
    try {
      expect(governanceLines(logs)).toEqual(["[kiwi] governance: ledgers_registered"]);
      expect(readOwnership(dataDir)).toHaveLength(0);
      expect(logs.join("\n")).not.toContain("ownership_acquired");
    } finally {
      await instance.close();
    }
  });

  it("同库顺序重启：释放后重新 acquire，fencing 递增到 2", async () => {
    const { dataDir, profilePath } = freshState();
    const logs1: string[] = [];
    const first = await boot(dataDir, profilePath, { KIWI_GOVERNANCE_MEMORY_ENABLED: "true" }, logs1);
    await first.close();
    expect(readOwnership(dataDir)).toMatchObject([{ state: "RELEASED", fencing: 1 }]);

    const logs2: string[] = [];
    const second = await boot(dataDir, profilePath, { KIWI_GOVERNANCE_MEMORY_ENABLED: "true" }, logs2);
    try {
      expect(governanceLines(logs2).join("\n")).toContain("ownership_acquired fencing=2");
      expect(readOwnership(dataDir)).toMatchObject([{ state: "HELD", fencing: 2 }]);
    } finally {
      await second.close();
    }
  });
});
