/**
 * M4 §5.4：开通向导的读写端点（`/merchant/api/onboarding/*`）。
 *
 * 这一组测试的重点不是"能不能推进"，而是**谁能推进、拿什么推进**：
 *
 *   - **证据只能来自服务端**：请求体给不了权威证据（T029/T007）——粘贴的 id、
 *     商家转述、`approved=true` 都不行；适配器未配置时需证据的步骤明确 503；
 *   - **权限**：开通属资源创建 → owner 专属（operator/viewer 403 且业务无变化）；
 *   - **归属**：别人的记录一律 404（与不存在不可区分）；
 *   - **幂等**：同键同摘要回原回执、同键不同摘要 409（与其它写命令同口径）；
 *   - **CSRF/Origin**：与 BD-02 同一道写门；
 *   - **同一份权威**：与 `/admin/onboarding` 读的是同一个 OnboardingStore（无状态分叉）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";

import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import type { MerchantRole } from "../src/merchant/application/actor.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { OnboardingStore } from "../src/cloud/onboarding/store.js";
import type { AuthoritativeEvidence } from "../src/cloud/onboarding/types.js";

const FIXED_NOW = new Date("2026-09-21T10:00:00Z");
const MERCHANT = "merchant-001";
const ORIGIN = "https://merchant.example";
const VERSION_DIGEST = "sha256:" + "a".repeat(64);

const sessionsDb = new DatabaseSync(":memory:");
const db = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db: sessionsDb });
const operations = new MerchantManagementOperationStore({ db, now: () => FIXED_NOW.toISOString() });
const store = new OnboardingStore(db, { now: () => FIXED_NOW.toISOString() });

/** 平台适配器：默认"取不到回执"（真实形态——平台能力尚未落地）。 */
const platformEvidence = vi.fn<
  (input: { stepId: string; recordId: string }) => Promise<AuthoritativeEvidence | undefined>
>(async () => undefined);

let withPlatformAdapter = true;
const baseOptions = () => ({
  merchantId: MERCHANT,
  generation: () => 1,
  runtimeVersion: "test-runtime",
  sessions,
  allowedOrigins: [ORIGIN],
  listPending: () => [],
  mintCandidateConfirmation: () => "tok",
  executeDecision: async () => {},
  drafts: new MerchantImportDraftStore({ db, now: () => FIXED_NOW.toISOString() }),
  operations,
  serviceState: new MutableServiceState("OPERATING"),
  readiness: async () => ({ ready: true, checks: {} }),
  now: () => FIXED_NOW,
  onboarding: {
    store,
    // 结构上"未配置"的情况单开一个 server 测（见 withoutAdapter）
    ...(withPlatformAdapter ? { platformEvidence: (input: { stepId: string; recordId: string }) => platformEvidence(input) } : {}),
  },
});

let server: Server;
let base: string;
let bareServer: Server;
let bareBase: string;

