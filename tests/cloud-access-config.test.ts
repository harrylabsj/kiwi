/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 商家侧 WorkBuddy 访问配置（M-02/M-03/M-04）：提交、更新、撤销、权威读。
 *
 * 全部离线：Catalog 由一个记录请求的 fetch 桩代替，断言落在
 *   - 请求形状（method/path/body，分享码只在 body 里，由 body_digest 覆盖）；
 *   - 失败语义（origin 不符不发请求；409 先权威读再只重试一次）；
 *   - 持久化只存脱敏投影，文件里不出现分享码。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import { enrollmentStorePath } from "../src/cloud/binding/enrollment-challenge.js";
import { runtimePublicKey } from "../src/cloud/catalog-client.js";
import {
  createMerchantConnectionService,
  MerchantConnectError,
  type ConnectionSession,
} from "../src/cloud/connect-service.js";
import { canonicalize } from "../src/negotiation/jcs.js";

const RUNTIME_ORIGIN = "https://runtime.test";
const CATALOG_ORIGIN = "https://catalog.test";
const AGENT_ID = "cagt_access_test";
const BINDING_ID = "bnd_access_test";
const SHARE_SECRET = "share-code-alpha";

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  jws: string;
}

function projection(version: number, status = "active"): Record<string, unknown> {
  return {
    provider: "workbuddy",
    access_mode: "share_parameter",
    parameter_name: "sharecode",
    config_version: version,
    adapter_version: "workbuddy-share-v1",
    auth_mode: "signature",
    status,
    validated_at: "2026-10-27T00:00:00+00:00",
    updated_at: "2026-10-27T00:00:00+00:00",
  };
}

