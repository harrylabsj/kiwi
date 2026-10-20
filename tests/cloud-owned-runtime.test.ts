/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * B 卡（MANAGER-APPROVAL-SCOPE-v2 §B）正负控：owned 运行模式。
 *
 * 覆盖：off 默认与 require 严格校验、全新空目录初始化、legacy/partial 拒绝、
 * 并发 owner、跨重启计数与时间锚保持、上限终态、到期终态、进程内永久 stop
 * 与其读回、终态后重启拒绝、策略漂移拒绝、off 不得绕过既有 owned 状态。
 *
 * 只用临时目录与注入时钟，不触碰真实 profile/账本/网络。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadCloudConfig } from "../src/cloud/config.js";
import {
  classifyDataDir,
  ownedLayout,
  startOwnedRuntime,
  validateOwnedPolicy,
  createOwnedClock,
  ownedHostBootId,
  type OwnedPolicy,
} from "../src/cloud/owned-runtime.js";
import { assertNoOwnedStateForOff } from "../src/cloud/main.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 非临时目录（产品拒绝临时 dataDir；测试用家目录下的 scratch）。 */
function scratch(): string {
  const dir = mkdtempSync(path.join(homedir(), ".kiwi-owned-test-"));
  dirs.push(dir);
  return dir;
}

function policy(overrides: Partial<OwnedPolicy> = {}): OwnedPolicy {
  const now = Date.now();
  return {
    version: "1",
    policy_id: "policy-owned-1",
    window_id: "window-owned-1",
    window_start_utc: new Date(now - 60_000).toISOString(),
    window_end_utc: new Date(now + 3_600_000).toISOString(),
    caps: { business_requests: 3, mcp_calls: 2, core_starts: 2 },
    ...overrides,
  };
}

function baseEnv(dataDir: string, policyValue?: unknown): Record<string, string | undefined> {
  return {
    PORT: "8080",
    KIWI_CLOUD_PUBLIC_ORIGIN: "https://kiwi-merchant.example.app.workbuddy.host",
    KIWI_CLOUD_DATA_DIR: dataDir,
    KIWI_CLOUD_PROFILE: path.join(dataDir, "merchant.yaml"),
    KIWI_CLOUD_A2A_AUTH: "signature",
    KIWI_CATALOG_URL: "https://catalog.test",
    ...(policyValue !== undefined ? { KIWI_CLOUD_DATA_DIR: dataDir } : {}),
  };
}

