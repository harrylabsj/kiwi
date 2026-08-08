/**
 * A2A Server 反滥用限流（WP3，基线 §31）—— 单元 + 管线集成测试。
 *
 * 单元（A2AServerThrottle，注入时钟）：
 *   - 窗口边界（半开滑动窗口：`entry <= now - windowMs` 即过期）；
 *   - 双维度独立计数（per-identity + per-domain）；
 *   - malformed budget 独立性与恢复（独立于正常限流，窗口滑动即恢复）；
 *   - 并发上限（单身份在途任务槽）；
 *   - trust 档位映射（T0 最严 / T3 最宽）+ WP1 指纹变更短期降档；
 *   - 未验签来源按 remoteAddress 且限额更严（identity cycling 缓解）；
 *   - 拒绝携带档位 retry_after。
 *
 * 集成（node:http 起真实 server，throttle 判定在认证之后、schema 校验之前）：
 *   - 超限拒绝 → error data.protocol_code=rate_limited + retry_after；
 *   - schema_invalid 喂入 malformed budget → 阻断 → 时钟推进后恢复；
 *   - 并发上限：慢 handler 下第二个并发请求被拒；
 *   - identity cycling：轮换匿名身份共享同一 remoteAddress 桶；
 *   - 被拒请求不产生 Ledger 商业写入、无幂等记录（fail-closed 一致性）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { A2AServer, A2AServerThrottle, domainFromUcpProfile } from "../src/a2a/server/index.js";
import type {
  AuthVerifier,
  NegotiationHandler,
  ThrottleTierTable,
  TrustTierLimits,
} from "../src/a2a/server/index.js";
import type { A2AMessage } from "../src/a2a/client/index.js";
import type { TrustLevel } from "../src/trust/identity/trust-policy.js";
import { NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Clock {
  t: number;
}

function makeThrottle(
  overrides: {
    windowMs?: number;
    tiers?: Partial<ThrottleTierTable>;
    unverifiedIdentityScale?: number;
  } = {},
): { throttle: A2AServerThrottle; clock: Clock } {
  const clock: Clock = { t: 0 };
  const throttle = new A2AServerThrottle({
    windowMs: overrides.windowMs ?? 1000,
    now: () => clock.t,
    ...(overrides.tiers !== undefined ? { tiers: overrides.tiers } : {}),
    ...(overrides.unverifiedIdentityScale !== undefined
      ? { unverifiedIdentityScale: overrides.unverifiedIdentityScale }
      : {}),
  });
  return { throttle, clock };
}

const verifiedT0 = { identityVerified: true, trustLevel: "T0" as TrustLevel };
const verifiedT3 = { identityVerified: true, trustLevel: "T3" as TrustLevel };

/** 定制 T0（严）/ T3（宽）档位，便于档位映射测试。 */
const STRICT_T0: TrustTierLimits = {
  identityRequestsPerWindow: 2,
  domainRequestsPerWindow: 2,
  maxConcurrentTasks: 1,
  malformedBudget: 3,
  retryAfterSeconds: 7,
};
const WIDE_T3: TrustTierLimits = {
  identityRequestsPerWindow: 20,
  domainRequestsPerWindow: 40,
  maxConcurrentTasks: 5,
  malformedBudget: 100,
  retryAfterSeconds: 1,
};

// ---- 集成 server 辅助 ------------------------------------------------------

interface Started {
  url: string;
  a2aUrl: string;
  ledger: LedgerStore;
  idempotency: IdempotencyStore;
  httpServer: http.Server;
  dir: string;
}

const registry: Array<{ httpServer: http.Server; dir: string }> = [];

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function startServer(options: {
  throttle?: A2AServerThrottle;
  authVerifier?: AuthVerifier;
  handler?: NegotiationHandler;
}): Promise<Started> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-throttle-"));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const server = new A2AServer({
    card: () => ({
      name: "Test Kiwi Merchant",
      description: "A2A throttle test merchant",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: holder.baseUrl,
    }),
    ledger,
    idempotency,
    ...(options.handler !== undefined ? { handler: options.handler } : {}),
    ...(options.authVerifier !== undefined ? { authVerifier: options.authVerifier } : {}),
    ...(options.throttle !== undefined ? { throttle: options.throttle } : {}),
  });
  const httpServer = server.createServer();
  const url = await listen(httpServer);
  holder.baseUrl = url;
  registry.push({ httpServer, dir });
  return { url, a2aUrl: `${url}/`, ledger, idempotency, httpServer, dir };
}

