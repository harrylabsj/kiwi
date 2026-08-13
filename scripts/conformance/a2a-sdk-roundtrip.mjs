#!/usr/bin/env node
/**
 * A2A 1.0 互操作（issue 10 / P0 §5.1）：
 * `@a2a-js/sdk`（官方独立 SDK，非 Kiwi 实现）↔ Kiwi merchant server 往返。
 *
 * 产出：
 * - 断言 SDK 拉取 Agent Card（1.0 声明）+ SendMessage 拿到 task 往返；
 * - 保存 wire transcript 到 `docs/reviews/a2a-sdk-conformance-transcript-<ts>.jsonl`；
 * - 退出码 0/1（可接 CI）。
 *
 * 不 import Kiwi runtime 的 SDK 侧逻辑；Kiwi 只提供被互操作的 server。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClientFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { A2AServer } from "../../dist/a2a/server/index.js";
import { createMerchantHandler } from "../../dist/a2a/server/merchant-handler.js";
import { LedgerStore } from "../../dist/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../dist/negotiation/idempotency/index.js";
import { finalizeEnvelope } from "../../dist/negotiation/domain/envelope.js";

const OUT_DIR = "docs/reviews";
const NOW = () => new Date().toISOString();

/** 启动 Kiwi merchant A2A server（1.0）。 */
async function startKiwiMerchant() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-conformance-"));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const handler = createMerchantHandler({
    ledger,
    now: NOW,
    sender: "merchant:veyquo",
    counterparty: "buyer:*",
    productSource: {
      getProduct: async (sku) => {
        if (sku === "VQ-003") {
          return { price: 8999, currency: "CNY", title: "iPhone 17", stock: 120, handoff_destination: "https://veyquo.example/checkout" };
        }
        throw new Error(`unknown sku ${sku}`);
      },
    },
  });
  const server = new A2AServer({
    card: () => ({
      name: "Kiwi Conformance Merchant",
      description: "A2A 1.0 conformance merchant",
      providerOrganization: "Kiwi Test Org",
      version: "1.0.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    handler,
  });
  const httpServer = server.createServer();
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  const url = `http://127.0.0.1:${addr.port}`;
  holder.baseUrl = url;
  return { url, httpServer, dir };
}

/** 包装 fetch 捕获 wire（请求/响应），供 transcript。 */
function captureFetch(records) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const entry = { ts: NOW(), url: String(url), method: init?.method ?? "GET" };
    if (init?.headers) entry.headers = init.headers;
    if (init?.body) entry.body = String(init.body);
    records.push(entry);
    const res = await orig(url, init);
    records.push({ ts: NOW(), responseStatus: res.status, url: String(url) });
    return res;
  };
  return () => {
    globalThis.fetch = orig;
  };
}

async function main() {
  const records = [];
  const restoreFetch = captureFetch(records);
  let server;
  try {
    server = await startKiwiMerchant();

    // 构造合法 KNP RFQ envelope（Kiwi envelope builder 生成 digest）。
    const envelope = finalizeEnvelope({
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
      negotiation_id: "neg_conformance_1",
      exchange_id: "ex_conformance_1",
      message_id: "msg_conformance_1",
      in_reply_to: "msg_start",
      actor: "buyer",
      action: "rfq",
      created_at: NOW(),
      payload: {
        type: "rfq",
        items: [{ sku: "VQ-003", quantity: { value: 1, unit: "piece" } }],
        requested_terms: { delivery_before: "2026-08-20T18:00:00Z" },
      },
    });

    // 官方 SDK：拉 Card + SendMessage（独立于 Kiwi runtime）。
    // SDK 是 protobuf 派生：role 用 Role 枚举、Part 用 oneof content。
    const factory = new ClientFactory();
    const client = await factory.createFromUrl(server.url);
    const message = {
      messageId: envelope.message_id,
      role: Role.ROLE_USER,
      parts: [
        { content: { $case: "text", value: "RFQ: 1x VQ-003" } },
        { content: { $case: "data", value: { knp_envelope: envelope } } },
      ],
    };
    const result = await client.sendMessage({ message });

    // SDK 1.0 client 返回 raw Task（state 是 TaskState 枚举数字；2 = TASK_STATE_COMPLETED）。
    if (typeof result?.id !== "string" || result.id === "") {
      throw new Error(`expected task result, got ${JSON.stringify(result).slice(0, 300)}`);
    }
    if (result.status?.state !== 2) {
      throw new Error(`expected TASK_STATE_COMPLETED(2), got ${result.status?.state}`);
    }

    // 保存 transcript（稳定路径，覆盖写，可提交作 CI 证据）。
    const outPath = path.join(OUT_DIR, "a2a-sdk-conformance-transcript.jsonl");
    writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    console.log(`[conformance] @a2a-js/sdk ↔ Kiwi merchant round-trip OK`);
    console.log(`[conformance] task id=${result.id} state=${result.status.state}`);
    console.log(`[conformance] transcript saved: ${outPath}`);
    return 0;
  } finally {
    restoreFetch();
    if (server) {
      server.httpServer.closeAllConnections?.();
      await new Promise((r) => server.httpServer.close(r));
      await server.httpServer.closeAllConnections?.();
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[conformance] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
