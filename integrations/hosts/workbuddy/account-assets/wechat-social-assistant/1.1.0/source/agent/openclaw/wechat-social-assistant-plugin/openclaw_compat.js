import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const OPENCLAW_PLUGIN_ID = 'wechat-social-assistant';
const MCP_TIMEOUT_MS = 20000;
const MCP_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function truthy(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveConfig(api) {
  const nested = api?.config?.plugins?.entries?.[OPENCLAW_PLUGIN_ID]?.config || {};
  const direct = api?.pluginConfig || {};
  const config = { ...direct, ...nested };
  const projectRoot = path.resolve(nonEmptyString(config.projectRoot) || process.cwd());
  const configuredDbPath = nonEmptyString(config.dbPath);
  const dbPath = configuredDbPath ? path.resolve(projectRoot, configuredDbPath) : undefined;
  return {
    projectRoot,
    dbPath,
    allowedRoot: path.resolve(
      nonEmptyString(config.allowedRoot) ||
        (dbPath ? path.dirname(dbPath) : projectRoot),
    ),
    pythonPath: nonEmptyString(config.pythonPath) || 'python3',
    writesEnabled: truthy(config.trustedWrites),
  };
}

function validateProjectRoot(projectRoot) {
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Invalid WeChat Social Assistant projectRoot: ${projectRoot}`);
  }
  return projectRoot;
}

export function runMcpTool({ pythonPath, projectRoot, dbPath, allowedRoot, toolName, arguments: input = {} }) {
  const cwd = validateProjectRoot(projectRoot);
  const trustedRoot = path.resolve(
    allowedRoot || (dbPath ? path.dirname(dbPath) : projectRoot),
  );
  const args = ['-m', 'wsa.mcp_server'];
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: {
        ...(input || {}),
        ...(dbPath && !(input || {}).db_path ? { db_path: dbPath } : {}),
      },
    },
  };
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WSA_MCP_ENFORCE_PATHS: '1',
        WSA_ALLOWED_ROOT: trustedRoot,
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`wsa MCP call timed out after ${MCP_TIMEOUT_MS}ms`));
    }, MCP_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MCP_MAX_BUFFER_BYTES) {
        child.kill('SIGTERM');
        finish(reject, new Error('wsa MCP response exceeded the buffer limit'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (settled) return;
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      let response;
      try {
        response = line ? JSON.parse(line) : undefined;
      } catch (error) {
        finish(reject, new Error(`Invalid wsa MCP response: ${error.message}`));
        return;
      }
      if (code !== 0 && !response) {
        finish(reject, new Error(stderr.trim() || `wsa MCP exited with code ${code}`));
        return;
      }
      if (!response) {
        finish(reject, new Error(stderr.trim() || 'wsa MCP returned no response'));
        return;
      }
      if (response.error) {
        finish(reject, new Error(response.error.message || 'wsa MCP tool call failed'));
        return;
      }
      finish(resolve, response.result);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function registerTool(api, spec) {
  if (typeof api.registerTool === 'function') api.registerTool(spec);
}

function toolSpec(api, spec, mcpName) {
  const handler = async (input = {}) => {
    const config = resolveConfig(api);
    return runMcpTool({
      ...config,
      toolName: mcpName,
      arguments: input,
    });
  };
  return {
    ...spec,
    async execute(_id, input = {}) {
      return handler(input);
    },
    handler,
  };
}

const READ_TOOLS = [
  {
    name: 'wsa_status', mcpName: 'get_status', description: 'Read local WSA database, capture, and watch status.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wsa_audit', mcpName: 'get_audit_report', description: 'Read the local WSA data audit without changing data.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wsa_search_contacts', mcpName: 'search_contacts', description: 'Search local contact-centered relationship profiles.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
  },
  {
    name: 'wsa_contact_brief', mcpName: 'get_contact_brief', description: 'Read one contact brief and an editable follow-up draft.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { contact_name: { type: 'string' }, min_score: { type: 'integer', minimum: 0 } },
      required: ['contact_name'],
    },
  },
  {
    name: 'wsa_next_followup', mcpName: 'get_next_followup', description: 'Read the highest-priority local follow-up suggestion.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { contact_name: { type: 'string' }, min_score: { type: 'integer', minimum: 0 } },
    },
  },
  {
    name: 'wsa_daily_report', mcpName: 'get_daily_report', description: 'Render today\'s local relationship report in memory.',
    parameters: { type: 'object', additionalProperties: false, properties: { date: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_weekly_report', mcpName: 'get_weekly_report', description: 'Render the local weekly relationship report in memory.',
    parameters: { type: 'object', additionalProperties: false, properties: { date: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_relationship_quality', mcpName: 'get_relationship_quality', description: 'Read evidence-backed relationship quality cards.',
    parameters: { type: 'object', additionalProperties: false, properties: { contact_name: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_relationship_dashboard', mcpName: 'get_relationship_dashboard', description: 'Read daily priorities, cooling contacts, candidates, and group signals.',
    parameters: { type: 'object', additionalProperties: false, properties: { date: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_relationship_sources', mcpName: 'list_relationship_sources', description: 'Read locally imported relationship sources.',
    parameters: { type: 'object', additionalProperties: false, properties: { contact_name: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_relationship_candidates', mcpName: 'list_relationship_candidates', description: 'Read group/event relationship candidates without contacting anyone.',
    parameters: { type: 'object', additionalProperties: false, properties: { status: { type: 'string' }, min_confidence: { type: 'integer' }, limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_feedback_list', mcpName: 'list_feedback', description: 'Read local feedback records for follow-up suggestions.',
    parameters: { type: 'object', additionalProperties: false, properties: { contact_name: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_recent_captures', mcpName: 'list_recent_captures', description: 'List recent capture metadata without reading image bytes.',
    parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'wsa_capture_observations', mcpName: 'get_capture_observations', description: 'Read structured OCR lines, confidence, normalized bounding boxes, and speaker candidates for one capture.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { capture_id: { type: 'integer', minimum: 1 } },
      required: ['capture_id'],
    },
  },
  {
    name: 'wsa_ocr_reviews', mcpName: 'list_ocr_reviews', description: 'Read the low-confidence OCR review queue.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { status: { type: 'string' }, max_confidence: { type: 'number', minimum: 0, maximum: 1 }, limit: { type: 'integer' } },
    },
  },
];

const WRITE_TOOLS = [
  {
    name: 'wsa_record_feedback', mcpName: 'record_feedback', description: 'Record local feedback after explicit user confirmation.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        contact_name: { type: 'string' }, action: { type: 'string' }, note: { type: 'string' },
        until_at: { type: 'string' }, confirmed: { type: 'boolean' }, confirmation_text: { type: 'string' },
      },
      required: ['contact_name', 'action', 'confirmed', 'confirmation_text'],
    },
  },
  {
    name: 'wsa_confirm_relationship_candidate', mcpName: 'confirm_relationship_candidate', description: 'Confirm a candidate as a local contact after explicit user confirmation.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'integer' }, name: { type: 'string' }, source_chat: { type: 'string' }, note: { type: 'string' },
        confirmed: { type: 'boolean' }, confirmation_text: { type: 'string' },
      },
      required: ['confirmed', 'confirmation_text'],
    },
  },
  {
    name: 'wsa_record_ocr_review', mcpName: 'record_ocr_review', description: 'Accept, reject, or correct one OCR observation after explicit confirmation.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        observation_id: { type: 'integer', minimum: 1 }, action: { type: 'string' },
        corrected_text: { type: 'string' }, corrected_speaker: { type: 'string' }, note: { type: 'string' },
        confirmed: { type: 'boolean' }, confirmation_text: { type: 'string' }, reviewed_at: { type: 'string' },
      },
      required: ['observation_id', 'action', 'confirmed', 'confirmation_text'],
    },
  },
];

export function registerOpenClawPlugin(api) {
  const config = resolveConfig(api);
  for (const spec of READ_TOOLS) {
    registerTool(api, toolSpec(api, spec, spec.mcpName));
  }
  if (config.writesEnabled) {
    for (const spec of WRITE_TOOLS) {
      registerTool(api, toolSpec(api, spec, spec.mcpName));
    }
  }
}

export { READ_TOOLS, WRITE_TOOLS };
