/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * 买家会话密钥的所有权契约（buyer-core/open-inquiry-signer）。
 *
 * 商家侧任务所有权绑定在自证会话公钥上，所以：
 *   - 不同 (principal, buyerAgentId) 必须拿到不同密钥（同机多买家不共用身份）；
 *   - 同一主体重启必须拿回同一密钥（否则读不回自己的旧任务）；
 *   - 并发首启绝不互相覆盖（linkSync 原子发布，输家读赢家）——用真实子进程竞速；
 *   - 恢复后同一主体能读自己的旧任务，他人不能；重放原样请求仍被拒。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";

import { loadOpenInquirySigner } from "../src/buyer-core/open-inquiry-signer.js";
import { A2A_SIGNING_KEY_FILE } from "../src/a2a/signing-key.js";
import { OPEN_INQUIRY_IDENTITY_PREFIX } from "../src/a2a/open-inquiry-identity.js";
import { A2AServer } from "../src/a2a/server/index.js";
import { echoHandler } from "../src/a2a/server/handler.js";
import { createA2aAuthVerifier } from "../src/a2a/node.js";
import { InquiryNonceStore } from "../src/a2a/inquiry-nonce-store.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import type { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
const scratch = (label: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `kiwi-signer-${label}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// 与实现同一派生：scope = sha256(JSON.stringify([principal, buyerAgentId]))。
const scopeDirOf = (dataDir: string, principal: string, buyerAgentId: string): string =>
  path.join(dataDir, "open-inquiry-sessions",
    createHash("sha256").update(JSON.stringify([principal, buyerAgentId])).digest("hex"));
const keyFileOf = (dataDir: string, principal: string, buyerAgentId: string): string =>
  path.join(scopeDirOf(dataDir, principal, buyerAgentId), A2A_SIGNING_KEY_FILE);
const selfCertifyingKeyid = (publicKeyRawBase64: string): string =>
  OPEN_INQUIRY_IDENTITY_PREFIX + Buffer.from(publicKeyRawBase64, "base64").toString("base64url");

describe("open-inquiry session key ownership", () => {
  it("不同 (principal, buyerAgentId) 密钥互异且重启稳定（keyid 与磁盘公钥自洽，权限 0600/0700）", () => {
    const dataDir = scratch("isolation");
    const a1 = loadOpenInquirySigner(dataDir, "principal-A", "buyer-1");
    const a2 = loadOpenInquirySigner(dataDir, "principal-A", "buyer-2");
    const b1 = loadOpenInquirySigner(dataDir, "principal-B", "buyer-1");
    const ids = [a1, a2, b1].map((signer) => signer.keyid);
    expect(new Set(ids).size).toBe(3);
    for (const keyid of ids) {
      expect(keyid.startsWith(OPEN_INQUIRY_IDENTITY_PREFIX)).toBe(true);
      expect(Buffer.from(keyid.slice(OPEN_INQUIRY_IDENTITY_PREFIX.length), "base64url").length).toBe(32);
    }
    // 同一主体重复加载：同 keyid、密钥文件字节不变。
    const before = readFileSync(keyFileOf(dataDir, "principal-A", "buyer-1"));
    expect(loadOpenInquirySigner(dataDir, "principal-A", "buyer-1").keyid).toBe(ids[0]);
    expect(Buffer.compare(before, readFileSync(keyFileOf(dataDir, "principal-A", "buyer-1")))).toBe(0);
    // keyid = 前缀 + 磁盘公钥（raw 32B）的 base64url：身份完全由密钥字节决定。
    const stored = JSON.parse(readFileSync(keyFileOf(dataDir, "principal-A", "buyer-1"), "utf8")) as { publicKeyRaw: string };
    expect(ids[0]).toBe(selfCertifyingKeyid(stored.publicKeyRaw));
    // 空主体也有独立且确定的桶；密钥文件/目录权限最小化。
    expect(loadOpenInquirySigner(dataDir, "", "").keyid)
      .toBe(loadOpenInquirySigner(dataDir, "", "").keyid);
    expect(statSync(keyFileOf(dataDir, "principal-A", "buyer-1")).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(keyFileOf(dataDir, "principal-A", "buyer-1"))).mode & 0o777).toBe(0o700);
  });

  it("并发首启：8 个真实子进程竞速后全部拿到同一密钥，无覆盖、无临时文件残留", async () => {
    const work = scratch("concurrent");
    const dataDir = path.join(work, "state");
    const startFlag = path.join(work, "start.flag");
    // 夹具入口：等 start.flag 后同时调用，保证 8 个进程真正重叠在首启窗口。
    const entry = `
import { existsSync } from "node:fs";
const [startFile, dataDir, principal, buyerAgentId] = process.argv.slice(2);
while (!existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 1));
const { loadOpenInquirySigner } = await import(${JSON.stringify(
      new URL("../src/buyer-core/open-inquiry-signer.ts", import.meta.url).pathname,
    )});