function knpMessage(envelope: NegotiationEnvelope): A2AMessage {
  return {
    role: "agent",
    parts: [{ kind: "data", data: { knp_envelope: envelope } }],
    messageId: envelope.message_id,
  };
}

function makeEnvelope(seed: string): ReturnType<typeof finalizeEnvelope> {
  return finalizeEnvelope({ ...validEnvelopeFields(), message_id: `msg_${seed}` });
}

async function rpc(
  a2aUrl: string,
  method: string,
  params: unknown,
  id = "req-1",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(a2aUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function rpcError(body: Record<string, unknown>): Record<string, unknown> {
  const error = body["error"];
  return (error === null || typeof error !== "object" ? {} : error) as Record<string, unknown>;
}

function errorData(error: Record<string, unknown>): Record<string, unknown> {
  const data = error["data"];
  return (data === null || typeof data !== "object" ? {} : data) as Record<string, unknown>;
}

function malformedMessage(messageId: string): A2AMessage {
  // 通过 parseInboundMessage、但无 KNP envelope → extractKnpEnvelope 抛 schema_invalid。
  return { role: "agent", parts: [{ kind: "text", text: "hi" }], messageId };
}

function verifiedVerifier(identity: string, trustLevel: TrustLevel = "T0"): AuthVerifier {
  return {
    name: `test-${identity}`,
    verify: () => ({ authenticated: true, identity, trustLevel, identityVerified: true }),
  };
}

afterEach(async () => {
  for (const entry of registry) {
    entry.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => entry.httpServer.close(() => resolve()));
    rmSync(entry.dir, { recursive: true, force: true });
  }
  registry.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 单元：A2AServerThrottle
// ---------------------------------------------------------------------------

describe("A2AServerThrottle: 窗口边界", () => {
  it("expires entries at the sliding window boundary", () => {
    const { throttle, clock } = makeThrottle({ tiers: { T0: STRICT_T0 } });
    const req = { identity: "peer-1", ...verifiedT0 };

    expect(throttle.check(req).allowed).toBe(true); // t=0
    clock.t = 100;
    expect(throttle.check(req).allowed).toBe(true); // t=100
    clock.t = 200;
    expect(throttle.check(req).allowed).toBe(false); // 窗口内已有 2 条 → 拒绝

    // 窗口边界：t=1000 时 t=0 的条目过期（半开窗口 `entry <= now - windowMs`）。
    clock.t = 1000;
    expect(throttle.check(req).allowed).toBe(true); // 只剩 [100]
    clock.t = 1001;
    expect(throttle.check(req).allowed).toBe(false); // [100, 1000] → 再次拒绝
  });

  it("separates per-identity buckets for different identities", () => {
    const { throttle } = makeThrottle({ tiers: { T0: STRICT_T0 } });
    expect(throttle.check({ identity: "a", ...verifiedT0 }).allowed).toBe(true);
    expect(throttle.check({ identity: "a", ...verifiedT0 }).allowed).toBe(true);
    expect(throttle.check({ identity: "a", ...verifiedT0 }).allowed).toBe(false);
    // b 是独立桶，不受 a 影响。
    expect(throttle.check({ identity: "b", ...verifiedT0 }).allowed).toBe(true);
  });
});

describe("A2AServerThrottle: 双维度独立计数", () => {
  it("counts per-identity and per-domain limits independently", () => {
    const { throttle } = makeThrottle({
      tiers: {
        T0: {
          identityRequestsPerWindow: 100,
          domainRequestsPerWindow: 2,
          maxConcurrentTasks: 10,
          malformedBudget: 100,
          retryAfterSeconds: 3,
        },
      },
    });
    const dom = { domain: "example.com" };
    // 三个不同身份共享同一域桶：身份各自远未超限，域桶到第 3 次拒绝。
    expect(throttle.check({ identity: "x", ...verifiedT0, ...dom }).allowed).toBe(true);
    expect(throttle.check({ identity: "y", ...verifiedT0, ...dom }).allowed).toBe(true);
    const third = throttle.check({ identity: "z", ...verifiedT0, ...dom });
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.reason).toContain("per-domain");
    // 不同域 → 独立桶，仍可放行。
    expect(throttle.check({ identity: "z", ...verifiedT0, domain: "other.com" }).allowed).toBe(
      true,
    );
  });

  it("skips the per-domain dimension when no domain is present", () => {
    const { throttle } = makeThrottle({
      tiers: {
        T0: {
          identityRequestsPerWindow: 100,
          domainRequestsPerWindow: 1,
          maxConcurrentTasks: 10,
          malformedBudget: 100,
          retryAfterSeconds: 3,
        },
      },
    });
    // 无 domain → 每次都能过 per-domain 维度（identity 上限 100 足够）。
    for (let i = 0; i < 5; i++) {
      expect(throttle.check({ identity: `p${i}`, ...verifiedT0 }).allowed).toBe(true);
    }
  });
});

describe("A2AServerThrottle: malformed budget（独立于正常限流）", () => {
  it("blocks the source after the budget is exhausted and recovers after the window", () => {
    const { throttle, clock } = makeThrottle({
      tiers: {
        T0: {
          identityRequestsPerWindow: 1000,
          domainRequestsPerWindow: 1000,
          maxConcurrentTasks: 10,
          malformedBudget: 3,
          retryAfterSeconds: 9,
        },
      },
    });
    const src = { identity: "peer-m", ...verifiedT0 };

    // 正常限流远未耗尽；3 次 schema_invalid 即触发 budget 阻断。
    throttle.recordMalformed(src);
    throttle.recordMalformed(src);
    throttle.recordMalformed(src);
    const blocked = throttle.check(src);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.reason).toContain("malformed request budget");
      expect(blocked.retryAfterSeconds).toBe(9);
    }

    // 不同来源不受影响（budget 按来源独立）。
    expect(throttle.check({ identity: "peer-other", ...verifiedT0 }).allowed).toBe(true);

    // 窗口滑动 → 恢复。
    clock.t = 1000;
    expect(throttle.check(src).allowed).toBe(true);
  });

  it("never feeds the budget from legitimate requests", () => {
    const { throttle } = makeThrottle({
      tiers: {
        T0: {
          identityRequestsPerWindow: 100,
          domainRequestsPerWindow: 100,
          maxConcurrentTasks: 10,
          malformedBudget: 2,
          retryAfterSeconds: 9,
        },
      },
    });
    // 合法请求只消耗限流桶，不记 malformed。
    for (let i = 0; i < 10; i++) {
      expect(throttle.check({ identity: "good", ...verifiedT0 }).allowed).toBe(true);
    }
  });
});

