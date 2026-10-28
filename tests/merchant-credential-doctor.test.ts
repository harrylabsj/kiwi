import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMerchantCredentialDoctor } from "../src/merchant-runtime/credential-doctor.js";
import type { AgentProfile } from "../src/config/profile.js";
import { loadOrCreateA2aSigningIdentity } from "../src/a2a/signing-key.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";

const dirs: string[] = [];
const previousToken = process.env.SHOPPING_MERCHANT_TOKEN;
const previousCommerceUrl = process.env.KIWI_COMMERCE_URL;
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-credential-doctor-"));
  dirs.push(dir);
  const kiwiDir = path.join(dir, ".kiwi");
  const dataDir = path.join(dir, "merchant-data");
  mkdirSync(kiwiDir, { mode: 0o700 });
  mkdirSync(path.join(dataDir, "runtime"), { recursive: true, mode: 0o700 });
  const credentialsPath = path.join(kiwiDir, "credentials.env");
  writeFileSync(credentialsPath, "KIWI_MERCHANT_TOKEN=catalog-secret\nSHOPPING_MERCHANT_TOKEN=shopping_merchant_doctor-secret\n", { mode: 0o600 });
  return { dir, dataDir, credentialsPath };
}
const profile = {
  agent_id: "seller-a", owner_id: "seller-a", role: "merchant",
  commerce: { base_url: "https://shopping.example", token_env: "SHOPPING_MERCHANT_TOKEN", backend: "local_marketplace", credentials: { catalog: { token_env: "KIWI_MERCHANT_TOKEN" } } },
} as unknown as AgentProfile;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

afterEach(() => {
  if (previousToken === undefined) delete process.env.SHOPPING_MERCHANT_TOKEN;
  else process.env.SHOPPING_MERCHANT_TOKEN = previousToken;
  if (previousCommerceUrl === undefined) delete process.env.KIWI_COMMERCE_URL;
  else process.env.KIWI_COMMERCE_URL = previousCommerceUrl;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("merchant credential doctor", () => {
  it("reports protected token expiry and live scheduler without exposing credentials or writing files", async () => {
    const f = fixture();
    delete process.env.KIWI_COMMERCE_URL;
    const schedulePath = path.join(f.dataDir, "runtime", "credential-rotation-schedule.json");
    const schedule = { version: 1, merchant_id: "seller-a", enabled: true, poll_interval_seconds: 300, rotate_before_seconds: 604800, supervisor_pid: process.pid, started_at: new Date().toISOString(), last_check_at: new Date().toISOString(), last_result: "not_due" };
    writeFileSync(schedulePath, `${JSON.stringify(schedule)}\n`, { mode: 0o600 });
    const identity = loadOrCreateA2aSigningIdentity(f.dataDir, "merchant:seller-a");
    writeFileSync(path.join(f.dataDir, "merchant-enrollments.json"), `${JSON.stringify({ version: 1, sessions: [{ enrollment_id: "enrollment-a", runtime_origin: "https://seller.example", key_thumbprint: publicKeyThumbprint(identity.publicKeyPem), expires_at: "2030-01-01T00:00:00.000Z", status: "published" }], consumed: [] })}\n`, { mode: 0o600 });
    writeFileSync(path.join(f.dataDir, "merchant-enrollment-heartbeat.json"), `${JSON.stringify({ version: 1, outcome: "success", last_attempt_at: new Date().toISOString(), last_success_at: new Date().toISOString(), accepted_sessions: 1 })}\n`, { mode: 0o600 });
    const before = readFileSync(schedulePath, "utf8");
    const report = await runMerchantCredentialDoctor({
      profile, dataDir: f.dataDir, credentialsPath: f.credentialsPath,
      services: [{ name: "a2a", running: true, pid: process.pid, restarts: 0, stopped: false }],
      processCheck: () => true,
      now: () => new Date("2026-10-28T00:00:00.000Z"),
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://shopping.example/merchants/seller-a/token/status");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer shopping_merchant_doctor-secret");
        return response({ merchant_id: "seller-a", active: true, token_prefix: "shopping_merchant_abc", created_at: "2026-10-01T00:00:00.000Z", expires_at: "2026-11-01T00:00:00.000Z" });
      },
    });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.status).toBe("unknown");
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "protected_token_status")?.detail).toContain("2026-11-01");
    expect(report.checks.find((check) => check.name === "automatic_rotation")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "catalog_binding_online")?.state).toBe("unknown");
    expect(report.checks.find((check) => check.name === "enrollment_heartbeat")?.state).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain("doctor-secret");
    expect(readFileSync(schedulePath, "utf8")).toBe(before);
    expect(readFileSync(f.credentialsPath, "utf8")).toContain("SHOPPING_MERCHANT_TOKEN=shopping_merchant_doctor-secret");
  });

  it("flags shared Catalog refs, unsafe storage, and incomplete recovery state", async () => {
    const f = fixture();
    writeFileSync(f.credentialsPath, "KIWI_MERCHANT_TOKEN=shopping_merchant_doctor-secret\n", { mode: 0o644 });
    chmodSync(f.credentialsPath, 0o644);
    writeFileSync(path.join(path.dirname(f.credentialsPath), "credential-rotation.json"), "not json\n", { mode: 0o600 });
    const report = await runMerchantCredentialDoctor({
      profile: { ...profile, commerce: { ...profile.commerce, token_env: "KIWI_MERCHANT_TOKEN" } },
      dataDir: f.dataDir, credentialsPath: f.credentialsPath, services: [], fetchImpl: async () => response({}), processCheck: () => false,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "credential_scope")?.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "credential_storage")?.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "rotation_recovery")?.detail).toContain("malformed");
    expect(JSON.stringify(report)).not.toContain("doctor-secret");
  });
});
