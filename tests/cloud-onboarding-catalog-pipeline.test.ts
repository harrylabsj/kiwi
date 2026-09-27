/**
 * P3 向导串联（catalog-pipeline.ts）：S3（绑定请求 + 等待门户确认）与
 * S4（签名发布 + CAS 激活）串进五步向导的「服务检查」→「确认公开信息」。
 *
 * 覆盖：
 *   - 状态机：DEPLOYED_UNBOUND → BOUND → VERIFYING → READY_TO_PUBLISH → PUBLISHED
 *     只经 OnboardingStore 推进，且 lastSuccessfulStep 正确（断点续办可读）；
 *   - 等待门户确认：超时不是失败——记录停在 DEPLOYED_UNBOUND，提示去门户
 *     「我的名片」页确认；确认后重跑即续办，且不重复发绑定请求；
 *   - 未确认不发布：公开读没有匹配绑定时 publishCardForRecord 拒绝，
 *     不发出任何发布请求；
 *   - 失败语义：目录不可达 → pending_publication 留痕、状态不谎报；
 *     CAS 冲突 → BLOCKED 报人工；服务检查不过 → BLOCKED；
 *   - advance 通道适配器：只为「服务检查」「确认公开信息」供权威证据，
 *     其余步骤返回 undefined（维持 503 不代答）。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { generateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import {
  CatalogClient,
  runtimePublicKey,
  type RuntimeSigningIdentity,
} from "../src/cloud/catalog-client.js";
import {
  CatalogPipelineError,
  PENDING_PUBLICATION_MARKER,
  catalogPlatformEvidenceAdapter,
  publishCardForRecord,
  reconcileBinding,
  type CatalogPipelineDeps,
} from "../src/cloud/onboarding/catalog-pipeline.js";
import { planWizard } from "../src/cloud/onboarding/steps.js";
import { OnboardingStore, digestOf, platformEvidence } from "../src/cloud/onboarding/store.js";
import { readEnrollmentStore } from "../src/cloud/binding/enrollment-challenge.js";
import { writeFileAtomic } from "../src/fs/atomic-write.js";
import type { OnboardingRecord } from "../src/cloud/onboarding/types.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { canonicalize } from "../src/negotiation/jcs.js";
import type { AgentCard } from "../src/discovery/agent-card/types.js";

const ORIGIN = "https://merchant-demo.example";
const CATALOG = "https://catalog.example";
const AGENT = "cagt_demo";
const dataDirs: string[] = [];
afterEach(() => dataDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-pipeline-enrollment-"));
  dataDirs.push(dir);
  return dir;
}

function identity(): RuntimeSigningIdentity {
  const a2a = generateA2aSigningIdentity(ORIGIN);
  return { signingIdentity: toJwsSigningIdentity(a2a), keyId: a2a.keyid };
}

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

function mockFetch(handler: (call: FetchCall) => { status: number; json?: unknown }) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: { method?: string; body?: string }) => {
    const call: FetchCall = {
      url: String(url),
      method: String(init?.method ?? "GET"),
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    };
    calls.push(call);
    const result = handler(call);
    return new Response(result.json === undefined ? "" : JSON.stringify(result.json), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function bindingDocument(id: RuntimeSigningIdentity, cardRevision: number | null = null) {
  const { keyThumbprint } = runtimePublicKey(id);
  return {
    claims: buildBindingClaims({
      bindingId: "binding_demo",
      bindingVersion: 1,
      merchantId: "merchant_demo",
      agentId: AGENT,
      workloadRef: "workload_demo",
      runtimeOrigin: ORIGIN,
      a2aEndpoint: `${ORIGIN}/a2a`,
      cardUrl: `${CATALOG}/v1/agents/${AGENT}/agent-card.json`,
      keyId: id.keyId,
      keyThumbprint,
      serviceEpoch: 1,
      issuedAt: "2026-09-26T07:00:00Z",
      ttlSeconds: 900,
      issuer: "catalog_demo",
    }),
    claims_jws: "header.payload.sig",
    issuer_kid: "catalog_demo",
    issuer_thumbprint: `sha256:${"a".repeat(64)}`,
    governance: { publication_state: "ACTIVE" },
    card_revision: cardRevision,
    card_etag: null,
  };
}

function evidence() {
  return platformEvidence({ applicationId: "wbapp_1", generation: 1, source: "inspectOwnedApplication" });
}

function storeWithRecord(status: "DEPLOYED_UNBOUND" | "READY_TO_PUBLISH"): {
  store: OnboardingStore;
  record: OnboardingRecord;
} {
  const store = new OnboardingStore(new DatabaseSync(":memory:"));
  let record = store.openIntent({
    merchantId: "merchant_demo",
    intentId: "intent-pipe",
    versionDigest: `sha256:${"a".repeat(64)}`,
    idempotencyKey: "key-pipe",
    requestDigest: digestOf({ intent: "intent-pipe" }),
    catalogAgentId: AGENT,
  });
  const advance = (nextStatus: Parameters<OnboardingStore["advance"]>[0]["nextStatus"], step?: string) => {
    record = store.advance({
      recordId: record.recordId,
      expectedRevision: record.revision,
      nextStatus,
      ...(step !== undefined ? { step } : {}),
      evidence: evidence(),
    });
  };
  advance("AWAITING_PLATFORM_CONSENT", "login-binding");
  advance("ACTIVATED", "platform-consent");
  advance("DEPLOYING", "catalog-confirm");
  advance("DEPLOYED_UNBOUND");
  if (status === "READY_TO_PUBLISH") {
    advance("BOUND");
    advance("VERIFYING");
    advance("READY_TO_PUBLISH", "service-check");
  }
  return { store, record };
}

function pipelineDeps(
  store: OnboardingStore,
  id: RuntimeSigningIdentity,
  fetchImpl: typeof fetch,
  overrides: Partial<CatalogPipelineDeps> = {},
): CatalogPipelineDeps {
  return {
    store,
    client: new CatalogClient({ baseUrl: CATALOG, fetchImpl }),
    dataDir: tempDataDir(),
    identity: id,
    runtimeOrigin: ORIGIN,
    generation: 1,
    serviceEpoch: 1,
    card: {
      name: "Demo Store",
      description: "Public RFQ capability",
      providerOrganization: "Demo Store",
      version: "1.0.0",
    },
    serviceCheck: async () => ({ ok: true }),
    awaitOptions: { timeoutMs: 50, pollIntervalMs: 1 },
    ...overrides,
  };
}

function fakeEnrollmentClient(id: RuntimeSigningIdentity, options: { authorized?: boolean; failPublish?: boolean; activeCardRevision?: number | null } = {}) {
  const thumbprint = runtimePublicKey(id).keyThumbprint;
  const counts = { create: 0, poll: 0, bind: 0, publish: 0, activate: 0 };
  let approvedDigest = "";
  let authorized = options.authorized ?? false;
  let failPublish = options.failPublish ?? false;
  let publishExpectedRevision: number | undefined;
  let activateExpectedRevision: number | undefined;
  const client = {
    catalogOrigin: CATALOG,
    async createDeviceEnrollment(input: { publicPreview: Record<string, unknown> }) {
      counts.create += 1;
      approvedDigest = `sha256:${createHash("sha256").update(canonicalize(input.publicPreview), "utf8").digest("hex")}`;
      return { enrollmentId: "enroll_demo_123", deviceCode: "D".repeat(48), userCode: "ABCD-EFGH", verificationUri: `${CATALOG}/portal/connect/enroll_demo_123`, expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 1, keyThumbprint: thumbprint };
    },
    async pollDeviceEnrollment() {
      counts.poll += 1;
      if (!authorized) return { status: "authorization_pending" as const, intervalSeconds: 1 };
      return { status: "authorized" as const, enrollmentId: "enroll_demo_123", grant: "G".repeat(48), catalogAgentId: AGENT, merchantId: "merchant_demo", runtimeOrigin: ORIGIN, a2aEndpoint: `${ORIGIN}/a2a`, expiresAt: new Date(Date.now() + 600_000).toISOString(), authorizationEpoch: 1, approvedCardDigest: approvedDigest, scopes: ["runtime:bind", "card:publish", "heartbeat"] };
    },
    async bindEnrollment() {
      counts.bind += 1;
      return { bindingId: "binding_demo", bindingVersion: 1, keyThumbprint: thumbprint, activeCardRevision: options.activeCardRevision ?? null,
        bindingClaim: { claims: { merchant_id: "merchant_demo", expires_at: new Date(Date.now() + 600_000).toISOString() }, card_revision: options.activeCardRevision ?? null } };
    },
    async publishCard(input: { expectedRevision: number }) {
      counts.publish += 1;
      publishExpectedRevision = input.expectedRevision;
      if (failPublish) { failPublish = false; throw new Error("simulated temporary catalog outage"); }
      return { revision: 1, cardDigest: approvedDigest, nonce: "newnonce" };
    },
    async activateCard(input: { expectedRevision: number }) {
      counts.activate += 1;
      activateExpectedRevision = input.expectedRevision;
      return { revision: 1, nonce: "newnonce" };
    },
    setAuthorized(value: boolean) { authorized = value; },
  };
  return { client: client as unknown as CatalogClient, counts, setAuthorized: client.setAuthorized,
    get publishExpectedRevision() { return publishExpectedRevision; },
    get activateExpectedRevision() { return activateExpectedRevision; } };
}

describe("device enrollment reconciliation", () => {
  it("waits at the secure Catalog page, then completes bind, readiness, and publication after one authorization", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("DEPLOYED_UNBOUND");
    const fake = fakeEnrollmentClient(id);
    const deps = pipelineDeps(store, id, (async () => new Response()) as typeof fetch, { client: fake.client });
    const waiting = await reconcileBinding(record, deps);
    expect(waiting.kind).toBe("awaiting_portal_confirmation");
    if (waiting.kind === "awaiting_portal_confirmation") {
      expect(waiting.hint).toContain("ABCD-EFGH");
      expect(waiting.hint).toContain("/portal/connect/enroll_demo_123");
      expect(waiting.hint).not.toContain("D".repeat(20));
    }
    expect(store.getRecord(record.recordId)!.status).toBe("DEPLOYED_UNBOUND");
    fake.setAuthorized(true);
    const completed = await reconcileBinding(store.getRecord(record.recordId)!, deps);
    expect(completed.kind).toBe("advanced");
    expect(completed.record.status).toBe("PUBLISHED");
    expect(completed.record.lastSuccessfulStep).toBe("public-profile");
    expect(fake.counts).toEqual({ create: 1, poll: 2, bind: 1, publish: 1, activate: 1 });
  });

  it("keeps readiness failures retryable with the existing binding and grant", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("DEPLOYED_UNBOUND");
    const fake = fakeEnrollmentClient(id);
    let ready = false;
    const deps = pipelineDeps(store, id, (async () => new Response()) as typeof fetch, {
      client: fake.client,
      serviceCheck: async () => ({ ok: ready, detail: "PRODUCTS_PROBE_SKU_UNSET" }),
    });
    await reconcileBinding(record, deps);
    fake.setAuthorized(true);
    await expect(reconcileBinding(store.getRecord(record.recordId)!, deps)).rejects.toMatchObject({ code: "SERVICE_CHECK_UNAVAILABLE" });
    expect(store.getRecord(record.recordId)!.status).toBe("VERIFYING");
    ready = true;
    const outcome = await reconcileBinding(store.getRecord(record.recordId)!, deps);
    expect(outcome.record.status).toBe("PUBLISHED");
    expect(fake.counts).toEqual({ create: 1, poll: 2, bind: 1, publish: 1, activate: 1 });
  });

  it("resumes a transient card-publication failure without reauthorization or rebinding", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("DEPLOYED_UNBOUND");
    const fake = fakeEnrollmentClient(id, { failPublish: true });
    const deps = pipelineDeps(store, id, (async () => new Response()) as typeof fetch, { client: fake.client });
    await reconcileBinding(record, deps);
    fake.setAuthorized(true);
    await expect(reconcileBinding(store.getRecord(record.recordId)!, deps)).rejects.toThrow("simulated temporary catalog outage");
    expect(store.getRecord(record.recordId)!.status).toBe("READY_TO_PUBLISH");
    const recovered = await reconcileBinding(store.getRecord(record.recordId)!, deps);
    expect(recovered.record.status).toBe("PUBLISHED");
    expect(fake.counts).toEqual({ create: 1, poll: 2, bind: 1, publish: 2, activate: 1 });
  });

  it("migrates a same-agent binding against the existing Catalog card revision and preserves the signed merchant identity", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("DEPLOYED_UNBOUND");
    const fake = fakeEnrollmentClient(id, { activeCardRevision: 3 });
    const deps = pipelineDeps(store, id, (async () => new Response()) as typeof fetch, { client: fake.client });
    const enrollmentFile = readEnrollmentStore(deps.dataDir!);
    enrollmentFile.sessions.push({
      enrollment_id: "old_enrollment",
      runtime_origin: ORIGIN,
      key_thumbprint: runtimePublicKey(id).keyThumbprint,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      status: "published",
      owner_ref: record.recordId,
      catalog_origin: CATALOG,
      catalog_agent_id: AGENT,
      merchant_id: "merchant_demo",
      binding_id: "binding_old",
      device_code: "old-private-code",
      user_code: "OLD-CODE",
      verification_uri: `${CATALOG}/portal/connect/old_enrollment`,
      interval: 5,
      preview_digest: "sha256:old-card",
      frozen_card: {} as AgentCard,
    } as unknown as (typeof enrollmentFile.sessions)[number]);
    writeFileAtomic(`${deps.dataDir}/merchant-enrollments.json`, `${JSON.stringify(enrollmentFile)}\n`, { mode: 0o600 });
    await reconcileBinding(record, deps);
    fake.setAuthorized(true);
    const recovered = await reconcileBinding(store.getRecord(record.recordId)!, deps);
    expect(recovered.record.status).toBe("PUBLISHED");
    expect(fake.publishExpectedRevision).toBe(3);
    expect(fake.activateExpectedRevision).toBe(3);
    const persisted = readEnrollmentStore(deps.dataDir!);
    expect(persisted.sessions.find((item) => item.enrollment_id === "old_enrollment")?.status).toBe("replaced");
    const state = persisted.sessions.find((item) => item.enrollment_id !== "old_enrollment" && item.status === "published") as unknown as {
      merchant_id: string;
      catalog_agent_id: string;
      binding_id: string;
    } | undefined;
    expect(state).toMatchObject({ merchant_id: "merchant_demo", catalog_agent_id: AGENT, binding_id: "binding_demo" });
  });

  it("does not restart authorization from later records that lost their secure session state", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("READY_TO_PUBLISH");
    const { fetchImpl } = mockFetch(() => ({ status: 500 }));
    await expect(reconcileBinding(record, pipelineDeps(store, id, fetchImpl))).rejects.toMatchObject({ code: "BINDING_NOT_CONFIRMED" });
  });
});

describe("S4：publishCardForRecord（确认公开信息串联）", () => {
  it("构造名片 + 发布 + CAS 激活，返回权威证据；推进后 PUBLISHED", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("READY_TO_PUBLISH");
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "GET") return { status: 200, json: bindingDocument(id, null) };
      // catalog 真实回执形状：card-publications → {card_revision, digest, etag}；
      // publish（激活）→ {active_revision, etag}。
      if (call.url.endsWith("/card-publications")) {
        return { status: 200, json: { card_revision: 1, digest: "sha256:x", etag: '"e1"' } };
      }
      return { status: 200, json: { active_revision: 1, etag: '"e1"' } };
    });
    const deps = pipelineDeps(store, id, fetchImpl);
    const result = await publishCardForRecord(record, deps);
    expect(result.source).toBe("catalog:card-publication");
    expect(result.applicationId).toBe("wbapp_1");

    // 端点序列：匿名读绑定 → card-publications → publish（CAS）。
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${CATALOG}/v1/agents/${AGENT}/runtime-binding`,
      `POST ${CATALOG}/v1/agents/${AGENT}/card-publications`,
      `POST ${CATALOG}/v1/agents/${AGENT}/publish`,
    ]);
    // 激活调用体：平铺，带刚发布的 card_revision 与绑定 binding_id（catalog 实际契约）。
    expect(calls[2]!.body).toEqual({
      agent_id: AGENT,
      binding_id: "binding_demo",
      card_revision: 1,
      expected_revision: 0,
    });

    // 模拟向导 advance 通道：证据经 store.advance 推进（单点把关）。
    const published = store.advance({
      recordId: record.recordId,
      expectedRevision: record.revision,
      nextStatus: "PUBLISHED",
      step: "public-profile",
      evidence: result,
    });
    expect(published.status).toBe("PUBLISHED");
    const plan = planWizard(published);
    expect(plan.currentStep).toBeNull();
    expect(plan.steps.every((step) => step.state === "DONE")).toBe(true);
  });

  it("未确认不发布：公开读没有匹配绑定 → 拒绝，且不发出任何发布请求", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("READY_TO_PUBLISH");
    const { fetchImpl, calls } = mockFetch(() => ({ status: 404 }));
    await expect(
      publishCardForRecord(record, pipelineDeps(store, id, fetchImpl)),
    ).rejects.toMatchObject({ code: "BINDING_NOT_CONFIRMED" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(store.getRecord(record.recordId)!.status).toBe("READY_TO_PUBLISH");
  });

  it("目录不可达 → pending_publication 留痕，状态不谎报（仍是 READY_TO_PUBLISH）", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("READY_TO_PUBLISH");
    const { fetchImpl } = mockFetch((call) => {
      if (call.method === "GET") return { status: 200, json: bindingDocument(id, null) };
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    await expect(
      publishCardForRecord(record, pipelineDeps(store, id, fetchImpl)),
    ).rejects.toMatchObject({ code: "CATALOG_UNREACHABLE" });
    const current = store.getRecord(record.recordId)!;
    expect(current.status).toBe("READY_TO_PUBLISH");
    const summaries = store.evidenceFor(record.recordId).map((entry) => entry.summary);
    expect(summaries.some((summary) => summary.startsWith(PENDING_PUBLICATION_MARKER))).toBe(true);
  });

  it("发布回执缺 card_revision → PUBLISH_RECEIPT_INVALID，记录 BLOCKED 报人工（不猜版本号）", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("READY_TO_PUBLISH");
    const { fetchImpl, calls } = mockFetch((call) =>
      call.method === "GET" ? { status: 200, json: bindingDocument(id, null) } : { status: 200, json: {} },
    );
    await expect(
      publishCardForRecord(record, pipelineDeps(store, id, fetchImpl)),
    ).rejects.toMatchObject({ code: "PUBLISH_RECEIPT_INVALID" });
    // 激活请求未发出（没有版本号绝不猜）。
    expect(calls.some((call) => call.url.endsWith("/publish"))).toBe(false);
    expect(store.getRecord(record.recordId)!.status).toBe("BLOCKED");
  });

  it("CAS 冲突 → BLOCKED 报人工", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("READY_TO_PUBLISH");
    const { fetchImpl } = mockFetch((call) =>
      call.method === "GET" ? { status: 200, json: bindingDocument(id, 3) } : { status: 409 },
    );
    await expect(
      publishCardForRecord(record, pipelineDeps(store, id, fetchImpl)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const current = store.getRecord(record.recordId)!;
    expect(current.status).toBe("BLOCKED");
    expect(current.lastError).toContain("人工");
  });
});

describe("advance 通道适配器（catalogPlatformEvidenceAdapter）", () => {
  it("public-profile：发布成功后供出权威证据；不可达 → platform_failure（不推进）", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("READY_TO_PUBLISH");
    const { fetchImpl } = mockFetch((call) =>
      call.method === "GET" ? { status: 200, json: bindingDocument(id, null) } : { status: 200, json: { revision: 1 } },
    );
    const adapter = catalogPlatformEvidenceAdapter(pipelineDeps(store, id, fetchImpl));
    const result = await adapter({ stepId: "public-profile", recordId: record.recordId });
    expect(result).toMatchObject({ kind: "platform_query", source: "catalog:card-publication" });

    const unreachable = catalogPlatformEvidenceAdapter(
      pipelineDeps(store, id, (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    );
    const failed = await unreachable({ stepId: "public-profile", recordId: record.recordId });
    expect(failed).toMatchObject({ kind: "platform_failure", code: "catalog_unreachable" });
    expect(store.getRecord(record.recordId)!.status).toBe("READY_TO_PUBLISH");
  });

  it("不代答其它步骤；状态不对时返回 undefined 且无副作用", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("DEPLOYED_UNBOUND");
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const adapter = catalogPlatformEvidenceAdapter(pipelineDeps(store, id, fetchImpl));
    expect(await adapter({ stepId: "platform-consent", recordId: record.recordId })).toBeUndefined();
    expect(await adapter({ stepId: "catalog-confirm", recordId: record.recordId })).toBeUndefined();
    // 记录不在 READY_TO_PUBLISH：public-profile 适配器不得产生发布副作用。
    expect(await adapter({ stepId: "public-profile", recordId: record.recordId })).toBeUndefined();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    // 记录不在 VERIFYING 或无检查能力：service-check 同样不代答。
    expect(await adapter({ stepId: "service-check", recordId: record.recordId })).toBeUndefined();
  });

  it("service-check：VERIFYING + 检查通过 → 权威证据；不过 → platform_failure", async () => {
    const id = identity();
    const { store, record } = storeWithRecord("DEPLOYED_UNBOUND");
    const verifying = store.advance({
      recordId: record.recordId,
      expectedRevision: record.revision,
      nextStatus: "BOUND",
      evidence: evidence(),
    });
    const verifying2 = store.advance({
      recordId: verifying.recordId,
      expectedRevision: verifying.revision,
      nextStatus: "VERIFYING",
      evidence: evidence(),
    });
    const { fetchImpl } = mockFetch(() => ({ status: 200, json: {} }));
    const adapter = catalogPlatformEvidenceAdapter(pipelineDeps(store, id, fetchImpl));
    const ok = await adapter({ stepId: "service-check", recordId: verifying2.recordId });
    expect(ok).toMatchObject({ kind: "platform_query", source: "kiwi-cloud:service-check" });

    const failing = catalogPlatformEvidenceAdapter(
      pipelineDeps(store, id, fetchImpl, {
        serviceCheck: async () => ({ ok: false, detail: "STORAGE_MISSING" }),
      }),
    );
    const bad = await failing({ stepId: "service-check", recordId: verifying2.recordId });
    expect(bad).toMatchObject({ kind: "platform_failure", code: "service_check_failed" });
  });
});

describe("CatalogPipelineError", () => {
  it("是带 code 的类型化错误", () => {
    expect(new CatalogPipelineError("BINDING_NOT_CONFIRMED", "x").code).toBe("BINDING_NOT_CONFIRMED");
  });
});
