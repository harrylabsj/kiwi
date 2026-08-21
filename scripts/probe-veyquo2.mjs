#!/usr/bin/env node
/**
 * Probe 2: RFQ (with target_unit_price constraint 8500 minor = ¥85) then
 * counter-offer via kiwi_negotiate, printing the merchant's real reply.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(mkdtempSync(path.join(tmpdir(), "kiwi-probe2-")), "state.sqlite");
const child = spawn(
  "node",
  [
    "/Users/<user>/coding/kiwi/dist/cli.js",
    "mcp",
    "serve",
    "--db",
    DB,
    "--principal",
    "probe:local",
    "--agent",
    "buyer-agent:probe2",
    "--a2a-allow-private-ranges",
    "true",
    "--a2a-timeout-ms",
    "20000",
  ],
  { stdio: ["pipe", "pipe", "pipe"], cwd: "/Users/<user>/coding/kiwi" }
);

let buf = "";
let nextId = 1;
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log("NON-JSON:", line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write("[mcp-stderr] " + d));

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout for ${method}`));
      }
    }, 40000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe2", version: "0.0.1" },
  });
  console.log("INIT:", JSON.stringify(init.result ?? init.error ?? init));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await sleep(300);

  const rfq = await call("tools/call", {
    name: "kiwi_request_quotes",
    arguments: {
      idempotency_key: "probe2-rfq-0001",
      merchant_ids: ["mkt_veyquo_A0UPvj7XuYk"],
      intent: {
        intent_id: "intent-probe2-0001",
        intent_type: "purchase",
        items: [
          {
            query: "保温杯",
            quantity: { value: 1, unit: "个" },
            budget: 85,
            currency: "CNY",
            notes: "预算85元以内，需要保温杯一个",
          },
        ],
        constraints: { target_unit_price: { currency: "CNY", amount_minor: 8500 } },
      },
    },
  });
  const rfqText = rfq.result.content[0].text;
  console.log("RFQ:", rfqText);
  const rfqParsed = JSON.parse(rfqText);
  const taskId = rfqParsed.task_id;
  const candidate = rfqParsed.task.candidates[0];
  console.log("CANDIDATE STATUS:", candidate.status, "price minor:", (JSON.parse(candidate.provenance.reply_text).payload.terms.items[0].unit_price.amount_minor));

  const neg = await call("tools/call", {
    name: "kiwi_negotiate",
    arguments: {
      task_id: taskId,
      action: "counter_offer",
      summary: "预算85元，希望单价降到85元以内（8500分）",
    },
  });
  console.log("NEGOTIATE:", JSON.stringify(neg));
} catch (e) {
  console.error("PROBE FAILED:", e.message);
} finally {
  child.kill();
  await sleep(200);
}
