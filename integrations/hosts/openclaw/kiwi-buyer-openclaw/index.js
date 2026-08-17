/**
 * kiwi-buyer-openclaw —— OpenClaw 原生插件（战略 v2.5 §6.3 单核心多包装 / §6.8）。
 *
 * 复用 kiwi Buyer Core（与 kiwi-buyer-mcp 同一 buildBuyerService / buildKiwiTools，
 * 9 个高层工具）：本插件是薄适配器，把 kiwi_* 工具以 `kiwi_buyer_*` 前缀暴露给
 * OpenClaw（§6.8 命名空间隔离：Host→Kiwi Buyer，不管理商家本地运营）。
 *
 * 直接 import kiwi dist（相对路径），无运行时第三方依赖（peer openclaw optional）。
 * 工具 parameters 直接复用 kiwi 工具的 inputSchema（JSON Schema，SDK 原样透传）。
 */
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import os from "node:os";
import path from "node:path";
import { buildBuyerService } from "../../../../dist/buyer-core/build-service.js";
import { buildKiwiTools } from "../../../../dist/mcp/tools.js";
import { DEFAULT_DELEGATION_POLICY, DEFAULT_CATALOG_URL } from "../../../../dist/mcp/cli.js";

const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    catalogUrl: { type: "string" },
    a2aSkipDnsCheck: { type: "boolean" },
    dbPath: { type: "string" },
    principal: { type: "string" },
    buyerAgentId: { type: "string" },
  },
};

/** §6.8：write 工具 optional（OpenClaw 允许省略/白名单化）。 */
const WRITE_TOOLS = new Set([
  "request_quotes",
  "negotiate",
  "accept_agreement",
  "handoff",
  "approve",
  "reject",
]);

const TOOLS = [
  "search",
  "request_quotes",
  "get_task",
  "negotiate",
  "accept_agreement",
  "get_agreement",
  "handoff",
  "approve",
  "reject",
];

/** 加载时仅用于提取工具元数据（description/inputSchema）的临时 service。 */
const META_SERVICE = buildBuyerService({
  dbPath: ":memory:",
  principal: "meta",
  buyerAgentId: "meta",
  sessionId: "meta",
  policy: { ...DEFAULT_DELEGATION_POLICY, principal: "meta" },
  catalogUrl: DEFAULT_CATALOG_URL,
});
const META_TOOLS = buildKiwiTools(META_SERVICE);

const TOOL_SPECS = TOOLS.map((short) => {
  const kiwiName = `kiwi_${short}`;
  const meta = META_TOOLS.find((t) => t.name === kiwiName);
  if (meta === undefined) throw new Error(`kiwi-buyer-openclaw: missing tool ${kiwiName}`);
  return {
    openclawName: `kiwi_buyer_${short}`,
    kiwiName,
    description: meta.description,
    parameters: meta.inputSchema,
    optional: WRITE_TOOLS.has(short),
  };
});

let cachedTools = null;

/** lazy 构建 Buyer Core（配置来自 OpenClaw pluginConfig；首次调用后缓存）。 */
function resolveTools(config) {
  if (cachedTools !== null) return cachedTools;
  const catalogUrl = config?.catalogUrl || DEFAULT_CATALOG_URL;
  const principal = config?.principal || "openclaw:user";
  const buyerAgentId = config?.buyerAgentId || "buyer-agent:openclaw";
  const dbPath = config?.dbPath || path.join(os.homedir(), ".kiwi", "openclaw.sqlite");
  const service = buildBuyerService({
    dbPath,
    principal,
    buyerAgentId,
    sessionId: `openclaw-${process.pid}`,
    policy: { ...DEFAULT_DELEGATION_POLICY, principal },
    catalogUrl,
    ...(config?.a2aSkipDnsCheck === true ? { a2aSkipDnsCheck: true } : {}),
  });
  cachedTools = buildKiwiTools(service);
  return cachedTools;
}

export default defineToolPlugin({
  id: "kiwi-buyer-openclaw",
  name: "Kiwi Buyer Plugin",
  description:
    "Expose kiwi buyer core sourcing & negotiation tools (catalog discovery → A2A direct merchant → RFQ → negotiate → approval → handoff) to OpenClaw.",
  configSchema: CONFIG_SCHEMA,
  tools: (tool) =>
    TOOL_SPECS.map((spec) =>
      tool({
        name: spec.openclawName,
        label: spec.openclawName,
        description: spec.description,
        parameters: spec.parameters,
        optional: spec.optional,
        async execute(params, config, context) {
          context?.signal?.throwIfAborted?.();
          const tools = resolveTools(config);
          const target = tools.find((t) => t.name === spec.kiwiName);
          if (target === undefined) {
            return { ok: false, error: `kiwi tool ${spec.kiwiName} unavailable` };
          }
          const result = await target.handle(params || {});
          const text = result?.content?.[0]?.text ?? JSON.stringify(result);
          if (result?.isError === true) return { ok: false, error: text };
          return text;
        },
      }),
    ),
});
