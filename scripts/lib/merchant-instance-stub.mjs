#!/usr/bin/env node
/**
 * 商家自托管 MCP 实例的最小桩（跨仓联调验收用，不对外发布）。
 *
 * 只实现第 1 版路由验收需要的 JSON-RPC：initialize / tools/list / tools/call。
 * 用 `KIWI_INSTANCE_STUB_TOKEN` 校验入站 Bearer——联调要证明「网关带的是该商家
 * 自己的内部凭据」，而不是任何共享密钥。
 *
 *   node scripts/lib/merchant-instance-stub.mjs --port 18622 [--merchant-label A]
 *
 * 输出的每一行是 `stub_request <json>`，供验收脚本统计调用次数（隔离判定）。
 */

import { createServer } from "node:http";
import process from "node:process";

const args = process.argv.slice(2);
let port = 18622;
let label = "A";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") port = Number(args[++i]);
  else if (args[i] === "--merchant-label") label = String(args[++i]);
}
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
    const authorization = String(req.headers.authorization ?? "");
    if (authorization !== `Bearer ${token}`) {
      // 网关必须带该商家自己的内部凭据；错凭据一律 401。
      process.stdout.write(`stub_rejected ${JSON.stringify({ label, authorization: authorization.slice(0, 12) })}\n`);
      reply(res, 401, { error: "unauthorized" });
      return;
    }
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
