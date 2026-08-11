// A2A 节点守卫测试（审查 BUG-02 公网认证边界 + BUG-03 持久目录/单 owner）
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startA2aNode } from "../src/a2a/node.js";
import { NoneAuthVerifier } from "../src/a2a/server/index.js";
import { testProfile } from "./helpers.js";

const workDirs: string[] = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const buyerProfile = () => testProfile({ role: "buyer" });

/** 临时设置/清除 KIWI_A2A_AUTH，结束后恢复原值。 */
const withAuthEnv = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
  const saved = process.env.KIWI_A2A_AUTH;
  if (value === undefined) delete process.env.KIWI_A2A_AUTH;
  else process.env.KIWI_A2A_AUTH = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.KIWI_A2A_AUTH;
    else process.env.KIWI_A2A_AUTH = saved;
  }
};

describe("A2A 节点守卫（BUG-02/BUG-03）", () => {
  it("公网广告地址未配置 authVerifier → 启动失败（fail-closed）", async () => {
    await expect(
      startA2aNode({
        profile: buyerProfile(),
        publicBaseUrl: "https://merchant.example.com",
        preferredPort: 0,
      }),
    ).rejects.toThrow(/authVerifier/);
  });

  it("公网广告地址配置 authVerifier → 正常启动", async () => {
    const node = await startA2aNode({
      profile: buyerProfile(),
      publicBaseUrl: "https://merchant.example.com",
      preferredPort: 0,
      authVerifier: new NoneAuthVerifier(),
    });
    expect(node.advertisedUrl).toBe("https://merchant.example.com");
    await node.stop();
  });

  it("loopback 形态缺省认证（本机可信）不受影响", async () => {
    const node = await startA2aNode({ profile: buyerProfile(), preferredPort: 0 });
    expect(node.advertisedUrl.startsWith("http://127.0.0.1:")).toBe(true);
    await node.stop();
  });

  it("持久形态：stop 不删除状态目录，可重启（owner 锁释放）", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-node-guard-"));
    workDirs.push(dataDir);

    const first = await startA2aNode({
      profile: buyerProfile(),
      preferredPort: 0,
      dataDir,
    });
    const stateDir = path.join(dataDir, "a2a");
    expect(existsSync(stateDir)).toBe(true);
    await first.stop();
    // 持久形态不删除目录（BUG-03：重启恢复依赖它）
    expect(existsSync(stateDir)).toBe(true);

    // 重启：同目录再启动成功（owner 锁已释放）
    const second = await startA2aNode({
      profile: buyerProfile(),
      preferredPort: 0,
      dataDir,
    });
    await second.stop();
  });

  it("单 owner：存活实例持有状态目录时二次启动失败", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-node-owner-"));
    workDirs.push(dataDir);

    const first = await startA2aNode({
      profile: buyerProfile(),
      preferredPort: 0,
      dataDir,
    });
    try {
      await expect(
        startA2aNode({ profile: buyerProfile(), preferredPort: 0, dataDir }),
      ).rejects.toThrow(/已被其他进程占用/);
    } finally {
      await first.stop();
    }
    // 释放后恢复
    const after = await startA2aNode({
      profile: buyerProfile(),
      preferredPort: 0,
      dataDir,
    });
    await after.stop();
  });
});


// ── KIWI_A2A_AUTH env 解析 + loopback 公网警告（审查 P2-E / P3-12，2026-08-11）─
//
// P2-E：loopback 模式 + 公网广告地址是部署脚枪——节点只绑定 127.0.0.1，经
// 反代转发的公网流量在应用层全是 loopback 被放行（等价 none）。不改默认
// 行为，但启动时输出醒目 stderr 警告（认证责任全在反代，公网应 bearer）。
// P3-12：KIWI_A2A_AUTH env 解析此前零覆盖——各模式逐一锁定。

describe("KIWI_A2A_AUTH env 解析（P3-12）", () => {
  const tasksGet = (node: { url: string }, headers: Record<string, string> = {}) =>
    fetch(node.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tasks/get", params: { id: "task_x" } }),
    });

  it("bearer:<token> → 静态 Bearer 校验生效（无头 401 / 错 token 403 / 对 token 放行）", async () => {
    await withAuthEnv("bearer:topsecret", async () => {
      const node = await startA2aNode({
        profile: buyerProfile(),
        publicBaseUrl: "https://merchant.example.com",
        preferredPort: 0,
      });
      try {
        expect((await tasksGet(node)).status).toBe(401);
        expect((await tasksGet(node, { authorization: "Bearer wrong" })).status).toBe(403);
        expect((await tasksGet(node, { authorization: "Bearer topsecret" })).status).toBe(200);
      } finally {
        await node.stop();
      }
    });
  });

  it("none → 无认证放行（公网形态下显式选择）", async () => {
    await withAuthEnv("none", async () => {
      const node = await startA2aNode({
        profile: buyerProfile(),
        publicBaseUrl: "https://merchant.example.com",
        preferredPort: 0,
      });
      try {
        expect((await tasksGet(node)).status).toBe(200);
      } finally {
        await node.stop();
      }
    });
  });

  it("未知模式 / bearer 空 token → 启动失败（不静默回落）", async () => {
    await withAuthEnv("basic", async () => {
      await expect(
        startA2aNode({ profile: buyerProfile(), preferredPort: 0 }),
      ).rejects.toThrow(/未知模式/);
    });
    await withAuthEnv("bearer:", async () => {
      await expect(
        startA2aNode({ profile: buyerProfile(), preferredPort: 0 }),
      ).rejects.toThrow(/非空 token/);
    });
  });

  it("未配置 + 公网广告地址 → fail-closed 拒绝启动（既有守卫，经 env 路径锁定）", async () => {
    await withAuthEnv(undefined, async () => {
      await expect(
        startA2aNode({
          profile: buyerProfile(),
          publicBaseUrl: "https://merchant.example.com",
          preferredPort: 0,
        }),
      ).rejects.toThrow(/authVerifier/);
    });
  });
});

describe("loopback 模式公网警告（P2-E）", () => {
  it("KIWI_A2A_AUTH=loopback + 公网广告地址 → 启动成功但输出醒目 stderr 警告", async () => {
    await withAuthEnv("loopback", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const node = await startA2aNode({
          profile: buyerProfile(),
          publicBaseUrl: "https://merchant.example.com",
          preferredPort: 0,
        });
        await node.stop();
        const written = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
        expect(written).toContain("KIWI_A2A_AUTH=loopback");
        expect(written).toContain("https://merchant.example.com");
        expect(written).toContain("bearer:<token>");
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  it("loopback 模式 + 本地形态（loopback 广告地址）→ 无警告（默认行为不变）", async () => {
    await withAuthEnv("loopback", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const node = await startA2aNode({ profile: buyerProfile(), preferredPort: 0 });
        await node.stop();
        const written = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
        expect(written).not.toContain("bearer:<token>");
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  it("bearer 模式 + 公网广告地址 → 无 loopback 警告", async () => {
    await withAuthEnv("bearer:topsecret", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const node = await startA2aNode({
          profile: buyerProfile(),
          publicBaseUrl: "https://merchant.example.com",
          preferredPort: 0,
        });
        await node.stop();
        const written = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
        expect(written).not.toContain("KIWI_A2A_AUTH=loopback");
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
