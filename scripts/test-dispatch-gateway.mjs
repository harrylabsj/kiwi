#!/usr/bin/env node
/**
 * 本地评测终态测试网关（验收/演示）。
 * 用法：node scripts/test-dispatch-gateway.mjs [--port 8790]
 * 仅证明本网关控制的 dispatch 不再执行，不代表模型供应商保证。
 */
import { createTestDispatchGateway } from "../dist/merchant-core/learning/test-dispatch-gateway.js";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8790;
const gateway = createTestDispatchGateway();
const actual = await gateway.listen(port);
console.log(`test dispatch gateway listening on http://127.0.0.1:${actual}`);
console.log("GET  /evaluations/dispatches/:id?binding_digest=...");
console.log("POST /dispatch/:id/{complete|not-executed|execute}");
