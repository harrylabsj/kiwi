import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { registerOpenClawPlugin } from './openclaw_compat.js';

const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectRoot: { type: 'string' },
    dbPath: { type: 'string' },
    allowedRoot: { type: 'string' },
    pythonPath: { type: 'string' },
    trustedWrites: { type: 'boolean', default: false },
  },
};

const WRITE_TOOL_NAMES = new Set([
  'wsa_record_feedback',
  'wsa_confirm_relationship_candidate',
  'wsa_record_ocr_review',
]);

function capturedToolSpecs(api, forceWrites = false) {
  const specs = [];
  const captureApi = {
    ...api,
    pluginConfig: forceWrites ? { ...(api?.pluginConfig || {}), trustedWrites: true } : api?.pluginConfig,
    registerTool(spec) {
      specs.push(spec);
    },
    registerCommand() {},
  };
  registerOpenClawPlugin(captureApi);
  return specs;
}

const STATIC_TOOL_SPECS = capturedToolSpecs({ pluginConfig: {} }, true);

const entry = defineToolPlugin({
  id: 'wechat-social-assistant',
  name: 'WeChat Social Assistant',
  description: 'OpenClaw native bridge to the local-first WeChat Social Assistant MCP server.',
  configSchema: CONFIG_SCHEMA,
  tools: (tool) => STATIC_TOOL_SPECS.map((spec) => tool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    optional: WRITE_TOOL_NAMES.has(spec.name),
    factory: ({ api }) => capturedToolSpecs(api).find((candidate) => candidate.name === spec.name) || null,
  })),
});

const registerTools = entry.register.bind(entry);
entry.register = (api) => {
  registerTools(api);
  registerOpenClawPlugin({
    ...api,
    registerTool() {},
  });
};

export default entry;
