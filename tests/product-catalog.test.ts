/**
 * `kiwi catalog serve` 单元测试（CURRENT-DOCS v0.7.0）。
 *
 * 覆盖：参数构造（--db/--host/--port 缺省与显式）、ENOENT 引导提示、
 * 非零退出 fail-closed、Ctrl+C（status null）视为正常。
 */
import { describe, expect, it } from "vitest";
import type { spawnSync } from "node:child_process";
import { catalogServe } from "../src/product-catalog.js";

function spawnMock(
  outcome: () => { status: number | null; stdout?: string; stderr?: string },
  track?: Array<{ cmd: string; args: string[] }>,
): typeof spawnSync {
  return ((cmd: string, args: string[]) => {
    track?.push({ cmd, args });
    return outcome() as ReturnType<typeof spawnSync>;
  }) as unknown as typeof spawnSync;
}

describe("catalogServe", () => {
  it("forwards to kiwi-catalog-api with defaults", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const result = catalogServe({
      spawnImpl: spawnMock(
        () => ({ status: 0 }),
        calls,
      ),
    });
    expect(result).toEqual({ ok: true, spawned: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("kiwi-catalog-api");
    expect(calls[0]?.args).toEqual(["--db", "./kiwi-catalog.sqlite", "--host", "127.0.0.1", "--port", "8600"]);
  });

  it("forwards explicit --db/--host/--port", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    catalogServe({
      db: "/data/catalog.sqlite",
      host: "0.0.0.0",
      port: 8601,
      spawnImpl: spawnMock(() => ({ status: 0 }), calls),
    });
    expect(calls[0]?.args).toEqual(["--db", "/data/catalog.sqlite", "--host", "0.0.0.0", "--port", "8601"]);
  });

  it("ENOENT fails closed with pip install hint", () => {
    // spawnSync 的 ENOENT 形态：{ error: ENOENT, status: null }（不抛异常）
    const err = new Error("spawn kiwi-catalog-api ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    const result = catalogServe({
      spawnImpl: (() => ({ error: err, status: null })) as unknown as typeof spawnSync,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("pip install");
    expect(result.error).toContain("kiwi-catalog");
  });

  it("non-zero exit fails closed", () => {
    const result = catalogServe({
      spawnImpl: spawnMock(() => ({ status: 2, stderr: "boom" })),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出码 2");
  });

  it("SIGINT (status null) counts as normal stop", () => {
    const result = catalogServe({
      spawnImpl: spawnMock(() => ({ status: null })),
    });
    expect(result).toEqual({ ok: true, spawned: true });
  });
});