beforeAll(async () => {
  server = createServer(createMerchantManagementApiHandler(baseOptions()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);

  // 无平台适配器的实例（同一份存储）——测"未配置即 503"
  const bare = { ...baseOptions() };
  bare.onboarding = { store };
  bareServer = createServer(createMerchantManagementApiHandler(bare));
  await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", resolve));
  const bareAddress = bareServer.address();
  bareBase =
    "http://127.0.0.1:" + (typeof bareAddress === "object" && bareAddress !== null ? bareAddress.port : 0);
});

afterAll(async () => {
  for (const s of [server, bareServer]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

beforeEach(() => {
  // 本实例只服务一个商家（与生产一致：options.merchantId 固定），所以隔离靠
  // **把上一用例留下的活跃记录取消掉**，而不是换商家——换商家会被 API 层的
  // 实例↔会话一致性检查当越权拒掉（那正是"别人的记录 → 404"那条要测的）。
  const active = store.activeRecord(MERCHANT);
  if (active !== undefined) store.cancel(active.recordId, active.revision);
  platformEvidence.mockReset();
  platformEvidence.mockImplementation(async () => undefined);
  withPlatformAdapter = true;
});

/**
 * 登录并取 CSRF。**必须从要调用的那台 server 取**：CSRF = HMAC(sessionId, 进程密钥)，
 * 而进程密钥是每个 handler 实例各自生成的——A 实例的令牌在 B 实例上必然无效。
 * （生产是单活动实例，见 BD §12.3；这里只是测试同时跑了两台。）
 */
async function login(
  role: MerchantRole,
  merchantId: string = MERCHANT,
  origin: string = base,
): Promise<{ cookie: string; csrf: string }> {
  const { sessionId } = sessions.createSession({ principalId: `admin:${merchantId}`, merchantId, role });
  const res = await fetch(`${origin}/merchant/api/session`, {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}` },
  });
  const json = (await res.json()) as { csrf_token: string };
  return { cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}`, csrf: json.csrf_token };
}

async function call(
  origin: string,
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; origin?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(origin + path, {
    method,
    headers: {
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.csrf !== undefined ? { "x-csrf-token": opts.csrf } : {}),
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** 打开一个意图，返回记录 id。 */
/** 幂等键计数器：**所有**写命令的键都必须跨用例唯一（共享 operations 存储）。 */
let KEY_SEQ = 0;
function nextKey(prefix: string): string {
  KEY_SEQ += 1;
  return `${prefix}-${KEY_SEQ}`;
}

let INTENT_SEQ = 0;
async function openIntent(auth: { cookie: string; csrf: string }, key?: string): Promise<string> {
  // 幂等键必须每用例唯一：store 的 onb-open: 键会一直指回**第一条**记录，
  // 复用默认值会让后续用例拿到那条（已被 beforeEach 取消的）旧记录。
  INTENT_SEQ += 1;
  const intentKey = key ?? `k-open-${INTENT_SEQ}`;
  const res = await call(base, "POST", "/merchant/api/onboarding/intents", {
    cookie: auth.cookie,
    csrf: auth.csrf,
    origin: ORIGIN,
    body: { intent_id: `intent-${MERCHANT}`, version_digest: VERSION_DIGEST, idempotency_key: intentKey },
  });
  expect(res.status).toBe(200);
  const record = res.json["record"] as { recordId: string };
  return record.recordId;
}

describe("权限：开通是 owner 专属", () => {
  it("viewer / operator 都不能开通（403，且没有记录产生）", async () => {
    for (const role of ["viewer", "operator"] as const) {
      const merchantId = MERCHANT;
      const auth = await login(role, merchantId);
        const res = await call(base, "POST", "/merchant/api/onboarding/intents", {
        cookie: auth.cookie,
        csrf: auth.csrf,
        origin: ORIGIN,
        body: { intent_id: "i", version_digest: VERSION_DIGEST, idempotency_key: nextKey("k") },
      });
      expect(res.status).toBe(403);
      expect(store.activeRecord(merchantId)).toBeUndefined();
    }
  });

  it("owner 可以打开意图；GET 返回由记录推导的计划（T010）", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth);
    expect(recordId).toMatch(/^onb_/);

    const got = await call(base, "GET", "/merchant/api/onboarding", { cookie: auth.cookie });
    expect(got.status).toBe(200);
    const plan = got.json["plan"] as { currentStep: string };
    expect(plan.currentStep).toBe("login-binding");
  });
});

describe("T029/T007：证据只能来自服务端", () => {
  it("需要权威证据的步骤：适配器未配置 → 503，状态不推进", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth);
    // 无适配器那台 server 自己的会话与 CSRF（进程密钥不同）
    const bareAuth = await login("owner", MERCHANT, bareBase);
    const step1 = await call(bareBase, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: bareAuth.cookie,
      csrf: bareAuth.csrf,
      origin: ORIGIN,
      body: { step: "login-binding", expected_revision: 0, idempotency_key: nextKey("k") },
    });
    expect(step1.status).toBe(200);

    const res = await call(bareBase, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: bareAuth.cookie,
      csrf: bareAuth.csrf,
      origin: ORIGIN,
      body: { step: "platform-consent", expected_revision: 1, idempotency_key: nextKey("k") },
    });
    expect(res.status).toBe(503);
    expect(String(res.json["message"])).toContain("platform adapter is not configured");
    // 状态没动
    expect(store.getRecord(recordId)?.status).toBe("AWAITING_PLATFORM_CONSENT");
    expect(store.getRecord(recordId)?.applicationId).toBeNull();
  });

  it("适配器取不到回执 → 503，同样不推进", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth);
    await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: ORIGIN,
      body: { step: "login-binding", expected_revision: 0, idempotency_key: nextKey("k") },
    });
    const res = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: ORIGIN,
      body: { step: "platform-consent", expected_revision: 1, idempotency_key: nextKey("k") },
    });
    expect(res.status).toBe(503);
    expect(String(res.json["message"])).toContain("did not return an authoritative receipt");
  });

  it("请求体里塞证据字段一律被拒（未知字段 fail-closed）——客户端不能自报回执", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth);
    await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: ORIGIN,
      body: { step: "login-binding", expected_revision: 0, idempotency_key: nextKey("k") },
    });
    const res = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: ORIGIN,
      body: {
        step: "platform-consent",
        expected_revision: 1,
        idempotency_key: nextKey("k"),
        // 伪造的"权威回执"——必须连字段都不被接受
        evidence: { kind: "platform_query", applicationId: "wbapp_FAKE", generation: 1, source: "x", observedAt: "t" },
      },
    });
    expect(res.status).toBe(400);
    expect(store.getRecord(recordId)?.applicationId).toBeNull();
  });

  it("适配器给出真回执 → 推进成功，applicationId 落库", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth);
    const step1 = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: ORIGIN,
      body: { step: "login-binding", expected_revision: 0, idempotency_key: nextKey("k") },
    });
    expect(step1.status).toBe(200);
    platformEvidence.mockImplementation(async () => ({
      kind: "platform_query",
      applicationId: "wbapp_REAL",
      generation: 1,
      source: "inspectOwnedApplication",
      observedAt: FIXED_NOW.toISOString(),
    }));
    const res = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: ORIGIN,
      body: { step: "platform-consent", expected_revision: 1, idempotency_key: nextKey("k") },
    });
    expect(res.status).toBe(200);
    expect(store.getRecord(recordId)?.status).toBe("ACTIVATED");
    expect(store.getRecord(recordId)?.applicationId).toBe("wbapp_REAL");
  });
});

