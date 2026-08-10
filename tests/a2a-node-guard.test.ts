// A2A 节点守卫测试（审查 BUG-02 公网认证边界 + BUG-03 持久目录/单 owner）
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
