#!/usr/bin/env node
/**
 * 商家自托管 MCP 实例的最小桩（跨仓联调验收用，不对外发布）。
 *
 * 只实现第 1 版路由验收需要的 JSON-RPC：initialize / tools/list / tools/call。
 * 用 `KIWI_INSTANCE_STUB_TOKEN` 校验入站 Bearer——联调要证明「网关带的是该商家
 * 自己的内部凭据」，而不是任何共享密钥。
 *
 *   node scripts/lib/merchant-instance-stub.mjs --port 18622 [--merchant-label A]
 *     [--pairing-dir <dir> --pairing-credential <token>]
 *
 * 输出的每一行是 `stub_request <json>`，供验收脚本统计调用次数（隔离判定）。
 *
 * 配对兑换：提供 `--pairing-dir` 时挂载 `POST /pairing/redeem`，直接复用 kiwi 的
 * 真实实现（dist/auth/merchant-pairing.js）——验收脚本用真实 CLI 生成配对码，
 * 桩按同一份 `pairing.json` 语义兑换（单次、TTL、只存摘要），并按最小授权原则
 * **新签发**一份配对凭据返回给网关；`/mcp` 同时接受静态令牌与该配对凭据，
 * 每次调用打印用的是哪一种（`stub_credential`），供验收断言「绑定后网关用的是
 * 配对凭据而不是静态令牌」。
 */

import { createServer } from "node:http";
import process from "node:process";

const args = process.argv.slice(2);
let port = 18622;
let label = "A";
let pairingDir = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") port = Number(args[++i]);
  else if (args[i] === "--merchant-label") label = String(args[++i]);
  else if (args[i] === "--pairing-dir") pairingDir = String(args[++i]);
}

const pairingModule =
  pairingDir === "" ? undefined : await import("../../dist/auth/merchant-pairing.js");
const redeemPairingCode = pairingModule?.redeemPairingCode;
const issuePairedCredential = pairingModule?.issuePairedCredential;
const matchesPairedCredential = pairingModule?.matchesPairedCredential;
const token = (process.env.KIWI_INSTANCE_STUB_TOKEN ?? "").trim();
if (token === "") {
  process.stderr.write("KIWI_INSTANCE_STUB_TOKEN is required\n");
  process.exit(2);
}

const TOOLS = [
  {
    name: "kiwi_merchant_list_products",
    description: "列出商家自己的目录商品（桩：固定返回一件商品）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kiwi_merchant_prepare_product_change",
    description: "为商品变更生成审批候选（桩：只回候选元数据）",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string" }, changes: { type: "object" } },
      required: ["sku", "changes"],
      additionalProperties: false,
    },
  },
];

function reply(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function handle(rpc) {
  const id = rpc?.id ?? null;
  switch (rpc?.method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `merchant-instance-stub-${label}`, version: "0.0.0" } } };
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = rpc?.params?.name;
      if (name === "kiwi_merchant_list_products") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ instance: label, products: [{ sku: `stub-${label}-1`, title: `桩商品 ${label}`, stock: 7 }] }) }],
          },
        };
      }
      if (name === "kiwi_merchant_prepare_product_change") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ instance: label, candidate_id: `cand-${label}-1`, status: "pending_approval" }) }],
          },
        };
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${String(name)}` } };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(rpc?.method)}` } };
  }
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== "POST") {
      reply(res, 405, { error: "method_not_allowed" });
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/pairing/redeem") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let code = "";
      try {
        code = String(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").code ?? "");
      } catch {
        code = "";
      }
      process.stdout.write(`stub_request ${JSON.stringify({ label, method: "pairing/redeem" })}\n`);
      if (redeemPairingCode === undefined || !redeemPairingCode(pairingDir, code)) {
        reply(res, 403, { ok: false, message: "配对码无效或已过期" });
        return;
      }
      // 最小授权：凭据由实例侧新签（覆盖旧的），网关只拿到调用凭据。
      const issued = issuePairedCredential(pairingDir);
      process.stderr.write(`stub_issued_paired_credential ${JSON.stringify({ label })}\n`);
      reply(res, 200, {
        ok: true,
        instance: { owner_id: `stub-owner-${label}`, principal_id: `stub-instance-${label}` },
        server_info: { name: `merchant-instance-stub-${label}`, version: "0.0.0-stub" },
        credential: issued.credential,
      });
      return;
    }
    const authorization = String(req.headers.authorization ?? "");
    const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const isStatic = presented !== "" && presented === token;
    const isPaired =
      presented !== "" &&
      matchesPairedCredential !== undefined &&
      matchesPairedCredential(pairingDir, presented);
    if (!isStatic && !isPaired) {
      // 网关必须带该商家自己的内部凭据；错凭据一律 401（不回显凭据内容）。
      process.stdout.write(`stub_rejected ${JSON.stringify({ label })}\n`);
      reply(res, 401, { error: "unauthorized" });
      return;
    }
    process.stdout.write(
      `stub_credential ${JSON.stringify({ label, kind: isPaired ? "paired" : "static" })}\n`,
    );
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let rpc;
    try {
      rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      reply(res, 400, { error: "invalid_json" });
      return;
    }
    process.stdout.write(`stub_request ${JSON.stringify({ label, method: rpc?.method, tool: rpc?.params?.name ?? "" })}\n`);
    const response = handle(rpc);
    if (response === undefined) {
      reply(res, 202, undefined);
      return;
    }
    reply(res, 200, response);
  })().catch((err) => {
    process.stderr.write(`stub error: ${err instanceof Error ? err.message : String(err)}\n`);
    reply(res, 500, { error: "internal_error" });
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`stub_listening ${JSON.stringify({ label, port })}\n`);
});