describe("A2AServerThrottle: 任务并发上限", () => {
  it("caps in-flight task slots per identity and releases on leave", () => {
    const { throttle } = makeThrottle({ tiers: { T0: STRICT_T0 } }); // maxConcurrentTasks: 1
    const req = { identity: "peer-1", ...verifiedT0 };

    expect(throttle.enterTask(req)).toEqual({ ok: true });
    const second = throttle.enterTask(req);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.retryAfterSeconds).toBe(7);
      expect(second.reason).toContain("concurrency");
    }
    throttle.leaveTask(req);
    expect(throttle.enterTask(req)).toEqual({ ok: true });
  });

  it("keeps concurrency separate across identities", () => {
    const { throttle } = makeThrottle({ tiers: { T0: STRICT_T0 } });
    expect(throttle.enterTask({ identity: "a", ...verifiedT0 }).ok).toBe(true);
    expect(throttle.enterTask({ identity: "b", ...verifiedT0 }).ok).toBe(true); // 独立身份不受 a 占用影响
  });
});

describe("A2AServerThrottle: trust 档位映射", () => {
  it("maps T0 strict and T3 wide deterministically", () => {
    const { throttle } = makeThrottle({ tiers: { T0: STRICT_T0, T3: WIDE_T3 } });
    for (let i = 0; i < 2; i++) {
      expect(throttle.check({ identity: "low", ...verifiedT0 }).allowed).toBe(true);
    }
    expect(throttle.check({ identity: "low", ...verifiedT0 }).allowed).toBe(false);

    for (let i = 0; i < 20; i++) {
      expect(throttle.check({ identity: "high", ...verifiedT3 }).allowed).toBe(true);
    }
    expect(throttle.check({ identity: "high", ...verifiedT3 }).allowed).toBe(false);
  });

  it("downgrades the tier while a WP1 fingerprint change is flagged", () => {
    const { throttle } = makeThrottle({
      tiers: {
        T0: STRICT_T0,
        T1: {
          identityRequestsPerWindow: 4,
          domainRequestsPerWindow: 8,
          maxConcurrentTasks: 2,
          malformedBudget: 100,
          retryAfterSeconds: 5,
        },
        T3: WIDE_T3,
      },
    });
    // 未降档：T3 宽额度。
    for (let i = 0; i < 4; i++) {
      expect(throttle.check({ identity: "fp-norm", ...verifiedT3 }).allowed).toBe(true);
    }
    // 降档（fingerprintChanged）→ 封顶 T1（identity 上限 4）：第 5 次拒绝。
    for (let i = 0; i < 4; i++) {
      expect(
        throttle.check({ identity: "fp-down", ...verifiedT3, fingerprintChanged: true }).allowed,
      ).toBe(true);
    }
    expect(
      throttle.check({ identity: "fp-down", ...verifiedT3, fingerprintChanged: true }).allowed,
    ).toBe(false);
  });

  it("defaults an unknown trust level to the strict T0 tier (fail-closed)", () => {
    const { throttle } = makeThrottle({ tiers: { T0: STRICT_T0 } });
    const req = { identity: "untyped", identityVerified: true }; // 无 trustLevel
    expect(throttle.check(req).allowed).toBe(true);
    expect(throttle.check(req).allowed).toBe(true);
    expect(throttle.check(req).allowed).toBe(false); // 按 T0（2 次上限）
  });
});

