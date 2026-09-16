/**
 * Merchant 能力探测与版本锁定测试（V2 阶段一/P0-5）：
 * - probeCapabilities：健康 + 版本在已验证范围 → 能力清单（listing_pause /
 *   resolve_review 已知缺失标定 false）；
 * - 网关故障 / 版本缺失 / 版本超上限 → fail-closed（ok:false，能力全 false，
 *   不产生报价、不编造数据）；
 * - persistPath 落盘可查询（版本组合锁定：先记录探测结果）；
 * - merchant 数据目录接线（V2 §5.1）：显式 merchantDataDir / principalDataDir /
 *   transportSessionId；多传输会话共享同一 merchantDataDir；重启路径稳定；
 *   transportSessionId 不参与路径派生。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMerchantClient } from "../src/agent/merchant/merchant-client.js";
import { collectMerchantHealth } from "../src/merchant-runtime/health.js";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import {
  resolveMerchantMcpDirs,
  STATELESS_TRANSPORT_SESSION_ID,
} from "../src/mcp/merchant-dirs.js";

const T0 = "2026-09-15T10:00:00.000Z";

function healthResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWithHealth(handler: (url: string) => Response): HttpMerchantClient {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => handler(String(input))),
  );
  return new HttpMerchantClient(
    "http://127.0.0.1:8765",
    new StaticCredentialBroker({ catalog: "t" }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeCapabilities（能力探测）", () => {
  it("健康 + 已验证版本 → ok，能力清单标定（listing_pause/resolve_review=false）", async () => {
    const client = clientWithHealth(() => healthResponse({ ok: true, version: "2.1.0" }));
    const probe = await client.probeCapabilities({ now: () => T0 });
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe("2.1.0");
    expect(probe.version_supported).toBe(true);
    expect(probe.capabilities).toEqual({
      catalog_read: true,
      catalog_write: true,
      inventory_write: true,
      listing_pause: false,
      resolve_review: false,
    });
    expect(probe.probed_at).toBe(T0);
  });

  it("网关不可达 → fail-closed（ok:false，能力全 false）", async () => {
    const client = clientWithHealth(() => {
      throw new Error("connection refused");
    });
    const probe = await client.probeCapabilities({ now: () => T0 });
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("不可达");
    expect(Object.values(probe.capabilities).every((v) => v === false)).toBe(true);
  });

  it("版本缺失或超出已验证上限 → 不支持（版本组合锁定）", async () => {
    const noVersion = clientWithHealth(() => healthResponse({ ok: true }));
    const p1 = await noVersion.probeCapabilities({ now: () => T0 });
    expect(p1.version_supported).toBe(false);
    expect(p1.ok).toBe(false);

    const tooNew = clientWithHealth(() => healthResponse({ ok: true, version: "3.0.0" }));
    const p2 = await tooNew.probeCapabilities({ now: () => T0 });
    expect(p2.version_supported).toBe(false);
    expect(p2.ok).toBe(false);
    expect(p2.error).toContain(">= 2.0.0 < 3.0.0");

    const tooOld = clientWithHealth(() => healthResponse({ ok: true, version: "1.9.9" }));
    expect((await tooOld.probeCapabilities()).version_supported).toBe(false);
  });

  it("persistPath 落盘（0600，可查询；锁定实测版本组合）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-probe-"));
    try {
      const file = path.join(dir, "capability-probe.json");
      const client = clientWithHealth(() => healthResponse({ ok: true, version: "2.1.0" }));
      await client.probeCapabilities({ now: () => T0, persistPath: file });
      const saved = JSON.parse(readFileSync(file, "utf8")) as { version?: string; ok: boolean };
      expect(saved.ok).toBe(true);
      expect(saved.version).toBe("2.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("merchant 数据目录接线（V2 §5.1）", () => {
  it("显式三槽位：多传输会话共享 merchantDataDir，重启路径稳定", () => {
    const a = resolveMerchantMcpDirs({ agentId: "merchant-agent:merchant-001" });
    const b = resolveMerchantMcpDirs({ agentId: "merchant-agent:merchant-001" });
    // 重启稳定：纯函数，同输入同路径
    expect(b).toEqual(a);
    // 传输会话只是观测标签，不影响目录
    expect(a.transportSessionId).toBe(STATELESS_TRANSPORT_SESSION_ID);
    expect(a.merchantDataDir).not.toContain(a.transportSessionId);
    // 显式 dataDir 优先
    const explicit = resolveMerchantMcpDirs({
      dataDir: "/tmp/kiwi-merchant-data",
      agentId: "merchant-agent:merchant-001",
    });
    expect(explicit.merchantDataDir).toBe("/tmp/kiwi-merchant-data");
    expect(explicit.principalDataDir).toBe("/tmp/kiwi-merchant-data");
  });

  it("agentId 路径消毒（防路径逃逸）", () => {
    expect(() => resolveMerchantMcpDirs({ agentId: "../evil" })).toThrow();
  });
});

describe("BUG-05：商品源健康检查不依赖陈旧探测文件", () => {
  it("启动正常 → shopping-cli 宕机 → 实时再探测后健康变失败（一个探测周期语义）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-bug05-"));
    try {
      const probePath = path.join(dir, "capability-probe.json");
      let up = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (!up) throw new Error("connection refused");
          return healthResponse({ ok: true, version: "2.1.0" });
        }),
      );
      const client = new HttpMerchantClient(
        "http://127.0.0.1:8765",
        new StaticCredentialBroker({ catalog: "t" }),
      );
      // 周期 1：实时探测（正常）→ 健康 ok
      await client.probeCapabilities({ persistPath: probePath });
      const r1 = collectMerchantHealth({
        dataDir: dir,
        services: [],
        now: () => new Date().toISOString(),
      });
      expect(r1.checks.product_source.ok).toBe(true);
      // shopping-cli 宕机 → 周期 2：实时再探测（失败）→ 记录刷新为不可用 → 健康失败
      up = false;
      await client.probeCapabilities({ persistPath: probePath });
      const r2 = collectMerchantHealth({
        dataDir: dir,
        services: [],
        now: () => new Date().toISOString(),
      });
      expect(r2.checks.product_source.ok).toBe(false);
      expect(r2.alerts.some((a) => a.code === "product_source_unavailable")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("探测记录超过最大有效期 → 判 unhealthy（记录过期）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-bug05-stale-"));
    try {
      writeFileSync(
        path.join(dir, "capability-probe.json"),
        JSON.stringify({ ok: true, version: "2.1.0", probed_at: "2026-09-15T10:00:00.000Z" }),
      );
      const report = collectMerchantHealth({
        dataDir: dir,
        services: [],
        now: () => "2026-09-15T10:10:00.000Z", // 10 分钟前探测 → 过期
        probeMaxAgeMs: 180_000,
      });
      expect(report.checks.product_source.ok).toBe(false);
      expect(report.checks.product_source.error).toContain("过期");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("探测记录缺 probed_at → unhealthy（不可判定即失败）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-bug05-nodate-"));
    try {
      writeFileSync(
        path.join(dir, "capability-probe.json"),
        JSON.stringify({ ok: true, version: "2.1.0" }),
      );
      const report = collectMerchantHealth({
        dataDir: dir,
        services: [],
        now: () => new Date().toISOString(),
      });
      expect(report.checks.product_source.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
