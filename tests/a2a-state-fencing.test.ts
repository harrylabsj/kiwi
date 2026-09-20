/**
 * T023（多副本/代次争写）+ T024（密钥与 task 恢复）——M2 状态与并发门。
 *
 * 现状与边界（如实记录，不外推）：
 *   - **单写者**：同一状态目录只允许一个实例（owner.lock = 独占文件 + PID），
 *     第二个实例启动即失败——这是磁盘路径下的 fancing 手段；
 *   - **代次 fencing**：绑定/挑战/声明层按 generation 拒绝异代次（见 cloud-binding 测试）；
 *   - **重启恢复**：签名身份跨重启不变；任务视图可从 Ledger 按 (task_id, 归属)
 *     恢复，重启后仍只对本人可见；
 *   - 完整 CAS/outbox（多实例共享权威存储）属存储适配（路径 B）范围，本文件不声称已具备。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createA2aNodeCore, createA2aAuthVerifier } from "../src/a2a/node.js";
import { loadOrCreateA2aSigningIdentity } from "../src/a2a/signing-key.js";
import { verifyCompactJws, signCompactJws } from "../src/trust/identity/jws.js";
import { toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import { createPublicKey } from "node:crypto";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { validEnvelopeFields } from "./negotiation-helpers.js";

function envelopeFor(messageId: string): NegotiationEnvelope {
  return finalizeEnvelope({ ...validEnvelopeFields(), message_id: messageId });
}
import type { AgentProfile } from "../src/config/profile.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function merchantProfile(): AgentProfile {
  return {
    runtime_version: "0.6.0",
    protocol_version: "shopping.negotiation/0.1",
    agent_id: "merchant-agent:merchant-fence-001",
    role: "merchant",
    owner_id: "merchant-fence-001",
    commerce: { base_url: "http://127.0.0.1:1", token_env: "KIWI_TEST_TOKEN", backend: "local_marketplace" },
    model: { provider: "fake", model: "fake-merchant-model" },
    runtime: { mode: "once", poll_interval_seconds: 5, turn_timeout_seconds: 90, max_model_steps: 4, max_retries: 2 },
    merchant_policy: { min_unit_price_private: 80, max_auto_discount_percent: 10 },
  } as unknown as AgentProfile;
}

describe("T023：状态目录单写者 fencing", () => {
  it("同一状态目录第二个实例启动即失败（单写者）", () => {
    const dataDir = tempDir("kiwi-fence-");
    const profile = merchantProfile();
    const authVerifier = createA2aAuthVerifier({
      mode: "bearer",
      bearerToken: "t",
      signingKeyDir: dataDir,
      signingKeyId: "https://fence.example",
      advertisedBase: "https://fence.example",
    });
    const first = createA2aNodeCore({
      profile,
      advertisedBase: "https://fence.example",
      a2aPath: "/a2a",
      dataDir,
      authVerifier,
    });
    cleanups.push(() => first.close());
    // 第二个实例（模拟"旧代次仍在跑 / 双副本"）必须启动失败，而不是两个写者并存。
    expect(() =>
      createA2aNodeCore({
        profile,
        advertisedBase: "https://fence.example",
        a2aPath: "/a2a",
        dataDir,
        authVerifier,
      }),
    ).toThrowError(/已被其他进程占用/);
  });
});

describe("T024：重启后的身份与任务恢复", () => {
  it("签名身份跨重启不变（同一状态目录 → 同一把钥匙）", () => {
    const dir = tempDir("kiwi-identity-");
    const first = loadOrCreateA2aSigningIdentity(dir, "https://runtime.example");
    const second = loadOrCreateA2aSigningIdentity(dir, "https://runtime.example");
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
    expect(second.keyid).toBe("https://runtime.example");
  });

  it("重启前后同一身份的签名可被同一公钥验证（密钥未重生即可继续接待）", () => {
    const dir = tempDir("kiwi-identity-sign-");
    const before = loadOrCreateA2aSigningIdentity(dir, "https://runtime.example");
    const proofBefore = signCompactJws({ hello: "before-restart" }, toJwsSigningIdentity(before));
    // 重启：重新加载同一目录
    const after = loadOrCreateA2aSigningIdentity(dir, "https://runtime.example");
    const publicKey = createPublicKey(after.publicKeyPem);
    expect(verifyCompactJws(proofBefore, publicKey).payload.toString("utf8")).toContain("before-restart");
    // 重启后新签的证明，用重启前的公钥同样可验（同一身份）
    const proofAfter = signCompactJws({ hello: "after-restart" }, toJwsSigningIdentity(after));
    expect(
      verifyCompactJws(proofAfter, createPublicKey(before.publicKeyPem)).payload.toString("utf8"),
    ).toContain("after-restart");
  });

  it("重启后任务仍按归属可见：同一 Ledger 目录起新实例，本人可查、他人/匿名不可查", async () => {
    const { LedgerStore } = await import("../src/negotiation/ledger/index.js");
    const { IdempotencyStore } = await import("../src/negotiation/idempotency/index.js");
    const { A2AServer, StaticBearerAuthVerifier } = await import("../src/a2a/server/index.js");
    const { echoHandler } = await import("../src/a2a/server/handler.js");
    const { createServer } = await import("node:http");
    const dir = tempDir("kiwi-task-restart-");
    const ledgerDir = path.join(dir, "a2a");

    const startServer = async (identity: string) => {
      const server = new A2AServer({
        card: () => ({
          name: "Restart merchant",
          description: "t024",
          providerOrganization: "Kiwi Test",
          version: "1.0.0",
          baseUrl: "http://127.0.0.1",
          a2aPath: "/a2a",
        }),
        ledger: new LedgerStore({ dir: ledgerDir, now: () => new Date().toISOString() }),
        idempotency: new IdempotencyStore({ dir: path.join(dir, "idem"), now: () => new Date().toISOString() }),
        handler: echoHandler(),
        authVerifier: new StaticBearerAuthVerifier("t", { identity }),
      });
      const httpServer = createServer(server.handler());
      cleanups.push(() => {
        httpServer.closeAllConnections();
        httpServer.close();
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return `http://127.0.0.1:${port}`;
    };

    const call = async (base: string, method: string, params: unknown, token = "t") => {
      const res = await fetch(`${base}/a2a`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: "x", method, params }),
      });
      return (await res.json()) as Record<string, unknown>;
    };

    // 第一个实例：发出消息 → 落账（内存 task 随之存在）。
    const before = await startServer("buyer:one");
    const sent = await call(before, "message/send", {
      message: {
        role: "user",
        parts: [{ kind: "data", data: { knp_envelope: envelopeFor("msg_restart_001") } }],
        messageId: "msg_restart_001",
      },
    });
    const taskId = String(
      (sent["result"] as { task?: { id?: string } } | undefined)?.task?.id ?? "",
    );
    expect(taskId).not.toBe("");

    // 重启：新实例、同一 Ledger 目录（内存任务为空 → 走 Ledger 恢复路径）。
    const after = await startServer("buyer:one");
    const mine = await call(after, "tasks/get", { id: taskId });
    expect(JSON.stringify(mine)).toContain(taskId);

    // 他人身份的新实例：同一 Ledger，但归属不符 → 不可见。
    const other = await startServer("buyer:two");
    const theirs = await call(other, "tasks/get", { id: taskId });
    expect(JSON.stringify(theirs)).not.toContain(`"id":"${taskId}"`);
    expect(theirs["result"]).toBeUndefined();
  });
});
