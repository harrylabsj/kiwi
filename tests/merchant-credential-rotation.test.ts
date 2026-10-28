import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateMerchantCredential } from "../src/merchant-credential-rotation.js";

const dirs: string[] = [];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
const previousShoppingToken = process.env.SHOPPING_MERCHANT_TOKEN;
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-credential-rotation-"));
  dirs.push(dir);
  const credentialsPath = path.join(dir, "credentials.env");
  const pendingPath = path.join(dir, "credential-rotation.json");
  writeFileSync(credentialsPath, "# preserve this\nKIWI_MERCHANT_TOKEN=catalog-secret\nSHOPPING_MERCHANT_TOKEN=shopping_merchant_old-secret-0123456789\nOTHER_KEY=keep\n", { mode: 0o600 });
  return { dir, credentialsPath, pendingPath, old: "shopping_merchant_old-secret-0123456789" };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  if (previousShoppingToken === undefined) delete process.env.SHOPPING_MERCHANT_TOKEN;
  else process.env.SHOPPING_MERCHANT_TOKEN = previousShoppingToken;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("credential rotation edge cases", () => {
  it("keeps a gateway sub-path prefix on every rotation endpoint", async () => {
    const f = fixture();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/prepare")) return response({ status: "pending" });
      if (url.endsWith("/private-config")) return response({ merchant_id: "seller-a" });
      return response({ status: "confirmed" });
    });
    await rotateMerchantCredential({
      baseUrl: "https://shopping.example/gateway", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, fetchImpl,
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      runningServices: () => [],
      startRuntime: async () => undefined,
    });
    expect(urls).toEqual([
      "https://shopping.example/gateway/merchants/seller-a/token/rotate/prepare",
      "https://shopping.example/gateway/merchants/seller-a/private-config",
      "https://shopping.example/gateway/merchants/seller-a/token/rotate/confirm",
    ]);
  });

  it("accepts IPv6 loopback over HTTP and normalises it when matching the sidecar", async () => {
    const f = fixture();
    const fetchImpl = vi.fn(async (input: URL | string | Request) => {
      const url = String(input);
      if (url.endsWith("/prepare")) return response({ status: "pending" });
      if (url.endsWith("/private-config")) return response({ merchant_id: "seller-a" });
      return response({ status: "confirmed" });
    });
    const first = await rotateMerchantCredential({
      baseUrl: "http://[::1]:8765", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, fetchImpl,
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      runningServices: () => [],
      startRuntime: async () => undefined,
    });
    expect(first.rotated).toBe(true);
  });

  it("does not wait for an A2A proof when only mcp was restarted, and always clears the switch marker", async () => {
    const f = fixture();
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string | Request) => {
      const url = String(input);
      if (url.endsWith("/prepare")) return response({ status: "pending" });
      if (url.endsWith("/private-config")) return response({ merchant_id: "seller-a" });
      return response({ status: "confirmed" });
    });
    const result = await rotateMerchantCredential({
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, fetchImpl,
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      runningServices: () => ["mcp"],
      beginRuntimeSwitch: () => events.push("marker-set"),
      endRuntimeSwitch: () => events.push("marker-cleared"),
      stopServices: async () => undefined,
      startRuntime: async () => undefined,
      waitForRuntimeCredential: async () => { throw new Error("must not be called when a2a is not restarted"); },
    });
    expect(result.rotated).toBe(true);
    expect(events[0]).toBe("marker-set");
    expect(events.at(-1)).toBe("marker-cleared");
  });

  it("releases the switch marker even when confirmation fails", async () => {
    const f = fixture();
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string | Request) => {
      const url = String(input);
      if (url.endsWith("/prepare")) return response({ status: "pending" });
      if (url.endsWith("/private-config")) return response({ merchant_id: "seller-a" });
      return response({ status: "rejected" });
    });
    await expect(
      rotateMerchantCredential({
        baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
        credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, fetchImpl,
        randomToken: () => "shopping_merchant_replacement-secret-012345678901",
        randomRotationId: () => "rotation-id-1234567890-abcdefgh",
        runningServices: () => ["mcp"],
        beginRuntimeSwitch: () => events.push("marker-set"),
        endRuntimeSwitch: () => events.push("marker-cleared"),
        stopServices: async () => undefined,
        startRuntime: async () => undefined,
      }),
    ).rejects.toThrow(/did not confirm/);
    expect(events).toContain("marker-cleared");
  });
});

