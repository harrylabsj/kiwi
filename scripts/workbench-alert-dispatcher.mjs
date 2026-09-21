#!/usr/bin/env node

import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import {
  ExternalAlertDeliveryStore,
  ExternalAlertDeliveryWorker,
  probeRuntimeHealth,
} from "../dist/alerts/external-delivery.js";

const args = parseArgs(process.argv.slice(2));
if (args.db === undefined || args.webhook === undefined) {
  throw new Error("--db and --webhook are required");
}
const webhook = new URL(args.webhook);
if (
  webhook.protocol !== "https:" &&
  !["127.0.0.1", "localhost", "::1"].includes(webhook.hostname)
) {
  throw new Error("external alert webhook must use HTTPS unless it is loopback");
}
const token = args.tokenEnv === undefined ? undefined : process.env[args.tokenEnv];
if (args.tokenEnv !== undefined && (token === undefined || token === "")) {
  throw new Error(`alert webhook token env ${args.tokenEnv} is missing`);
}
let healthUrl;
if (args.healthUrl !== undefined) {
  if (args.merchant === undefined) throw new Error("--merchant is required with --health-url");
  healthUrl = new URL(args.healthUrl);
  if (
    healthUrl.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "::1"].includes(healthUrl.hostname)
  ) {
    throw new Error("health URL must use HTTPS unless it is loopback");
  }
}

const db = new DatabaseSync(args.db);
db.exec("pragma journal_mode=WAL; pragma busy_timeout=5000");
const store = new ExternalAlertDeliveryStore({ db });
const worker = new ExternalAlertDeliveryWorker(store, {
  workerId: `external-alert:${process.pid}`,
  send: async (payload) => {
    const response = await fetch(webhook, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`alert webhook returned HTTP ${response.status}`);
  },
});

let stopping = false;
process.once("SIGINT", () => (stopping = true));
process.once("SIGTERM", () => (stopping = true));
try {
  do {
    if (healthUrl !== undefined) {
      await probeRuntimeHealth(store, {
        merchantId: args.merchant,
        healthUrl,
      });
    }
    const result = await worker.runOnce();
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), result })}\n`);
    if (args.once === true) break;
    await delay(result === "idle" ? 5_000 : 250);
  } while (!stopping);
} finally {
  db.close();
}

function parseArgs(values) {
  const out = { once: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--once") {
      out.once = true;
      continue;
    }
    const next = values[index + 1];
    if (next === undefined) throw new Error(`${value} requires a value`);
    if (value === "--db") out.db = next;
    else if (value === "--webhook") out.webhook = next;
    else if (value === "--token-env") out.tokenEnv = next;
    else if (value === "--health-url") out.healthUrl = next;
    else if (value === "--merchant") out.merchant = next;
    else throw new Error(`unknown argument: ${value}`);
    index += 1;
  }
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