describe("A2AServerThrottle: 未验签来源（identity cycling 缓解）", () => {
  it("keys unverified sources by remoteAddress and applies stricter limits", () => {
    const { throttle } = makeThrottle({
      unverifiedIdentityScale: 0.5,
      tiers: { T0: STRICT_T0 }, // identity 上限 2，scale 0.5 → 1；并发上限 1 → 1
    });
    // 验签身份 T0：上限 2。
    expect(throttle.check({ identity: "v-peer", ...verifiedT0 }).allowed).toBe(true);
    expect(throttle.check({ identity: "v-peer", ...verifiedT0 }).allowed).toBe(true);
    expect(throttle.check({ identity: "v-peer", ...verifiedT0 }).allowed).toBe(false);

    // 未验签：上限 1，且换匿名身份共享同一 IP 桶。
    expect(throttle.check({ identity: "anon-a", remoteAddress: "10.0.0.7" }).allowed).toBe(true);
    expect(throttle.check({ identity: "anon-b", remoteAddress: "10.0.0.7" }).allowed).toBe(false);
  });
});

describe("domainFromUcpProfile", () => {
  it("derives the host from a profile URL and ignores malformed input", () => {
    expect(domainFromUcpProfile("https://buyer.example/.well-known/ucp")).toBe("buyer.example");
    expect(domainFromUcpProfile("http://BUYER.example:8080/ucp")).toBe("buyer.example");
    expect(domainFromUcpProfile(undefined)).toBeUndefined();
    expect(domainFromUcpProfile("not a url")).toBeUndefined();
    expect(domainFromUcpProfile("ftp://buyer.example/ucp")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 集成：A2AServer 管线接线
// ---------------------------------------------------------------------------

describe("A2AServer + throttle: 超限拒绝（rate_limited / retry_after）", () => {
  it("rejects beyond the per-identity limit and writes no Ledger business record", async () => {
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      tiers: {
        T0: {
          identityRequestsPerWindow: 2,
          domainRequestsPerWindow: 2,
          maxConcurrentTasks: 5,
          malformedBudget: 100,
          retryAfterSeconds: 8,
        },
      },
    });
    const { a2aUrl, ledger, idempotency } = await startServer({
      throttle,
      authVerifier: verifiedVerifier("peer-1", "T0"),
    });

    for (let i = 1; i <= 2; i++) {
      const res = await rpc(
        a2aUrl,
        "message/send",
        { message: knpMessage(makeEnvelope(`rl_${i}`)) },
        `rl-${i}`,
      );
      expect(res.status).toBe(200);
    }
    const before = ledger.events(NEGOTIATION_ID).length;
    expect(before).toBe(2);

    const res3 = await rpc(
      a2aUrl,
      "message/send",
      { message: knpMessage(makeEnvelope("rl_3")) },
      "rl-3",
    );
    expect(res3.status).toBe(200); // JSON-RPC 协议错误仍走 200（KNP 错误载体）。
    const err = rpcError(res3.body);
    expect(err.code).toBe(-32050);
    expect(errorData(err).protocol_code).toBe("rate_limited");
    expect(errorData(err).retry_after).toBe(8);

    // fail-closed 一致性：被拒请求不产生 Ledger 商业写入、无幂等记录。
    expect(ledger.events(NEGOTIATION_ID).length).toBe(before);
    expect(idempotency.get("peer-1", "msg_rl_3")).toBeNull();
  });

  it("tasks/get 独立限流：未知 id 的全链扫描不再无限制（评审项 B3）", async () => {
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      tiers: {
        T0: {
          identityRequestsPerWindow: 2,
          domainRequestsPerWindow: 100,
          maxConcurrentTasks: 5,
          malformedBudget: 100,
          retryAfterSeconds: 8,
        },
      },
    });
    const { a2aUrl } = await startServer({
      throttle,
      authVerifier: verifiedVerifier("peer-1", "T0"),
    });

    // 前两次 tasks/get 通过（限额 2；此前该路径完全不受限流）
    for (let i = 1; i <= 2; i++) {
      const res = await rpc(a2aUrl, "tasks/get", { id: `task_unknown_${i}` }, `tg-${i}`);
      expect(res.status).toBe(200);
    }
    // 第三次被限流（未知 id 每次触发全 Ledger 扫描，CPU 开销随规模线性放大）
    const res3 = await rpc(a2aUrl, "tasks/get", { id: "task_unknown_3" }, "tg-3");
    expect(res3.status).toBe(200); // JSON-RPC 协议错误载体仍走 200
    const err = rpcError(res3.body);
    expect(err.code).toBe(-32050);
    expect(errorData(err).protocol_code).toBe("rate_limited");
  });

  it("rejects beyond the per-domain limit across identities", async () => {
    let seq = 0;
    const cycling: AuthVerifier = {
      name: "cycling-verified",
      verify: () => ({
        authenticated: true,
        identity: `vp-${++seq}`,
        identityVerified: true,
        trustLevel: "T0",
      }),
    };
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      tiers: {
        T0: {
          identityRequestsPerWindow: 100,
          domainRequestsPerWindow: 2,
          maxConcurrentTasks: 10,
          malformedBudget: 100,
          retryAfterSeconds: 3,
        },
      },
    });
    const { a2aUrl } = await startServer({ throttle, authVerifier: cycling });
    const header = { "ucp-agent": 'profile="https://counterparty.example.com/ucp"' };

    for (let i = 1; i <= 3; i++) {
      const res = await rpc(
        a2aUrl,
        "message/send",
        { message: knpMessage(makeEnvelope(`dom_${i}`)) },
        `dom-${i}`,
        header,
      );
      if (i < 3) {
        expect(res.status).toBe(200);
      } else {
        const err = rpcError(res.body);
        expect(errorData(err).protocol_code).toBe("rate_limited");
        expect(errorData(err).detail).toContain("per-domain");
        expect(errorData(err).retry_after).toBe(3);
      }
    }
  });
});