process.stdout.write(loadOpenInquirySigner(dataDir, principal, buyerAgentId).keyid);
`;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(work, "fixture-entry.mjs"), entry);
    await build({
      entryPoints: [path.join(work, "fixture-entry.mjs")],
      outfile: path.join(work, "fixture.mjs"),
      bundle: true, format: "esm", platform: "node", target: "node22",
      sourcemap: false, logLevel: "silent",
    });
    const args = [startFlag, dataDir, "principal-C", "buyer-race"];
    const children = Array.from({ length: 8 }, () =>
      spawn(process.execPath, [path.join(work, "fixture.mjs"), ...args],
        { stdio: ["ignore", "pipe", "pipe"] }));
    const exited = new Promise<void>((resolve, reject) => {
      let pending = children.length;
      for (const child of children) {
        child.on("close", () => { pending -= 1; if (pending === 0) resolve(); });
        child.on("error", reject);
      }
    });
    writeFileSync(startFlag, "go"); // 全部子进程就位后才放行，真正竞速。
    const outputs = await Promise.all(children.map((child) => new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`)));
    })));
    await exited;
    expect(new Set(outputs).size).toBe(1);
    const stored = JSON.parse(readFileSync(keyFileOf(dataDir, "principal-C", "buyer-race"), "utf8")) as { publicKeyRaw: string };
    expect(outputs[0]).toBe(selfCertifyingKeyid(stored.publicKeyRaw));
    expect(readdirSync(path.dirname(keyFileOf(dataDir, "principal-C", "buyer-race")))
      .filter((name) => name.startsWith(".signing-"))).toEqual([]);
    expect(loadOpenInquirySigner(dataDir, "principal-C", "buyer-race").keyid).toBe(outputs[0]);
  }, 60_000);

  it("重启恢复：真实 A2A 服务上同一主体读回旧任务，他人不能，重放被拒", async () => {
    const dir = scratch("recovery");
    const buyerState = path.join(dir, "buyer-state");
    const origin = "https://merchant.example";
    const nonces = new InquiryNonceStore(dir);
    const server = new A2AServer({
      card: () => ({ name: "Shop", description: "t", providerOrganization: "t",
        version: "1.0.0", baseUrl: origin, a2aPath: "/a2a" }),
      ledger: new LedgerStore({ dir: path.join(dir, "ledger") }),
      idempotency: new IdempotencyStore({ dir: path.join(dir, "idem") }),
      handler: echoHandler(),
      authVerifier: createA2aAuthVerifier({ mode: "signature", signingKeyDir: dir, signingKeyId: origin,
        advertisedBase: origin, authoritySource: "declared", openInquiryNonceStore: nonces }),
    });
    const httpServer = server.createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/a2a`;
    const rpc = async (signer: OpenInquirySessionSigner, method: string, params: unknown) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
      const headers = { "content-type": "application/json", "a2a-version": "1.0",
        ...signer.sign({ method: "POST", url: `${origin}/a2a`, body, headers: {} }) };
      const response = await fetch(address, { method: "POST", body, headers });
      return { status: response.status, body: await response.json() as Record<string, unknown>, rawBody: body, headers };
    };
    try {
      const first = loadOpenInquirySigner(buyerState, "principal-A", "buyer-1");
      const created = await rpc(first, "SendMessage",
        { message: { role: "ROLE_USER", parts: [{ text: "quote" }], messageId: "recover-1" } });
      expect(created.status).toBe(200);
      const taskId = (created.body.result as { task: { id: string } }).task.id;
      expect(typeof taskId).toBe("string");

      // “重启”：从同一 state 目录重新加载，必须拿回同一身份并读回旧任务。
      const restarted = loadOpenInquirySigner(buyerState, "principal-A", "buyer-1");
      expect(restarted.keyid).toBe(first.keyid);
      const own = await rpc(restarted, "GetTask", { id: taskId });
      expect(own.status).toBe(200);
      expect(JSON.stringify(own.body)).toContain(taskId);
      // 不同主体（不同 principal 或不同 buyerAgentId）不能读该任务。
      for (const [principal, buyerAgentId] of [["principal-B", "buyer-1"], ["principal-A", "buyer-2"]] as const) {
        const foreign = await rpc(loadOpenInquirySigner(buyerState, principal, buyerAgentId), "GetTask", { id: taskId });
        expect((foreign.body.error as { code: number } | undefined)?.code).toBe(-32001);
      }
      // 原样重放同一签名请求：nonce 防重放拒绝。
      const replay = await fetch(address, { method: "POST", body: created.rawBody, headers: created.headers });
      expect(replay.status).toBe(403);
    } finally {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      nonces.close();
    }
  });
});