describe("managed merchant credential rotation", () => {
  it("persists the candidate before prepare, verifies it, then switches and restarts managed services", async () => {
    const f = fixture();
    const calls: Array<{ url: string; token: string; body?: string }> = [];
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string | Request, init?: FetchInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, token: headers.get("authorization") ?? "", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.endsWith("/prepare")) {
        expect(existsSync(f.pendingPath)).toBe(true);
        expect(statSync(f.pendingPath).mode & 0o777).toBe(0o600);
        return response({ status: "pending" });
      }
      if (url.endsWith("/private-config")) return response({ merchant_id: "seller-a" });
      if (url.endsWith("/confirm")) expect(events).toContain("start-new");
      return response({ status: "confirmed" });
    });
    let stopped: string[] = [];
    let restarted: string[] = [];
    const result = await rotateMerchantCredential({
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN", credentialsPath: f.credentialsPath, pendingPath: f.pendingPath,
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      fetchImpl,
      runningServices: () => ["a2a", "mcp"],
      stopServices: async (services) => { stopped = services; },
      startRuntime: async (services) => { events.push("start-new"); restarted = services; expect(readFileSync(f.credentialsPath, "utf8")).toContain("SHOPPING_MERCHANT_TOKEN=shopping_merchant_replacement-secret-012345678901"); expect(readFileSync(f.credentialsPath, "utf8")).toContain("KIWI_MERCHANT_TOKEN=catalog-secret"); },
      waitForRuntimeCredential: async (token) => { expect(token).toContain("replacement-secret"); events.push("runtime-probed-new-token"); },
    });
    expect(result).toMatchObject({ rotated: true, recovered: false, restarted: ["a2a", "mcp"] });
    expect(stopped).toEqual(["a2a", "mcp"]);
    expect(restarted).toEqual(stopped);
    expect(readFileSync(f.credentialsPath, "utf8")).toContain("OTHER_KEY=keep");
    expect(statSync(f.credentialsPath).mode & 0o777).toBe(0o600);
    expect(existsSync(f.pendingPath)).toBe(false);
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual(["prepare", "private-config", "confirm"]);
    expect(calls[2]?.token).toContain("replacement-secret");
    expect(events).toEqual(["start-new", "runtime-probed-new-token"]);
  });

  it("recovers after a lost confirm response by proving and confirming the staged token", async () => {
    const f = fixture();
    let failConfirm = true;
    const stopServices = vi.fn(async () => undefined);
    const startRuntime = vi.fn(async () => undefined);
    let switchMarker = false;
    const base = {
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN", credentialsPath: f.credentialsPath, pendingPath: f.pendingPath,
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      runningServices: () => ["a2a"], stopServices, startRuntime,
      waitForRuntimeCredential: async () => undefined,
      beginRuntimeSwitch: () => { switchMarker = true; },
      endRuntimeSwitch: () => { switchMarker = false; },
    };
    const firstFetch = async (input: URL | string | Request) => {
      if (String(input).endsWith("/prepare")) return response({ status: "pending" });
      if (String(input).endsWith("/private-config")) return response({ merchant_id: "seller-a" });
      if (failConfirm) { failConfirm = false; throw new Error("connection lost after confirm request"); }
      return response({ status: "confirmed" });
    };
    await expect(rotateMerchantCredential({ ...base, fetchImpl: firstFetch })).rejects.toThrow("connection lost");
    expect(readFileSync(f.credentialsPath, "utf8")).toContain("replacement-secret");
    expect(existsSync(f.pendingPath)).toBe(true);
    expect(startRuntime).toHaveBeenCalledTimes(1);
    // 切换标记只覆盖 stop→start 窗口：失败后必须清掉，否则 supervisor 的
    // reconcile 会永远拒绝拉起子服务（实例被卡死，只能手工删文件）。
    expect(switchMarker).toBe(false);

    const recovered = await rotateMerchantCredential({
      ...base,
      runningServices: () => [],
      fetchImpl: async (input) => String(input).endsWith("/private-config")
        ? response({ merchant_id: "seller-a" })
        : response({ status: "confirmed" }),
    });
    expect(recovered).toMatchObject({ recovered: true, restarted: ["a2a"] });
    expect(startRuntime).toHaveBeenCalledTimes(2);
    expect(startRuntime).toHaveBeenLastCalledWith(["a2a"]);
    expect(switchMarker).toBe(false);
    expect(existsSync(f.pendingPath)).toBe(false);
  });

  it("reuses the exact id and secret after prepare response loss", async () => {
    const f = fixture();
    const requests: string[] = [];
    const options = {
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN", credentialsPath: f.credentialsPath, pendingPath: f.pendingPath,
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      runningServices: () => [],
    };
    const firstFetch = async (input: URL | string | Request, init?: FetchInit) => {
      if (String(input).endsWith("/prepare")) {
        requests.push(String(init?.body));
        throw new Error("lost prepare response");
      }
      return response({});
    };
    await expect(rotateMerchantCredential({ ...options, fetchImpl: firstFetch })).rejects.toThrow("lost prepare");
    const secondFetch = async (input: URL | string | Request, init?: FetchInit) => {
      if (String(input).endsWith("/prepare")) {
        requests.push(String(init?.body));
        return response({ status: "pending" });
      }
      if (String(input).endsWith("/private-config")) return response({ merchant_id: "seller-a" });
      return response({ status: "confirmed" });
    };
    await rotateMerchantCredential({ ...options, fetchImpl: secondFetch });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
  });

  it("serializes manual and scheduled rotation attempts with an exclusive local lock", async () => {
    const f = fixture();
    let releasePrepare!: () => void;
    let reachedPrepare!: () => void;
    const waiting = new Promise<void>((resolve) => { reachedPrepare = resolve; });
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const options = {
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, operationLockPath: path.join(f.dir, "operation.lock"),
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      runningServices: () => [],
      fetchImpl: async (input: URL | string | Request) => {
        if (String(input).endsWith("/prepare")) {
          reachedPrepare();
          await gate;
          return response({ status: "pending" });
        }
        if (String(input).endsWith("/private-config")) return response({ merchant_id: "seller-a" });
        return response({ status: "confirmed" });
      },
    };
    const first = rotateMerchantCredential(options);
    await waiting;
    await expect(rotateMerchantCredential(options)).rejects.toThrow("already running");
    releasePrepare();
    await first;
    expect(existsSync(options.operationLockPath)).toBe(false);
  });

  it("does not assume the previous token works when recovery rejects the staged token", async () => {
    const f = fixture();
    const base = {
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath,
      randomToken: () => "shopping_merchant_replacement-secret-012345678901",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      runningServices: () => ["a2a"],
      beginRuntimeSwitch: () => { switchMarker = true; },
      endRuntimeSwitch: () => { switchMarker = false; },
      startRuntime: async () => undefined,
      waitForRuntimeCredential: async () => undefined,
    };
    let switchMarker = false;
    await expect(rotateMerchantCredential({
      ...base,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/prepare")) return response({ status: "pending" });
        if (String(input).endsWith("/private-config")) return response({ merchant_id: "seller-a" });
        return response({}, 403);
      },
    })).rejects.toThrow("HTTP 403");
    const before = readFileSync(f.credentialsPath, "utf8");
    expect(before).toContain("SHOPPING_MERCHANT_TOKEN=shopping_merchant_replacement-secret-012345678901");

    await expect(rotateMerchantCredential({
      ...base,
      fetchImpl: async () => response({}, 403),
    })).rejects.toThrow("neither pending nor previous credential is accepted");
    expect(readFileSync(f.credentialsPath, "utf8")).toBe(before);
    expect(existsSync(f.pendingPath)).toBe(true);
    // sidecar 保留用于恢复，但切换标记必须释放（同上）。
    expect(switchMarker).toBe(false);
  });
});