function jwsPayload(jws: string): Record<string, unknown> {
  const segment = jws.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

interface Harness {
  service: ReturnType<typeof createMerchantConnectionService>;
  dataDir: string;
  calls: RecordedCall[];
  storeFile: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(
  responses: Array<{ status: number; body?: unknown }>,
  options: { status?: ConnectionSession["status"]; accessShareLink?: string } = {},
): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-access-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

  // 先让服务创建（或读取）签名身份，再用它的指纹播种会话。
  const service = createMerchantConnectionService({
    dataDir,
    catalogUrl: CATALOG_ORIGIN,
    publicOrigin: RUNTIME_ORIGIN,
    allowPrivateOrigin: true,
    ...(options.accessShareLink !== undefined
      ? { accessShareLink: options.accessShareLink }
      : {}),
    fetchImpl: ((input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? {});
      calls.push({
        method: String(init?.method ?? "GET"),
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        jws: headers.get("x-kiwi-binding-jws") ?? "",
      });
      const next = responses.shift();
      if (next === undefined) throw new Error(`unexpected catalog request: ${String(init?.method)} ${url}`);
      return Promise.resolve(
        new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
          status: next.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch,
  });

  const identity = loadOrCreateA2aSigningIdentity(dataDir, RUNTIME_ORIGIN);
  const thumbprint = runtimePublicKey({
    signingIdentity: toJwsSigningIdentity(identity),
    keyId: identity.keyid,
  }).keyThumbprint;
  const storeFile = enrollmentStorePath(dataDir);
  const session: Partial<ConnectionSession> = {
    enrollment_id: "enr_access_test",
    status: options.status ?? "published",
    runtime_origin: RUNTIME_ORIGIN,
    key_thumbprint: thumbprint,
    catalog_origin: CATALOG_ORIGIN,
    generation: 1,
    catalog_agent_id: AGENT_ID,
    ...(options.status === undefined || ["bound", "published"].includes(options.status)
      ? { binding_id: BINDING_ID }
      : {}),
    expires_at: "2099-01-01T00:00:00+00:00",
    binding_expires_at: "2099-01-01T00:00:00+00:00",
    store_revision: 0,
  };
  writeFileSync(storeFile, JSON.stringify({ version: 1, sessions: [session], consumed: [] }));
  return { service, dataDir, calls, storeFile };
}

// `calls` 是模块级变量（fetch 桩在 harness 内被闭包捕获）。
let calls: RecordedCall[] = [];
function harnessWithResponses(
  responses: Array<{ status: number; body?: unknown }>,
  options: { status?: ConnectionSession["status"]; accessShareLink?: string } = {},
): Harness {
  calls = [];
  return harness(responses, options);
}

describe("submitAccessShareLink", () => {
  it("submits the parsed code as an access_config covered by the request signature", async () => {
    const h = harnessWithResponses([
      { status: 200, body: { ok: true, runtime_access: projection(1) } },
    ]);
    const summary = await h.service.submitAccessShareLink(`${RUNTIME_ORIGIN}/a2a?sharecode=${SHARE_SECRET}`);

    expect(summary).toMatchObject({
      configured: true,
      status: "active",
      configVersion: 1,
      adapterVersion: "workbuddy-share-v1",
      authMode: "signature",
    });
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(`${CATALOG_ORIGIN}/v1/agents/${AGENT_ID}/runtime-access`);
    expect(call.body).toEqual({
      binding: { binding_id: BINDING_ID },
      access_config: {
        provider: "workbuddy",
        access_mode: "share_parameter",
        parameter_name: "sharecode",
        secret_value: SHARE_SECRET,
        adapter_version: "workbuddy-share-v1",
        auth_mode: "signature",
        expected_version: 0,
      },
    });
    // 分享码不出现在 URL 里；签名覆盖 body 摘要。
    expect(call.url).not.toContain(SHARE_SECRET);
    const payload = jwsPayload(call.jws);
    expect(payload["method"]).toBe("PUT");
    expect(payload["path"]).toBe(`/v1/agents/${AGENT_ID}/runtime-access`);
    expect(payload["catalog_agent_id"]).toBe(AGENT_ID);
    expect(payload["binding_id"]).toBe(BINDING_ID);
    expect(payload["runtime_origin"]).toBe(RUNTIME_ORIGIN);
    expect(payload["body_digest"]).toBe(
      `sha256:${createHash("sha256").update(canonicalize(call.body as Record<string, unknown>)).digest("hex")}`,
    );
    expect(typeof payload["exp"]).toBe("string");
    expect(typeof payload["nonce"]).toBe("string");
  });

  it("never persists or returns the share code", async () => {
    const h = harnessWithResponses([
      { status: 200, body: { ok: true, runtime_access: projection(1) } },
    ]);
    const summary = await h.service.submitAccessShareLink(
      `${RUNTIME_ORIGIN}/a2a?sharecode=${SHARE_SECRET}`,
    );
    expect(JSON.stringify(summary)).not.toContain(SHARE_SECRET);
    const persisted = readFileSync(h.storeFile, "utf8");
    expect(persisted).not.toContain(SHARE_SECRET);
    expect(JSON.parse(persisted).sessions[0].runtime_access).toMatchObject({
      config_version: 1,
      status: "active",
      provider: "workbuddy",
    });
  });

  it("refuses a link for another deployment without any network call", async () => {
    const h = harnessWithResponses([]);
    await expect(
      h.service.submitAccessShareLink("https://evil.example/a2a?sharecode=abc"),
    ).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a malformed link without any network call", async () => {
    const h = harnessWithResponses([]);
    await expect(h.service.submitAccessShareLink(`${RUNTIME_ORIGIN}/a2a`)).rejects.toMatchObject({
      code: "MISSING_SHARECODE",
    });
    expect(h.calls).toHaveLength(0);
  });

  it("on a stale local version, reads the authoritative version and retries exactly once", async () => {
    const h = harnessWithResponses([
      { status: 409, body: { ok: false, error: "runtime access version conflict" } },
      { status: 200, body: { ok: true, config_version: 5, runtime_access: projection(5) } },
      { status: 200, body: { ok: true, runtime_access: projection(6) } },
    ]);
    const summary = await h.service.submitAccessShareLink(
      `${RUNTIME_ORIGIN}/a2a?sharecode=${SHARE_SECRET}`,
    );
    expect(summary.configVersion).toBe(6);
    expect(h.calls.map((call) => call.method)).toEqual(["PUT", "GET", "PUT"]);
    const retryBody = h.calls[2]!.body as { access_config: { expected_version: number } };
    expect(retryBody.access_config.expected_version).toBe(5);
  });

  it("requires a bound session", async () => {
    const h = harnessWithResponses([], { status: "preparing" });
    await expect(
      h.service.submitAccessShareLink(`${RUNTIME_ORIGIN}/a2a?sharecode=${SHARE_SECRET}`),
    ).rejects.toMatchObject({ code: "STATE_INVALID" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("refreshAccess / revokeAccess", () => {
  it("persists the authoritative projection without the secret", async () => {
    const h = harnessWithResponses([
      { status: 200, body: { ok: true, config_version: 3, runtime_access: projection(3, "pending") } },
    ]);
    const summary = await h.service.refreshAccess();
    expect(summary).toMatchObject({ configured: false, status: "pending", configVersion: 3 });
    expect(h.calls[0]!.method).toBe("GET");
    expect(jwsPayload(h.calls[0]!.jws)["body_digest"]).toBe(
      `sha256:${createHash("sha256").update("{}").digest("hex")}`,
    );
  });

  it("reports no configuration when the catalog has none", async () => {
    const h = harnessWithResponses([
      { status: 200, body: { ok: true, config_version: 0, runtime_access: null } },
    ]);
    const summary = await h.service.refreshAccess();
    expect(summary).toMatchObject({ configured: false, status: "none", configVersion: 0 });
  });

  it("revokes with the locally known version and stops reporting configured", async () => {
    const h = harnessWithResponses([
      { status: 200, body: { ok: true, runtime_access: projection(1) } },
      { status: 200, body: { ok: true, runtime_access: projection(1, "revoked") } },
    ]);
    await h.service.submitAccessShareLink(`${RUNTIME_ORIGIN}/a2a?sharecode=${SHARE_SECRET}`);
    const summary = await h.service.revokeAccess();
    expect(summary).toMatchObject({ configured: false, status: "revoked", configVersion: 1 });
    expect(h.calls[1]!.body).toEqual({
      binding: { binding_id: BINDING_ID },
      access_config: { access_mode: "none", expected_version: 1 },
    });
  });

  it("refuses to revoke when nothing is configured", async () => {
    const h = harnessWithResponses([
      { status: 200, body: { ok: true, config_version: 0, runtime_access: null } },
    ]);
    await expect(h.service.revokeAccess()).rejects.toMatchObject({
      code: "ACCESS_NOT_CONFIGURED",
    });
  });

  it("maps catalog failures to safe codes without leaking the request", async () => {
    const h = harnessWithResponses([{ status: 403, body: { ok: false, error: "denied" } }]);
    const error = await h.service
      .submitAccessShareLink(`${RUNTIME_ORIGIN}/a2a?sharecode=${SHARE_SECRET}`)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MerchantConnectError);
    expect((error as MerchantConnectError).code).toBe("ACCESS_REJECTED");
    expect((error as MerchantConnectError).message).not.toContain(SHARE_SECRET);
  });
});

describe("first-bind access config option", () => {
  it("rejects a configured share link that points at another deployment", () => {
    expect(() =>
      createMerchantConnectionService({
        dataDir: mkdtempSync(path.join(tmpdir(), "kiwi-access-opt-")),
        catalogUrl: CATALOG_ORIGIN,
        publicOrigin: RUNTIME_ORIGIN,
        allowPrivateOrigin: true,
        accessShareLink: "https://other.example/a2a?sharecode=abc",
        fetchImpl: (async () => new Response("{}")) as typeof fetch,
      }),
    ).toThrow(/不是本实例的公网入口/);
  });
});