function configWithOwned(dir: string, policyValue: unknown) {
  const dataDir = path.join(dir, "state");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(dir, "cloud.config.json");
  writeFileSync(
    configFile,
    `${JSON.stringify({ public_origin: "https://x.example.com", data_dir: dataDir, owned_runtime: "require", owned_policy: policyValue }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return loadCloudConfig(baseEnv(dataDir), { artifactRoot: dir, configFile });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("owned 配置校验（真实 loadCloudConfig）", () => {
  it("缺字段默认 off；非法值拒绝；require 缺 policy 拒绝", () => {
    const dir = scratch();
    const state = path.join(dir, "state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    expect(loadCloudConfig(baseEnv(state), { artifactRoot: dir }).ownedRuntime).toBe("off");

    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, `${JSON.stringify({ public_origin: "https://x.example.com", data_dir: state, owned_runtime: "on" })}\n`);
    expect(() => loadCloudConfig(baseEnv(state), { artifactRoot: dir, configFile: bad })).toThrow(/OWNED_RUNTIME_INVALID/);

    const missing = path.join(dir, "missing.json");
    writeFileSync(missing, `${JSON.stringify({ public_origin: "https://x.example.com", data_dir: state, owned_runtime: "require" })}\n`);
    expect(() => loadCloudConfig(baseEnv(state), { artifactRoot: dir, configFile: missing })).toThrow(/OWNED_POLICY_REQUIRED/);
  });

  it("策略严格校验：未知字段 / 非正 caps / 起止倒置 / 已过期 全部拒绝", () => {
    const now = Date.now();
    const ok = policy();
    expect(validateOwnedPolicy(ok, now).policy_id).toBe("policy-owned-1");
    expect(codeOf(() => validateOwnedPolicy({ ...ok, extra: 1 }, now))).toBe("OWNED_POLICY_INVALID");
    expect(codeOf(() => validateOwnedPolicy({ ...ok, caps: { ...ok.caps, mcp_calls: 0 } }, now))).toBe("OWNED_POLICY_INVALID");
    expect(codeOf(() => validateOwnedPolicy({ ...ok, window_end_utc: ok.window_start_utc }, now))).toBe("OWNED_POLICY_INVALID");
    expect(
      codeOf(() =>
        validateOwnedPolicy(
          { ...ok, window_start_utc: new Date(now - 7200_000).toISOString(), window_end_utc: new Date(now - 3600_000).toISOString() },
          now,
        ),
      ),
    ).toBe("OWNED_POLICY_EXPIRED");
  });

  it("off 不得绕过既有 owned 状态", () => {
    const dir = scratch();
    const state = path.join(dir, "state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    mkdirSync(ownedLayout(state).dir, { recursive: true, mode: 0o700 });
    const config = loadCloudConfig(baseEnv(state), { artifactRoot: dir });
    expect(() => assertNoOwnedStateForOff(config)).toThrow(/OWNED_RUNTIME_STATE_PRESENT_WITH_OFF/);
  });
});

describe("owned 配置→运行：require 经 loadCloudConfig 生效", () => {
  it("require + 合法策略 → 配置携带策略并可启动；off 时不携带策略", async () => {
    const dir = scratch();
    const config = configWithOwned(dir, policy());
    expect(config.ownedRuntime).toBe("require");
    expect(config.ownedPolicy?.policy_id).toBe("policy-owned-1");
    const handle = await startOwnedRuntime({
      dataDir: config.dataDir,
      policy: config.ownedPolicy!,
      bootstrap: async () => ({}),
    });
    expect(handle.status().counts.core_starts).toBe(1);
    await handle.close();

    const offConfig = loadCloudConfig(
      { PORT: "8080", KIWI_CLOUD_PUBLIC_ORIGIN: "https://x.example.com", KIWI_CLOUD_DATA_DIR: path.join(dir, "off-state"), KIWI_CLOUD_PROFILE: path.join(dir, "merchant.yaml"), KIWI_CLOUD_A2A_AUTH: "signature", KIWI_CATALOG_URL: "https://catalog.test" },
      { artifactRoot: path.join(dir, "off-artifact") },
    );
    expect(offConfig.ownedRuntime).toBe("off");
    expect(offConfig.ownedPolicy).toBeUndefined();
  });
});

describe("owned 运行生命周期", () => {
  it("全新空目录首启：core 预留 + processBoots=1 + 计数从 0", async () => {
    const dir = scratch();
    let booted = 0;
    const handle = await startOwnedRuntime({
      dataDir: dir,
      policy: policy(),
      bootstrap: async () => {
        booted += 1;
        expect(existsSync(ownedLayout(dir).ledger)).toBe(true);
        return { id: "instance-1" };
      },
    });
    expect(booted).toBe(1);
    const status = handle.status();
    expect(status.counts).toEqual({ business_requests: 0, mcp_calls: 0, core_starts: 1 });
    expect(status.process_boots).toBe(1);
    expect(status.terminal).toBe(false);
    await handle.close();
  });

  it("同窗重启：计数与时间锚保持，processBoots+1", async () => {
    const dir = scratch();
    const p = policy();
    const first = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    first.reserveBusiness();
    first.reserveMcp();
    const before = first.status();
    const anchorBefore = JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8")).anchor;
    await first.close();

    const second = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    const after = second.status();
    expect(after.counts.business_requests).toBe(before.counts.business_requests);
    expect(after.counts.mcp_calls).toBe(before.counts.mcp_calls);
    expect(after.counts.core_starts).toBe(before.counts.core_starts + 1);
    expect(after.process_boots).toBe(before.process_boots + 1);
    expect(JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8")).anchor).toEqual(anchorBefore);
    await second.close();
  });

  it("legacy 非空目录拒绝；partial owned 拒绝；并发 owner 拒绝", async () => {
    const legacy = scratch();
    writeFileSync(path.join(legacy, "merchant.yaml"), "merchant: x\n");
    await expect(
      startOwnedRuntime({ dataDir: legacy, policy: policy(), bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_LEGACY_STATE/);

    const partial = scratch();
    mkdirSync(ownedLayout(partial).dir, { recursive: true, mode: 0o700 });
    writeFileSync(ownedLayout(partial).journal, "");
    expect(classifyDataDir(partial, ownedLayout(partial))).toBe("PARTIAL");
    await expect(
      startOwnedRuntime({ dataDir: partial, policy: policy(), bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_STATE_UNKNOWN/);

    // 结构未知的 guard：不可判定存活 → UNKNOWN_OWNER（HOLD），不清锁。
    const unknown = scratch();
    const seed = await startOwnedRuntime({ dataDir: unknown, policy: policy(), bootstrap: async () => ({}) });
    await seed.close();
    writeFileSync(ownedLayout(unknown).guard, '{"token_hash":"someone"}\n', { mode: 0o600 });
    await expect(
      startOwnedRuntime({ dataDir: unknown, policy: policy(), bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_UNKNOWN_OWNER/);
    expect(existsSync(ownedLayout(unknown).guard)).toBe(true);

    // 同 host boot + 存活 pid → OWNER_BUSY。
    const hostBootId = ownedHostBootId(createOwnedClock().identity);
    const busy = scratch();
    const seedBusy = await startOwnedRuntime({ dataDir: busy, policy: policy(), bootstrap: async () => ({}) });
    await seedBusy.close();
    writeFileSync(
      ownedLayout(busy).guard,
      `${JSON.stringify({ schema: "kiwi.cloud.owned-owner-guard/1", token_hash: "x", host_boot_id: hostBootId, pid: process.pid, generation: 1, at_ms: Date.now() })}\n`,
      { mode: 0o600 },
    );
    await expect(
      startOwnedRuntime({ dataDir: busy, policy: policy(), bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_OWNER_BUSY/);

    // 跨 host boot（无法证明已死）→ UNKNOWN_OWNER。
    const crossBoot = scratch();
    const seedCross = await startOwnedRuntime({ dataDir: crossBoot, policy: policy(), bootstrap: async () => ({}) });
    await seedCross.close();
    writeFileSync(
      ownedLayout(crossBoot).guard,
      `${JSON.stringify({ schema: "kiwi.cloud.owned-owner-guard/1", token_hash: "x", host_boot_id: "different-boot", pid: 999999, generation: 1, at_ms: Date.now() })}\n`,
      { mode: 0o600 },
    );
    await expect(
      startOwnedRuntime({ dataDir: crossBoot, policy: policy(), bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_UNKNOWN_OWNER/);
  });

  it("上限：第 4 次业务预留触发终态并拒绝", async () => {
    const dir = scratch();
    const handle = await startOwnedRuntime({ dataDir: dir, policy: policy(), bootstrap: async () => ({}) });
    handle.reserveBusiness();
    handle.reserveBusiness();
    handle.reserveBusiness();
    expect(() => handle.reserveBusiness()).toThrow(/OWNED_BUSINESS_REQUESTS_EXHAUSTED/);
    const ledger = JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8"));
    expect(ledger.terminal).toBe(true);
    expect(ledger.terminal_reason).toBe("BUSINESS_REQUESTS_EXHAUSTED");
    expect(ledger.counts.business_requests).toBe(3);
  });

  it("自然业务终态后 stop 复用真实 reason/revision/hash，不重写终态", async () => {
    const dir = scratch();
    const p = policy({ caps: { business_requests: 1, mcp_calls: 2, core_starts: 2 } });
    const handle = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    handle.reserveBusiness();
    expect(() => handle.reserveBusiness()).toThrow(/OWNED_BUSINESS_REQUESTS_EXHAUSTED/);
    const before = JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8"));
    const result = await handle.stopPermanently();
    expect(result).toMatchObject({ status: "TERMINAL_CONFIRMED", reason: "BUSINESS_REQUESTS_EXHAUSTED", revision: before.revision });
    expect(result.ledger_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8"))).toEqual(before);
    await expect(handle.stopPermanently()).resolves.toEqual(result);
  });

  it.each([
    ["MCP_CALLS_EXHAUSTED", "reserveMcp"],
    ["CORE_STARTS_EXHAUSTED", "reserveCore"],
  ] as const)("自然 %s 终态后 stop 复用实际 reason", async (reason, method) => {
    const dir = scratch();
    const p = policy({ caps: { business_requests: 2, mcp_calls: method === "reserveMcp" ? 1 : 2, core_starts: method === "reserveCore" ? 1 : 2 } });
    const handle = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    if (method === "reserveMcp") expect(() => handle[method]()).not.toThrow();
    expect(() => handle[method]()).toThrow(new RegExp(`OWNED_${reason}`));
    const result = await handle.stopPermanently();
    expect(result).toMatchObject({ status: "TERMINAL_CONFIRMED", reason });
  });

  it("到期：预留触发 RUNTIME_WINDOW_ENDED 终态", async () => {
    const dir = scratch();
    const p = policy();
    let clock = Date.parse(p.window_start_utc) + 1_000;
    const handle = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}), now: () => clock });
    clock = Date.parse(p.window_end_utc) + 1;
    expect(() => handle.reserveBusiness()).toThrow(/OWNED_RUNTIME_WINDOW_EXPIRED/);
    const ledger = JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8"));
    expect(ledger.terminal).toBe(true);
    expect(ledger.terminal_reason).toBe("RUNTIME_WINDOW_ENDED");
  });

  it("进程内永久 stop：TERMINAL_CONFIRMED + 读回 + 重启拒绝", async () => {
    const dir = scratch();
    const p = policy();
    const handle = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    const result = await handle.stopPermanently();
    expect(result.status).toBe("TERMINAL_CONFIRMED");
    expect(result.reason).toBe("OWNER_STOPPED_PERMANENTLY");
    expect(result.ledger_sha256).toMatch(/^[a-f0-9]{64}$/);
    const ledger = JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8"));
    expect(ledger.terminal).toBe(true);
    expect(ledger.terminal_reason).toBe("OWNER_STOPPED_PERMANENTLY");

    await expect(
      startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_STOPPED_PERMANENTLY/);
  });

  it("真实 handle 的 stop 按序和并发重复调用都复用已确认终态", async () => {
    const dir = scratch();
    const handle = await startOwnedRuntime({ dataDir: dir, policy: policy(), bootstrap: async () => ({}) });
    const first = handle.stopPermanently();
    const concurrent = handle.stopPermanently();
    const [a, b] = await Promise.all([first, concurrent]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: "TERMINAL_CONFIRMED", reason: "OWNER_STOPPED_PERMANENTLY" });
    await expect(handle.stopPermanently()).resolves.toEqual(a);
  });

  it("到期后 stop 如实返回 RUNTIME_WINDOW_ENDED（不伪报 owner-stop）", async () => {
    const dir = scratch();
    const p = policy();
    let clock = Date.parse(p.window_start_utc) + 1_000;
    const handle = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}), now: () => clock });
    clock = Date.parse(p.window_end_utc) + 1;
    const result = await handle.stopPermanently();
    expect(result.status).toBe("TERMINAL_CONFIRMED");
    expect(result.reason).toBe("RUNTIME_WINDOW_ENDED");
  });

  it("策略漂移：同目录换 policy_id / window_id 被拒绝", async () => {
    const dir = scratch();
    const base = policy();
    const first = await startOwnedRuntime({ dataDir: dir, policy: base, bootstrap: async () => ({}) });
    await first.close();
    await expect(
      startOwnedRuntime({ dataDir: dir, policy: { ...base, policy_id: "other" }, bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_POLICY_DRIFT/);
  });

  it("账本/策略完整性：计数篡改、同 id 换 caps、未知字段、非法计数、journal 摘要漂移 全部 HOLD", async () => {
    const dir = scratch();
    const p = policy();
    const first = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    first.reserveBusiness();
    await first.close();
    const ledgerPath = ownedLayout(dir).ledger;
    const original = readFileSync(ledgerPath, "utf8");
    const tampered = (mutate: (value: Record<string, unknown>) => void): void => {
      const value = JSON.parse(original) as Record<string, unknown>;
      mutate(value);
      writeFileSync(ledgerPath, `${JSON.stringify(value, null, 2)}\n`);
    };

    // (a) 只改 counts，journal 不跟着变 → 摘要漂移
    tampered((value) => {
      (value.counts as Record<string, number>).business_requests = 0;
    });
    await expect(
      startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_LEDGER_DRIFT/);

    // (b) 同 policy_id 但换 caps（3→1）→ 策略内容漂移
    writeFileSync(ledgerPath, original);
    await expect(
      startOwnedRuntime({ dataDir: dir, policy: { ...p, caps: { ...p.caps, business_requests: 1 } }, bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_POLICY_DRIFT/);

    // (c) 未知字段 → 键集漂移
    tampered((value) => {
      value.unexpected = true;
    });
    await expect(
      startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_LEDGER_SCHEMA_DRIFT/);

    // (d) 非法计数（负数）+ 同步伪造 journal 摘要 → 界限校验（不是被摘要挡住）
    writeFileSync(ledgerPath, original);
    tampered((value) => {
      (value.counts as Record<string, number>).mcp_calls = -1;
    });
    {
      const { DatabaseSync } = await import("node:sqlite");
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(readFileSync(ledgerPath)).digest("hex");
      const db = new DatabaseSync(ownedLayout(dir).journal);
      db.prepare("UPDATE owner_state SET last_ledger_sha256 = ? WHERE id = 1").run(sha);
      db.close();
    }
    await expect(
      startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_LEDGER_BOUNDS/);
  });

  it("持久终态/锚点语义未知时在恢复前 HOLD", async () => {
    const dir = scratch();
    const p = policy({ caps: { business_requests: 1, mcp_calls: 2, core_starts: 2 } });
    const first = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    first.reserveBusiness();
    expect(() => first.reserveBusiness()).toThrow(/OWNED_BUSINESS_REQUESTS_EXHAUSTED/);
    await first.close();
    const ledgerPath = ownedLayout(dir).ledger;
    const original = readFileSync(ledgerPath, "utf8");
    const syncDigest = async (): Promise<void> => {
      const { DatabaseSync } = await import("node:sqlite");
      const { createHash } = await import("node:crypto");
      const db = new DatabaseSync(ownedLayout(dir).journal);
      db.prepare("UPDATE owner_state SET last_ledger_sha256 = ? WHERE id = 1").run(createHash("sha256").update(readFileSync(ledgerPath)).digest("hex"));
      db.close();
    };
    const mutateAndHold = async (mutate: (value: Record<string, unknown>) => void, code: RegExp): Promise<void> => {
      const value = JSON.parse(original) as Record<string, unknown>;
      mutate(value);
      writeFileSync(ledgerPath, `${JSON.stringify(value, null, 2)}\n`);
      await syncDigest();
      await expect(startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) })).rejects.toThrow(code);
      writeFileSync(ledgerPath, original);
      await syncDigest();
    };
    await mutateAndHold((value) => { value.terminal_reason = "UNKNOWN_REASON"; }, /OWNED_RUNTIME_TERMINAL_REASON_UNKNOWN/);
    await mutateAndHold((value) => { value.terminal = false; }, /OWNED_LEDGER_BOUNDS/);
    await mutateAndHold((value) => { (value.anchor as Record<string, unknown>).provider = "UNKNOWN_PROVIDER"; }, /OWNED_RUNTIME_CLOCK_IDENTITY_UNKNOWN/);
  });

  it("探针不删除既有目录内容（哨兵文件保留；重复启动不受污染）", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "unknown-preserve.txt"), "keep-me\n");
    // 非空且无 owned → LEGACY（证明探针没有先把目录清空）
    await expect(
      startOwnedRuntime({ dataDir: dir, policy: policy(), bootstrap: async () => ({}) }),
    ).rejects.toThrow(/OWNED_RUNTIME_LEGACY_STATE/);
    expect(readFileSync(path.join(dir, "unknown-preserve.txt"), "utf8")).toBe("keep-me\n");
  });

  it("真实进程崩溃后可接管（同 host boot + 已退出 pid）：generation+1 且保留 stale guard", async () => {
    const dir = scratch();
    const p = policy();
    const first = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    first.reserveBusiness();
    const before = first.status();
    // 模拟"进程崩溃"：guard 仍在，但持有者是一个已退出的真实进程。
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid ?? 0;
    expect(deadPid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
      const hostBootId = ownedHostBootId(createOwnedClock().identity);
    {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(ownedLayout(dir).journal);
      const row = db.prepare("SELECT token_hash FROM owner_state WHERE id = 1").get() as { token_hash: string };
      db.close();
      writeFileSync(
        ownedLayout(dir).guard,
        `${JSON.stringify({ schema: "kiwi.cloud.owned-owner-guard/1", token_hash: row.token_hash, host_boot_id: hostBootId, pid: deadPid, generation: 1, at_ms: Date.now() })}\n`,
        { mode: 0o600 },
      );
    }


    const second = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    const after = second.status();
    expect(after.counts.business_requests).toBe(before.counts.business_requests);
    expect(after.process_boots).toBe(before.process_boots + 1);
    const stale = (await import("node:fs")).readdirSync(ownedLayout(dir).dir).filter((name) => name.startsWith("owner.guard.stale-"));
    expect(stale.length).toBe(1);
    await second.close();
  });

  it("并发启动只有一个 owner（claim CAS），另一方无副作用", async () => {
    const dir = scratch();
    const p = policy();
    const results = await Promise.allSettled([
      startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({ id: "a" }) }),
      startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({ id: "b" }) }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: expect.stringMatching(/OWNED_RUNTIME_/) });
    const handle = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startOwnedRuntime>>>).value;
    // 只有一个 owner 预留了 core（没有重复 bootstrap 副作用）。
    expect(handle.status().counts.core_starts).toBe(1);
    await handle.close();
  });

  it("终态意图在崩溃边界不得丢失：intent 后 / ledger 后 / finalize 前 均前向恢复为终态", async () => {
    const p = policy();
    for (const phase of ["after-intent-commit", "after-ledger-replace"]) {
      const dir = scratch();
      const handle = await startOwnedRuntime({
        dataDir: dir,
        policy: p,
        bootstrap: async () => ({}),
        crashHook: (current) => {
          if (current === phase) throw new Error(`crash:${phase}`);
        },
      });
      await expect(handle.stopPermanently()).resolves.toMatchObject({ status: "HOLD" });
      // 模拟进程已死：把 guard/claim 的持有者改成一个真实已退出 pid。
      const { spawnSync } = await import("node:child_process");
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const hostBoot = ownedHostBootId(createOwnedClock().identity);
      {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(ownedLayout(dir).journal);
        const row = db.prepare("SELECT token_hash FROM owner_state WHERE id = 1").get() as { token_hash: string };
        db.close();
        writeFileSync(
          ownedLayout(dir).guard,
          `${JSON.stringify({ schema: "kiwi.cloud.owned-owner-guard/1", token_hash: row.token_hash, host_boot_id: hostBoot, pid: dead, generation: 1, at_ms: Date.now() })}\n`,
          { mode: 0o600 },
        );
      }
      // 崩溃后磁盘可能仍是"非终态 + pending"，重启必须前向应用意图并拒绝复活。
      const restarted = startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
      await expect(restarted).rejects.toThrow(/OWNED_RUNTIME_STOPPED_PERMANENTLY/);
      const ledger = JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8"));
      expect(ledger.terminal).toBe(true);
      expect(ledger.terminal_reason).toBe("OWNER_STOPPED_PERMANENTLY");
    }
  });

  it("stop 时 closeInstance 抛错：返回 HOLD（不 reject），终态已持久且不转发", async () => {
    const dir = scratch();
    const handle = await startOwnedRuntime({
      dataDir: dir,
      policy: policy(),
      bootstrap: async () => ({}),
      closeInstance: async () => {
        throw Object.assign(new Error("sdk close failed"), { code: "SDK_CLOSE_FAILED" });
      },
    });
    const result = await handle.stopPermanently();
    expect(result.status).toBe("HOLD");
    expect(result.code).toBe("SDK_CLOSE_FAILED");
    expect(result.reason).toBe("OWNER_STOPPED_PERMANENTLY");
    expect(handle.forwardingEnabled()).toBe(false);
    expect(JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8")).terminal).toBe(true);
  });

  it("pending 恢复只接受可验证操作：伪造 operation/base/target/计数回退/未知字段 全部 HOLD 且不改账本", async () => {
    const dir = scratch();
    const p = policy();
    const first = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    first.reserveBusiness();
    first.reserveBusiness();
    await first.close();
    const ledgerPath = ownedLayout(dir).ledger;
    const original = readFileSync(ledgerPath);
    const base = JSON.parse(original.toString("utf8"));
    const opsDir = await import("node:sqlite");

    const writePending = (pending: Record<string, unknown>): void => {
      const db = new opsDir.DatabaseSync(ownedLayout(dir).journal);
      db.prepare("UPDATE owner_state SET pending_json = ? WHERE id = 1").run(JSON.stringify(pending));
      db.close();
    };
    const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
    const { createHash } = await import("node:crypto");
    const currentOwner = (): { token_hash: string; generation: number } => {
      const db = new opsDir.DatabaseSync(ownedLayout(dir).journal);
      const row = db.prepare("SELECT token_hash, generation FROM owner_state WHERE id = 1").get() as { token_hash: string; generation: number };
      db.close();
      return row;
    };
    let tokenHash = currentOwner();

    // (a) 计数回退：target 把 business 2 → 0
    const rolled = { ...base, counts: { ...base.counts, business_requests: 0 }, revision: base.revision + 1 };
    const rolledBytes = Buffer.from(`${JSON.stringify(rolled, null, 2)}\n`);
    writePending({
      schema: "kiwi.cloud.owned-pending/1", operation_id: "terminal-x", kind: "terminal",
      generation: tokenHash.generation, token_hash: tokenHash.token_hash,
      base_sha256: sha(original), target_sha256: sha(rolledBytes), target_json: rolledBytes.toString("utf8"),
    });
    const rejected = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) }).then(
      () => undefined,
      (err: { code?: string }) => err.code,
    );
    expect(rejected).toBe("OWNED_RUNTIME_PENDING_DELTA");
    expect(readFileSync(ledgerPath).equals(original)).toBe(true);

    tokenHash = currentOwner();
    // (b) 未知字段
    writePending({
      schema: "kiwi.cloud.owned-pending/1", operation_id: "x", kind: "terminal",
      generation: tokenHash.generation, token_hash: tokenHash.token_hash,
      base_sha256: sha(original), target_sha256: sha(original), target_json: original.toString("utf8"),
      unexpected: true,
    });
    expect(
      await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) }).then(() => undefined, (e: { code?: string }) => e.code),
    ).toBe("OWNED_JOURNAL_CORRUPT");

    tokenHash = currentOwner();
    // (c) base 与当前文件不匹配
    const bumped = { ...base, counts: { ...base.counts, business_requests: base.counts.business_requests + 1 }, revision: base.revision + 1 };
    const bumpedBytes = Buffer.from(`${JSON.stringify(bumped, null, 2)}\n`);
    writePending({
      schema: "kiwi.cloud.owned-pending/1", operation_id: "x", kind: "count",
      generation: tokenHash.generation, token_hash: tokenHash.token_hash,
      base_sha256: "0".repeat(64), target_sha256: sha(bumpedBytes), target_json: bumpedBytes.toString("utf8"),
    });
    expect(
      await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) }).then(() => undefined, (e: { code?: string }) => e.code),
    ).toBe("OWNED_RUNTIME_PENDING_BASE_MISMATCH");
    expect(readFileSync(ledgerPath).equals(original)).toBe(true);
  });

  it("被接管的旧 owner 不能继续写（fencing）", async () => {
    const dir = scratch();
    const handle = await startOwnedRuntime({ dataDir: dir, policy: policy(), bootstrap: async () => ({}) });
    // 模拟另一进程完成接管：held=1 且 token 变为他人。
    {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(ownedLayout(dir).journal);
      db.prepare("UPDATE owner_state SET held = 1, token_hash = ? WHERE id = 1").run("other-owner-token");
      db.close();
    }
    expect(() => handle.reserveBusiness()).toThrow(/OWNED_RUNTIME_OWNER_FENCED/);
  });

  it("真实 HTTP 路由前置预留：A2A/MCP 请求消耗计数，超限返回 429 且无业务副作用", async () => {
    const dir = scratch();
    const p = policy({ caps: { business_requests: 1, mcp_calls: 2, core_starts: 1 } });
    const handle = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      try {
        if (pathname === "/a2a" || pathname.startsWith("/a2a/")) handle.reserveBusiness();
        else if (pathname === "/mcp" || pathname.startsWith("/mcp/")) handle.reserveMcp();
      } catch (error) {
        res.statusCode = 429;
        res.setHeader("content-type", "application/json");
        const refusedBody = JSON.stringify({ error: "reservation_refused", code: (error as { code?: string }).code });
        res.setHeader("content-length", Buffer.byteLength(refusedBody));
        res.end(refusedBody);
        return;
      }
      const ok = "{}";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", Buffer.byteLength(ok));
      res.end(ok);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const call = async (pathname: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST" });
      return { status: response.status, body: (await response.json()) as { code?: string } };
    };
    expect((await call("/a2a")).status).toBe(200);
    expect((await call("/mcp")).status).toBe(200);
    // 业务上限耗尽 → 终态；此后再请求一律拒绝（不静默放行）。
    const refused = await call("/a2a");
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("OWNED_BUSINESS_REQUESTS_EXHAUSTED");
    const afterTerminal = await call("/mcp");
    expect(afterTerminal.status).toBe(429);
    expect(afterTerminal.body.code).toBe("OWNED_RUNTIME_TERMINAL");
    const status = handle.status();
    expect(status.counts.business_requests).toBe(1);
    expect(status.counts.mcp_calls).toBe(1);
    expect(status.terminal).toBe(true);
    expect(status.terminal_reason).toBe("BUSINESS_REQUESTS_EXHAUSTED");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("bootstrap 消费同一份已校验配置（不再读盘，避免 TOCTOU）", async () => {
    const dir = scratch();
    const state = path.join(dir, "state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const configFile = path.join(dir, "cloud.config.json");
    writeFileSync(
      configFile,
      `${JSON.stringify({ public_origin: "https://x.example.com", data_dir: state }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const config = loadCloudConfig(baseEnv(state), { artifactRoot: dir, configFile });
    const { bootstrapCloudRuntime } = await import("../src/cloud/bootstrap.js");
    // 环境里给一个非法 dataDir：若 bootstrap 重新读盘会先报 DATA_DIR_*；
    // 传入 config 后应继续走到 profile 检查（PROFILE_*），证明确实使用了同一对象。
    const error = await bootstrapCloudRuntime({
      config,
      env: { ...baseEnv(state), KIWI_CLOUD_DATA_DIR: path.join("/tmp", "kiwi-owned-toctou") },
    }).then(
      () => undefined,
      (err: { code?: string }) => err,
    );
    expect(error?.code).toMatch(/^PROFILE_|^PROFILE_LOAD_FAILED$/);
  });

  it("close 可等待且不写终态（可恢复）", async () => {
    const dir = scratch();
    let closedInstance = 0;
    const handle = await startOwnedRuntime({
      dataDir: dir,
      policy: policy(),
      bootstrap: async () => ({}),
      closeInstance: async () => {
        closedInstance += 1;
      },
    });
    const result = await handle.close();
    expect(result.status).toBe("CLOSED");
    expect(result.terminal).toBe(false);
    expect(closedInstance).toBe(1);
    expect(JSON.parse(readFileSync(ownedLayout(dir).ledger, "utf8")).terminal).toBe(false);
  });
});
