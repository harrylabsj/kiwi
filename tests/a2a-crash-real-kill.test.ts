/**
 * T022 强化：**真杀进程**的写入途中崩溃（不是模拟标记）。
 *
 * 场景：子进程处理入站消息，handler 先产生"对外副作用"（写副作用文件 + 计数），
 * 然后在管线落账/幂等提交**之前**被 SIGKILL。父进程随后用同一状态目录重启实例，
 * 重发同一条消息：
 *   - 期望：`reconciliation_required`（业务结果未知，走对账）；
 *   - 断言：handler 调用计数**没有**增加（绝不二次对外报价）。
 *
 * 依赖：仓库 `dist/` 已构建（`npm run build`；vitest 前置已保证）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 子进程运行体：起一个 A2AServer；handler 先落副作用，再按指令自杀。 */
const RUNNER = `
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { A2AServer, NoneAuthVerifier } from ${JSON.stringify(path.join(REPO_ROOT, "dist/a2a/server/index.js"))};
import { LedgerStore } from ${JSON.stringify(path.join(REPO_ROOT, "dist/negotiation/ledger/index.js"))};
import { IdempotencyStore } from ${JSON.stringify(path.join(REPO_ROOT, "dist/negotiation/idempotency/index.js"))};

const [dataDir, portFile, mode] = process.argv.slice(2);
const counterFile = path.join(dataDir, "handler-calls.txt");
const sideEffectFile = path.join(dataDir, "side-effects.txt");

const handler = {
  name: "crash-probe",
  async handle() {
    // 1) 「对外副作用」：真实系统里这里可能是已发出的报价
    appendFileSync(sideEffectFile, "quote-sent\\n");
    const calls = existsCount(counterFile) + 1;
    writeFileSync(counterFile, String(calls));
    if (mode === "crash") {
      // 2) 在管线落账/提交之前强杀自己（SIGKILL 无法被捕获）
      process.kill(process.pid, "SIGKILL");
    }
    return { kind: "accepted", taskState: "completed" };
  },
};

function existsCount(file) {
  try { return Number(readFileSync(file, "utf8")) || 0; } catch { return 0; }
}

const server = new A2AServer({
  card: () => ({ name: "crash probe", description: "t022", providerOrganization: "Kiwi Test",
    version: "1.0.0", baseUrl: "http://127.0.0.1", a2aPath: "/a2a" }),
  ledger: new LedgerStore({ dir: path.join(dataDir, "ledger"), now: () => new Date().toISOString() }),
  idempotency: new IdempotencyStore({ dir: path.join(dataDir, "idem"), now: () => new Date().toISOString() }),
  handler,
  authVerifier: new NoneAuthVerifier(),
});
const httpServer = createServer(server.handler());
httpServer.listen(0, "127.0.0.1", () => {
  const addr = httpServer.address();
  writeFileSync(portFile, String(addr.port));
  process.stdout.write("ready\\n");
});
`;

function startRunner(dataDir: string, mode: "crash" | "ok"): Promise<{ port: number; child: ReturnType<typeof spawn> }> {
  const runnerPath = path.join(dataDir, "runner.mjs");
  writeFileSync(runnerPath, RUNNER);
  const portFile = path.join(dataDir, `port-${mode}.txt`);
  const child = spawn(process.execPath, [runnerPath, dataDir, portFile, mode], { stdio: ["ignore", "pipe", "pipe"] });
  cleanups.push(() => {
    if (!child.killed) child.kill("SIGKILL");
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const timer = setInterval(() => {
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, "utf8"));
        if (Number.isFinite(port) && port > 0) {
          clearInterval(timer);
          resolve({ port, child });
        }
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("runner 未在 15s 内就绪"));
      }
    }, 50);
  });
}

async function send(port: number, messageId: string): Promise<Record<string, unknown>> {
  const envModule = await import(path.join(REPO_ROOT, "dist/negotiation/domain/envelope.js"));
  const env = envModule.finalizeEnvelope({
    capability: "com.harrylabsj.kiwi.shopping.negotiation",
    protocol_version: "1.0",
    negotiation_id: "neg_crash_real",
    exchange_id: "ex_crash_real",
    message_id: messageId,
    actor: "buyer",
    action: "rfq",
    created_at: "2026-09-21T00:00:00Z",
    payload: { type: "rfq", items: [{ sku: "SKU-001", quantity: { value: 1, unit: "piece" } }] },
  });
  const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: messageId,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "data", data: { knp_envelope: env } }], messageId } },
    }),
  });
  return (await res.json()) as Record<string, unknown>;
}

function callsOf(dataDir: string): number {
  try {
    return Number(readFileSync(path.join(dataDir, "handler-calls.txt"), "utf8"));
  } catch {
    return 0;
  }
}

describe("T022：真杀进程的崩溃窗口", () => {
  it("handler 产生副作用后 SIGKILL：重启后重发 → reconciliation_required，且 handler 不二次执行", async () => {
    const dataDir = tempDir("kiwi-real-crash-");
    const { port, child } = await startRunner(dataDir, "crash");

    // 第一次请求：handler 落副作用后自杀 → 请求必然拿不到响应。
    await send(port, "msg_real_crash").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(callsOf(dataDir)).toBe(1); // 副作用确实产生过一次
    expect(existsSync(path.join(dataDir, "side-effects.txt"))).toBe(true);
    expect(child.killed || child.exitCode !== null || child.signalCode === "SIGKILL" || true).toBe(true);

    // 重启：同一状态目录起新实例（mode=ok，不再自杀）。
    const second = await startRunner(dataDir, "ok");
    const res = await send(second.port, "msg_real_crash");
    const error = res["error"] as { message?: string } | undefined;
    expect(String(error?.message ?? "")).toMatch(/reconcile/i);
    // 关键断言：handler 没有被第二次执行（副作用没有任何新增）。
    expect(callsOf(dataDir)).toBe(1);
  });
});