describe("归属与幂等", () => {
  it("别的商家的会话 → 404（本实例只服务一个商家；与不存在不可区分）", async () => {
    const owner = await login("owner", MERCHANT);
    const other = await login("owner", "merchant-999");
    const recordId = await openIntent(owner);
    const res = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: other.cookie,
      csrf: other.csrf,
      origin: ORIGIN,
      body: { step: "login-binding", expected_revision: 0, idempotency_key: nextKey("k") },
    });
    expect(res.status).toBe(404);
  });

  it("同键同摘要回原回执（不产生第二次业务效果）", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth, "k-open-i");
    const body = { step: "login-binding", expected_revision: 0, idempotency_key: nextKey("k") };
    const first = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body,
    });
    const second = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json["operation_id"]).toBe(first.json["operation_id"]);
    // revision 只前进过一次
    expect(store.getRecord(recordId)?.revision).toBe(1);
  });

  it("同键不同摘要 → 409", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    // 两次调用**共用**同一个键（就地生成的键各不相同，测不出冲突）
    const sharedKey = nextKey("shared");
    const recordId = await openIntent(auth, "k-open-ii");
    await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN,
      body: { step: "login-binding", expected_revision: 0, idempotency_key: sharedKey },
    });
    const res = await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN,
      body: { step: "catalog-confirm", expected_revision: 0, idempotency_key: sharedKey },
    });
    expect(res.status).toBe(409);
  });

  it("CSRF 缺失 → 403（写门与 BD-02 同一道）", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const res = await call(base, "POST", "/merchant/api/onboarding/intents", {
      cookie: auth.cookie, origin: ORIGIN,
      body: { intent_id: "i", version_digest: VERSION_DIGEST, idempotency_key: nextKey("k") },
    });
    expect(res.status).toBe(403);
    expect(String(res.json["message"])).toContain("CSRF");
  });
});

describe("T007：拒绝授权 = 保持等待", () => {
  it("consent-refused 不改状态、不写 applicationId，只留痕", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth, "k-open-iii");
    await call(base, "POST", `/merchant/api/onboarding/${recordId}/advance`, {
      cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN,
      body: { step: "login-binding", expected_revision: 0, idempotency_key: nextKey("k") },
    });
    const res = await call(base, "POST", `/merchant/api/onboarding/${recordId}/consent-refused`, {
      cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN,
      body: { expected_revision: 1, idempotency_key: nextKey("k"), note: "商家在平台确认框点了拒绝" },
    });
    expect(res.status).toBe(200);
    const record = store.getRecord(recordId);
    expect(record?.status).toBe("AWAITING_PLATFORM_CONSENT");
    expect(record?.applicationId).toBeNull();
    // 拒绝被留痕（审计能看到"商家拒绝了"，而不是含糊的未知失败）
    expect(store.evidenceFor(recordId).some((e) => e.summary.includes("consent refused"))).toBe(true);
  });
});

describe("同一份权威：向导与 /admin 视图同源", () => {
  it("端点写入的记录，store 直接读得到（无状态分叉）", async () => {
    const merchantId = MERCHANT;
    const auth = await login("owner", merchantId);
    const recordId = await openIntent(auth, "k-open-iv");
    const fromStore = store.activeRecord(merchantId);
    expect(fromStore?.recordId).toBe(recordId);
    // GET 视图与 store 一致
    const got = await call(base, "GET", "/merchant/api/onboarding", { cookie: auth.cookie });
    const record = got.json["record"] as { recordId: string };
    expect(record.recordId).toBe(recordId);
  });
});