describe("A2AServer + throttle: malformed budget 管线喂入与恢复", () => {
  it("feeds schema_invalid into the budget, blocks the source, then recovers after the window", async () => {
    const clock: Clock = { t: 0 };
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      now: () => clock.t,
      tiers: {
        T0: {
          identityRequestsPerWindow: 1000,
          domainRequestsPerWindow: 1000,
          maxConcurrentTasks: 5,
          malformedBudget: 3,
          retryAfterSeconds: 4,
        },
      },
    });
    const { a2aUrl, ledger } = await startServer({
      throttle,
      authVerifier: verifiedVerifier("peer-m", "T0"),
    });

    // 3 次 schema_invalid（无 KNP envelope）→ 各自拒绝 schema_invalid，喂入 budget。
    for (let i = 0; i < 3; i++) {
      const res = await rpc(
        a2aUrl,
        "message/send",
        { message: malformedMessage(`bad_${i}`) },
        `bad-${i}`,
      );
      expect(res.status).toBe(200);
      expect(errorData(rpcError(res.body)).protocol_code).toBe("schema_invalid");
    }
    expect(ledger.events(NEGOTIATION_ID).length).toBe(0);

    // 第 4 个（合法）→ budget 阻断 → rate_limited，无 Ledger 写入。
    const valid = makeEnvelope("after_block");
    const res4 = await rpc(a2aUrl, "message/send", { message: knpMessage(valid) }, "after-block");
    const err4 = rpcError(res4.body);
    expect(errorData(err4).protocol_code).toBe("rate_limited");
    expect(errorData(err4).retry_after).toBe(4);
    expect(ledger.events(NEGOTIATION_ID).length).toBe(0);

    // 时钟推进过窗口 → budget 恢复，合法请求正常处理并落账。
    clock.t += 60_000;
    const res5 = await rpc(
      a2aUrl,
      "message/send",
      { message: knpMessage(valid) },
      "after-recovery",
    );
    expect(res5.status).toBe(200);
    expect(ledger.events(NEGOTIATION_ID).length).toBe(1);
  });
});

