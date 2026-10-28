import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rotateMerchantCredentialIfDue } from "../src/merchant-credential-rotation.js";
import { runCredentialRotationSchedule, type CredentialRotationScheduleStatus } from "../src/merchant-runtime/credential-rotation-scheduler.js";

const dirs: string[] = [];
const previousToken = process.env.SHOPPING_MERCHANT_TOKEN;
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-rotation-schedule-"));
  dirs.push(dir);
  const credentialsPath = path.join(dir, "credentials.env");
  const pendingPath = path.join(dir, "credential-rotation.json");
  const statusPath = path.join(dir, "credential-rotation-schedule.json");
  const old = "shopping_merchant_old-secret-0123456789";
  writeFileSync(credentialsPath, `SHOPPING_MERCHANT_TOKEN=${old}\n`, { mode: 0o600 });
  return { dir, credentialsPath, pendingPath, statusPath, old };
}
const statusRecord = (): CredentialRotationScheduleStatus => ({
  version: 1, merchant_id: "seller-a", enabled: true, poll_interval_seconds: 300,
  rotate_before_seconds: 7 * 86400, supervisor_pid: process.pid, started_at: "2026-10-28T00:00:00.000Z",
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  if (previousToken === undefined) delete process.env.SHOPPING_MERCHANT_TOKEN;
  else process.env.SHOPPING_MERCHANT_TOKEN = previousToken;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("automatic merchant token rotation", () => {
  it("rotates only when the protected expiry endpoint reports the configured lead window", async () => {
    const f = fixture();
    const calls: string[] = [];
    const rotation = {
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, operationLockPath: path.join(f.dir, "operation.lock"),
      rotateBeforeSeconds: 7 * 86400,
      now: () => new Date("2026-10-28T00:00:00.000Z"),
      randomToken: () => "shopping_merchant_new-secret-01234567890123456789",
      randomRotationId: () => "rotation-id-1234567890-abcdefgh",
      fetchImpl: async (input: URL | string | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/token/status")) return response({ merchant_id: "seller-a", active: true, token_prefix: "shopping_merchant_old", created_at: "2026-09-28T00:00:00.000Z", expires_at: "2026-10-29T00:00:00.000Z" });
        if (url.endsWith("/prepare")) return response({ status: "pending" });
        if (url.endsWith("/private-config")) return response({ merchant_id: "seller-a" });
        return response({ status: "confirmed" });
      },
    };
    const result = await runCredentialRotationSchedule({ statusPath: f.statusPath, status: statusRecord(), rotation });
    expect(result.last_result).toBe("rotated");
    expect(result.seconds_remaining).toBeNull();
    expect(calls.map((url) => url.split("/").at(-1))).toEqual(["status", "prepare", "private-config", "confirm"]);
    expect(readFileSync(f.credentialsPath, "utf8")).toContain("shopping_merchant_new-secret");
    expect(existsSync(path.join(f.dir, "operation.lock"))).toBe(false);
    expect(statSync(f.statusPath).mode & 0o777).toBe(0o600);
  });

  it("does not rotate outside the lead window or when there is no server expiry", async () => {
    const f = fixture();
    let calls = 0;
    const base = {
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, rotateBeforeSeconds: 7 * 86400,
      now: () => new Date("2026-10-28T00:00:00.000Z"),
      fetchImpl: async () => { calls += 1; return response({ merchant_id: "seller-a", active: true, token_prefix: "p", created_at: "2026-10-27T23:00:00.000Z", expires_at: "2026-10-28T00:30:00.000Z" }); },
    };
    const notDue = await rotateMerchantCredentialIfDue(base);
    expect(notDue.status).toBe("not_due");
    const noExpiry = await rotateMerchantCredentialIfDue({ ...base, fetchImpl: async () => response({ merchant_id: "seller-a", active: true, token_prefix: "p", created_at: "2026-10-01T00:00:00.000Z", expires_at: "" }) });
    expect(noExpiry.status).toBe("no_expiry");
    expect(calls).toBe(1);
    expect(existsSync(f.pendingPath)).toBe(false);
  });

  it("fails closed when A2A is down and persists only a stable error code on network failure", async () => {
    const f = fixture();
    let prepares = 0;
    const base = {
      baseUrl: "https://shopping.example", merchantId: "seller-a", tokenEnv: "SHOPPING_MERCHANT_TOKEN",
      credentialsPath: f.credentialsPath, pendingPath: f.pendingPath, rotateBeforeSeconds: 7 * 86400,
      now: () => new Date("2026-10-28T00:00:00.000Z"),
      fetchImpl: async (input: URL | string | Request) => {
        if (String(input).endsWith("/token/status")) return response({ merchant_id: "seller-a", active: true, token_prefix: "p", created_at: "2026-10-01T00:00:00.000Z", expires_at: "2026-10-29T00:00:00.000Z" });
        prepares += 1;
        return response({ status: "pending" });
      },
    };
    const offline = { ...base, fetchImpl: async () => { throw new Error("network failed for shopping_merchant_secret"); } };
    await expect(runCredentialRotationSchedule({ statusPath: f.statusPath, status: statusRecord(), rotation: offline })).rejects.toThrow("automatic merchant token rotation failed");
    expect(readFileSync(f.statusPath, "utf8")).not.toContain("shopping_merchant_secret");
    expect(JSON.parse(readFileSync(f.statusPath, "utf8")).last_error).toBe("merchant_token_status_unavailable");

    await expect(rotateMerchantCredentialIfDue({ ...base, beforeRotation: () => { throw new Error("A2A down"); } })).rejects.toThrow("A2A down");
    expect(prepares).toBe(0);
    expect(readFileSync(f.credentialsPath, "utf8")).toContain(f.old);
    expect(existsSync(f.pendingPath)).toBe(false);
  });
});
