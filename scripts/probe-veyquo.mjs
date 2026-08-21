#!/usr/bin/env node
/**
 * Probe: spawn kiwi-buyer-mcp with --a2a-allow-private-ranges and drive RFQ
 * against Veyquo to verify end-to-end reachability + get the real quote.
 * Line-delimited JSON-RPC 2.0 over stdio.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(mkdtempSync(path.join(tmpdir(), "kiwi-probe-")), "state.sqlite");
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
    "buyer-agent:probe",
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
    }, 30000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "0.0.1" },
  });
  console.log("INIT:", JSON.stringify(init.result ?? init.error ?? init));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await sleep(300);

  const search = await call("tools/call", {
    name: "kiwi_search",
    arguments: { query: "保温杯" },
  });
  console.log("SEARCH:", JSON.stringify(search));

  const rfq = await call("tools/call", {
    name: "kiwi_request_quotes",
    arguments: {
      idempotency_key: "probe-rfq-0001",
      merchant_ids: ["mkt_veyquo_A0UPvj7XuYk"],
      intent: {
        intent_id: "intent-probe-0001",
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
      },
    },
  });
  console.log("RFQ:", JSON.stringify(rfq));
} catch (e) {
  console.error("PROBE FAILED:", e.message);
} finally {
  child.kill();
  await sleep(200);
}
