import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEnrollmentChallengeResponder, enrollmentStorePath } from "../src/cloud/binding/enrollment-challenge.js";
import { writeFileAtomic } from "../src/fs/atomic-write.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import { verifyCompactJws } from "../src/trust/identity/jws.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function fixture(dataDir: string, now: Date) {
  const pair = generateKeyPairSync("ed25519");
  const identity = { keyid: "runtime:test", algorithm: "ed25519" as const, privateKey: pair.privateKey };
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const thumbprint = publicKeyThumbprint(pem);
  writeFileAtomic(enrollmentStorePath(dataDir), JSON.stringify({
    version: 1,
    sessions: [{ enrollment_id: "enroll_test_123", runtime_origin: "https://shop.example", key_thumbprint: thumbprint, expires_at: new Date(now.getTime() + 600_000).toISOString(), status: "authorized" }],
    consumed: [],
  }), { mode: 0o600 });
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return { handler: createEnrollmentChallengeResponder({ dataDir, signingIdentity: identity, now: () => now }), publicKey: pair.publicKey, thumbprint };
}

async function invoke(handler: ReturnType<typeof createEnrollmentChallengeResponder>, body: unknown) {
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  let status = 0;
  let text = "";
  const req = {
    method: "POST",
    url: "/.well-known/kiwi-binding-challenge",
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; },
    end(value: string) { text = value; finish(); },
  } as unknown as ServerResponse;
  handler(req, res);
  await ended;
  return { status, json: JSON.parse(text) as Record<string, unknown> };
}

describe("independent enrollment challenge responder", () => {
  it("signs an authorized one-time challenge with the persistent Runtime key", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-enrollment-"));
    const now = new Date("2026-09-27T00:00:00.000Z");
    const server = await fixture(dataDir, now);
    const request = {
      enrollment_id: "enroll_test_123",
      challenge: randomBytes(32).toString("base64url"),
      origin: "https://shop.example",
      key_thumbprint: server.thumbprint,
      audience: "kiwi-catalog",
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    };
    expect(request.challenge).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
    expect(Date.parse(request.expires_at) - Date.parse(request.issued_at)).toBe(60_000);
    const response = await invoke(server.handler, request);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const claims = JSON.parse(verifyCompactJws(String(response.json.signature), server.publicKey).payload.toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({
      ...request,
      key_id: "runtime:test",
      purpose: "kiwi-binding-challenge",
    });
    expect(typeof claims.nonce).toBe("string");
    const replay = await invoke(server.handler, request);
    expect(replay.status).toBe(409);
  });

  it("rejects malformed timestamps, unapproved enrollments, and unexpected challenge fields", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-enrollment-"));
    const now = new Date("2026-09-27T00:00:00.000Z");
    const server = await fixture(dataDir, now);
    const base = {
      enrollment_id: "enroll_test_123",
      challenge: randomBytes(32).toString("base64url"),
      origin: "https://shop.example",
      key_thumbprint: server.thumbprint,
      audience: "kiwi-catalog",
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    };
    expect((await invoke(server.handler, { ...base, issued_at: "not-a-date" })).status).toBe(400);
    expect((await invoke(server.handler, { ...base, extra: "must-not-be-signed" })).status).toBe(400);
    const unrelated = await invoke(server.handler, { ...base, enrollment_id: "enroll_other_123" });
    expect(unrelated.status, JSON.stringify(unrelated.json)).toBe(403);
  });
});
