/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import {
  startEnrollmentHeartbeat,
  type EnrollmentHeartbeat,
} from "../src/cloud/binding/enrollment-heartbeat.js";

const paths: string[] = [];
const handles: EnrollmentHeartbeat[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  for (const dir of paths.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-heartbeat-"));
  paths.push(dir);
  const raw = generateA2aSigningIdentity("runtime-key");
  const session = {
    enrollment_id: "enr_test",
    runtime_origin: "https://runtime.example",
    key_thumbprint: publicKeyThumbprint(raw.publicKeyPem),
    expires_at: "2020-01-01T00:00:00Z",
    status: "published",
    catalog_origin: "https://catalog.example",
    catalog_agent_id: "cagt_test",
    binding_id: "binding_test",
    grant: "MUST-NOT-LEAVE-STATE",
    device_code: "PRIVATE-DEVICE-CODE",
  };
  const save = (value = session) =>
    writeFileSync(
      path.join(dir, "merchant-enrollments.json"),
      JSON.stringify({ version: 1, sessions: [value], consumed: [] }),
      { mode: 0o600 },
    );
  return { dir, identity: toJwsSigningIdentity(raw), save, session, raw };
}
describe("enrollment signed heartbeat", () => {
  it("reads newly published state without restart and uses unique signatures without enrollment secrets", async () => {
    const f = fixture();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, catalog_agent_id: "cagt_test" })),
    );
    const heartbeat = startEnrollmentHeartbeat({
      dataDir: f.dir,
      signingIdentity: f.identity,
      fetchImpl,
      onError: () => {},
    });
    handles.push(heartbeat);
    await heartbeat.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    f.save();
    await heartbeat.tick();
    await heartbeat.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = fetchImpl.mock.calls as unknown as [
      string,
      NonNullable<Parameters<typeof fetch>[1]>,
    ][];
    expect(calls[0]?.[0]).toBe(
      "https://catalog.example/v1/agent-catalog/agents/cagt_test/heartbeat",
    );
    const payloads = calls.map(([, init]) => {
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(init.body).toBe("{}");
      const payload = JSON.parse(
        Buffer.from(
          (headers.get("x-kiwi-binding-jws") ?? "").split(".")[1] ?? "",
          "base64url",
        ).toString(),
      ) as Record<string, unknown>;
      expect(payload["agent_id"]).toBe("cagt_test");
      expect(payload["binding_id"]).toBe("binding_test");
      expect(JSON.stringify(init)).not.toContain("MUST-NOT-LEAVE-STATE");
      expect(JSON.stringify(init)).not.toContain("PRIVATE-DEVICE-CODE");
      return payload;
    });
    expect(payloads[0]?.["nonce"]).not.toBe(payloads[1]?.["nonce"]);
  });
  it("does not heartbeat an unready runtime or another key and stops with the server", async () => {
    const f = fixture();
    f.save();
    let ready = false;
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, catalog_agent_id: "cagt_test" })),
    );
    const heartbeat = startEnrollmentHeartbeat({
      dataDir: f.dir,
      signingIdentity: f.identity,
      fetchImpl,
      isReady: () => ready,
    });
    handles.push(heartbeat);
    await heartbeat.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    ready = true;
    f.save({ ...f.session, key_thumbprint: "sha256:other" });
    await heartbeat.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    f.save();
    heartbeat.stop();
    await heartbeat.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("suppresses the previous binding while a rotated-key enrollment for the same Catalog agent awaits consent", async () => {
    const f = fixture();
    const pending = {
      ...f.session,
      enrollment_id: "enr_rotation",
      status: "preparing",
      key_thumbprint: "sha256:new-key-thumbprint",
      expected_catalog_agent_id: f.session.catalog_agent_id,
    };
    writeFileSync(
      path.join(f.dir, "merchant-enrollments.json"),
      JSON.stringify({ version: 1, sessions: [f.session, pending], consumed: [] }),
      { mode: 0o600 },
    );
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, catalog_agent_id: "cagt_test" })));
    const heartbeat = startEnrollmentHeartbeat({ dataDir: f.dir, signingIdentity: f.identity, fetchImpl, onError: () => {} });
    handles.push(heartbeat);
    await heartbeat.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects redirected heartbeats and does not mark local publication as successful", async () => {
    const f = fixture();
    f.save();
    const heartbeat = startEnrollmentHeartbeat({
      dataDir: f.dir,
      signingIdentity: f.identity,
      fetchImpl: vi.fn(async () => new Response(null, { status: 302 })),
      onError: () => {},
    });
    handles.push(heartbeat);
    await expect(heartbeat.tick()).rejects.toThrow("HTTP 302");
  });
});
