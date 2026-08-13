#!/usr/bin/env node
/**
 * TCK SUT 启动器（issue 10）：启动 Kiwi merchant A2A server 并常驻，
 * 供官方 a2a-tck `run_tck.py --sut-host <url>` 探测。Ctrl+C 退出。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { A2AServer } from "../../dist/a2a/server/index.js";
import { createMerchantHandler } from "../../dist/a2a/server/merchant-handler.js";
import { LedgerStore } from "../../dist/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../dist/negotiation/idempotency/index.js";
import { createTckReferenceResponder } from "./tck-reference-responder.mjs";

const NOW = () => new Date().toISOString();
const dir = mkdtempSync(path.join(tmpdir(), "kiwi-tck-sut-"));
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
        return { price: 8999, currency: "CNY", title: "iPhone 17", stock: 120 };
      }
      throw new Error(`unknown sku ${sku}`);
    },
  },
});
const server = new A2AServer({
  card: () => ({
    name: "Kiwi TCK Merchant",
    description: "A2A 1.0 conformance merchant",
    providerOrganization: "Kiwi Test Org",
    version: "1.0.0",
    baseUrl: holder.baseUrl,
    a2aPath: "/",
  }),
  ledger,
  idempotency,
  handler,
  // issue 10：TCK 参考场景（messageId 前缀路由），非产品默认回显。
  genericResponder: createTckReferenceResponder(),
});
const httpServer = server.createServer();
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${httpServer.address().port}`;
holder.baseUrl = url;
console.log(`SUT_URL=${url}`);
console.log(`card=${url}/.well-known/agent-card.json`);
console.log("Ctrl+C to stop");
process.on("SIGINT", async () => {
  httpServer.closeAllConnections?.();
  await new Promise((r) => httpServer.close(r));
  process.exit(0);
});
// 保持进程常驻。
await new Promise(() => {});
