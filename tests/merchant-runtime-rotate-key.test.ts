import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { loadA2aSigningIdentityFromFile } from "../src/a2a/signing-key.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import { testProfile } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-runtime-rotate-key-"));
  dirs.push(dir);
  const profile = testProfile({
    agent_id: "merchant-agent-rotate-test",
    owner_id: "merchant-rotate-test",
    merchant_public: { public_url: "https://rotate.example" },
  });
  const profilePath = path.join(dir, "merchant.yaml");
  writeFileSync(profilePath, stringify(profile), { mode: 0o600 });
  const dataDir = path.join(dir, "runtime");
  const keyPath = path.join(dataDir, "a2a-signing-key.json");
  const keyDir = path.dirname(keyPath);
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const oldThumbprint = publicKeyThumbprint(publicKeyPem);
  writeFileSync(keyPath, JSON.stringify({ keyid: "https://rotate.example", algorithm: "ed25519", privateKeyPem, publicKeyPem }), { mode: 0o600 });
  const storePath = path.join(dataDir, "merchant-enrollments.json");
  writeFileSync(storePath, JSON.stringify({
    version: 1,
    sessions: [{ enrollment_id: "old-enrollment", runtime_origin: "https://rotate.example", key_thumbprint: oldThumbprint, expires_at: "2026-10-01T00:00:00Z", status: "published", catalog_origin: "https://catalog.example", catalog_agent_id: "cagt_old", merchant_id: "mkt_rotate", binding_id: "binding_old" }],
    consumed: [],
  }), { mode: 0o600 });
  return { dir, dataDir, profilePath, keyPath, storePath, oldThumbprint };
}

describe("kiwi merchant runtime rotate-key", () => {
  it("rotates a stopped Runtime key atomically, preserves enrollment history, and prints reconnect steps", async () => {
    const f = workspace();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exit = await main(["merchant", "runtime", "rotate-key", "--profile", f.profilePath, "--data-dir", f.dataDir]);
      expect(exit).toBe(0);
      const newIdentity = loadA2aSigningIdentityFromFile(f.keyPath);
      expect(publicKeyThumbprint(newIdentity.publicKeyPem)).not.toBe(f.oldThumbprint);
      expect(statSync(f.keyPath).mode & 0o777).toBe(0o600);
      const state = JSON.parse(readFileSync(f.storePath, "utf8")) as { sessions: Array<{ status: string; key_thumbprint: string; catalog_agent_id: string }> };
      expect(state.sessions).toEqual([expect.objectContaining({ status: "published", key_thumbprint: f.oldThumbprint, catalog_agent_id: "cagt_old" })]);
      const message = out.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(message).toContain("connect");
      expect(message).toContain("批准新的公开预览");
      expect(message).not.toContain(newIdentity.privateKeyPem);
    } finally {
      out.mockRestore();
    }
  });

  it("refuses rotation while A2A holds owner.lock and preserves the current key", async () => {
    const f = workspace();
    const oldBytes = readFileSync(f.keyPath);
    const lockDir = path.join(f.dataDir, "a2a");
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(lockDir, "owner.lock");
    writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const exit = await main(["merchant", "runtime", "rotate-key", "--profile", f.profilePath, "--data-dir", f.dataDir]);
      expect(exit).not.toBe(0);
      expect(readFileSync(f.keyPath)).toEqual(oldBytes);
      expect(existsSync(lockPath)).toBe(true);
      expect(err.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("仍在运行");
    } finally {
      err.mockRestore();
    }
  });
});