describe("A2AServer + throttle: 任务并发上限", () => {
  it("rejects a second concurrent message/send and writes no Ledger for the rejected one", async () => {
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowHandler: NegotiationHandler = {
      name: "slow",
      async handle(ctx) {
        entered = true;
        await gate;
        return {
          kind: "accepted",
          message: {
            role: "agent",
            parts: [{ kind: "data", data: { knp_envelope: ctx.envelope, ack: true } }],
            messageId: `msg_reply_${ctx.envelope.message_id}`,
          },
        };
      },
    };
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      tiers: {
        T0: {
          identityRequestsPerWindow: 1000,
          domainRequestsPerWindow: 1000,
          maxConcurrentTasks: 1,
          malformedBudget: 100,
          retryAfterSeconds: 9,
        },
      },
    });
    const { a2aUrl, ledger } = await startServer({
      handler: slowHandler,
      throttle,
      authVerifier: verifiedVerifier("peer-1", "T0"),
    });

    const p1 = rpc(
      a2aUrl,
      "message/send",
      { message: knpMessage(makeEnvelope("conc_1")) },
      "conc-1",
    );
    // 等第一个请求进入 handler（并发槽已被占用）。
    await vi.waitFor(() => {
      if (!entered) throw new Error("handler not entered yet");
    });

    const p2 = rpc(
      a2aUrl,
      "message/send",
      { message: knpMessage(makeEnvelope("conc_2")) },
      "conc-2",
    );
    const res2 = await p2;
    const err2 = rpcError(res2.body);
    expect(errorData(err2).protocol_code).toBe("rate_limited");
    expect(errorData(err2).retry_after).toBe(9);
    expect(ledger.events(NEGOTIATION_ID).length).toBe(0);

    release();
    const res1 = await p1;
    expect(res1.status).toBe(200);
    expect(ledger.events(NEGOTIATION_ID).length).toBe(1);
  });
});

describe("A2AServer + throttle: identity cycling 缓解", () => {
  it("keys anonymous requests by remoteAddress so rotated identities share a bucket", async () => {
    let seq = 0;
    const cycling: AuthVerifier = {
      name: "cycling-anon",
      verify: () => ({ authenticated: true, identity: `anon-${++seq}` }),
    };
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      unverifiedIdentityScale: 1,
      tiers: {
        T0: {
          identityRequestsPerWindow: 2,
          domainRequestsPerWindow: 2,
          maxConcurrentTasks: 2,
          malformedBudget: 100,
          retryAfterSeconds: 6,
        },
      },
    });
    const { a2aUrl } = await startServer({ throttle, authVerifier: cycling });

    // 三个请求各自携带新身份；但未验签 → 统一按 remoteAddress（127.0.0.1）计数。
    for (let i = 1; i <= 2; i++) {
      const res = await rpc(
        a2aUrl,
        "message/send",
        { message: knpMessage(makeEnvelope(`cyc_${i}`)) },
        `cyc-${i}`,
      );
      expect(res.status).toBe(200);
    }
    const res3 = await rpc(
      a2aUrl,
      "message/send",
      { message: knpMessage(makeEnvelope("cyc_3")) },
      "cyc-3",
    );
    const err3 = rpcError(res3.body);
    expect(errorData(err3).protocol_code).toBe("rate_limited");
    expect(errorData(err3).retry_after).toBe(6);
  });
});
