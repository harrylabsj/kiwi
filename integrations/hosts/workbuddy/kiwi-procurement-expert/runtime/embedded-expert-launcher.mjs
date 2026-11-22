import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVerifiedBackend } from './backend-client.mjs';
import { verifyFiles } from './bundle-verify.mjs';
import { expertDataDirectory, procurementDataDirectory } from './expert-data.mjs';
import { prepareInstanceData } from './instance-store.mjs';
import { startProductionMcpServer } from './mcp-production-server.mjs';
import { checkToolContract, enableQuoteHistory, enableTargetedNegotiation } from './tool-contract.mjs';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const sessionDirectory = join(sourceRoot, 'buyer');
const startupHoldCodes = new Set([
  'EXPERT_DATA_UNAVAILABLE', 'INSTANCE_DATA_NOT_PRIVATE', 'INSTANCE_DATA_UNAVAILABLE',
  'INSTANCE_STATE_CONFLICT', 'INSTANCE_STATE_CORRUPT', 'INSTANCE_STATE_INCOMPLETE',
  'TOOL_BASELINE_INVALID', 'EXPERT_SERVER_NAME_INVALID', 'NODE_VERSION_UNSUPPORTED',
]);

async function main() {
  const serverName = process.argv[2] ?? 'kiwi-embedded-buyer';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(serverName)) throw new Error('EXPERT_SERVER_NAME_INVALID');
  const configPath = join(sourceRoot, 'expert-config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
  const company = config !== undefined;
  if (company) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('NODE_VERSION_UNSUPPORTED');
  }
  if (company && (config.profile !== 'company-procurement-v1' ||
      config.namespace !== '.kiwi-workbuddy-company-procurement-v1' || serverName !== 'kiwi-company-procurement-buyer')) {
    throw new Error('TOOL_BASELINE_INVALID');
  }
  if (!company && serverName === 'kiwi-company-procurement-buyer') throw new Error('TOOL_BASELINE_INVALID');
  const profile = config?.profile ?? 'legacy13';
  const dataDirectory = !company && serverName === 'kiwi-procurement-buyer'
    ? procurementDataDirectory()
    : expertDataDirectory(undefined, config?.namespace);
  const instance = prepareInstanceData(dataDirectory);
  const environment = { ...process.env };
  for (const key of ['KIWI_CLIENT_ID', 'KIWI_SESSION', 'KIWI_SESSION_TOKEN',
    'KIWI_SESSION_TOKEN_FILE', 'KIWI_SESSION_TOKEN_DIR', 'KIWI_MCP_DB']) {
    delete environment[key];
  }
  environment.KIWI_MCP_DB = instance.dbPath;
  environment.KIWI_CLIENT_ID = instance.instanceId;
  environment.KIWI_SESSION_TOKEN_FILE = instance.tokenFile;

  if (company) {
    for (const key of ['KIWI_A2A_SIGNING_KEY_DIR', 'KIWI_BUYER_AGENT', 'KIWI_CATALOG_SESSION', 'KIWI_DELEGATION_POLICY',
      'KIWI_PRINCIPAL', 'KIWI_QUOTE_HISTORY_DELEGATION', 'KIWI_RECEIPT_CATALOG_URL', 'SHOPPING_BUYER_BOOTSTRAP_TOKEN']) delete environment[key];
    // The private, independent namespace may receive pre-verified captures
    // from an administrator or a trusted host adapter.
    environment.KIWI_PROCUREMENT_CAPTURE_DIRECTORY = join(dataDirectory, 'captures');
  }
  let baseline;
  const explicit = environment.KIWI_LANG?.trim();
  const language = /^(?:zh|en)(?:[-_.@]|$)/i.test(explicit ?? '') ? explicit : (environment.LANG || environment.LC_ALL || 'en');
  const locale = /^zh(?:[-_.@]|$)/i.test(language) ? 'zh' : 'en';
  environment.KIWI_LANG = locale;
  try {
    const file = company ? `mcp-tools-company-${locale}.json`
      : locale === 'zh' ? 'mcp-tools-0.12.12-zh.json' : 'mcp-tools-0.12.12.json';
    baseline = JSON.parse(readFileSync(join(sourceRoot, file), 'utf8'));
    checkToolContract(baseline, baseline, profile);
    if (!company) enableTargetedNegotiation(baseline, locale);
    if (environment.KIWI_QUOTE_HISTORY_DELEGATION === 'true') enableQuoteHistory(baseline);
  } catch (error) {
    const detail = error.contractDetail ?? (error.code === 'ENOENT' ? 'FILE_MISSING'
      : error instanceof SyntaxError ? 'INVALID_JSON' : 'VALIDATION_FAILED');
    process.stderr.write(`KIWI_BASELINE_DIAGNOSTIC:${detail}\n`);
    throw new Error('TOOL_BASELINE_INVALID',{cause:error});
  }
  const server = startProductionMcpServer({
    input: process.stdin,
    output: process.stdout,
    baseline,
    profile,
    serverName,
    onStatus: code => process.stderr.write(`KIWI_STATUS:${code}\n`),
    prepare: async () => {
      const manifest = new Map(Object.entries(JSON.parse(readFileSync(join(sourceRoot, 'buyer-files.json'), 'utf8'))));
      // All executable and data files come from the submitted expert ZIP.
      // Verify the complete tree before allowing a child process to use it.
      const entries = readdirSync(sourceRoot, { withFileTypes: true });
      if (!entries.some(entry => entry.name === 'buyer' && entry.isDirectory())) {
        throw new Error('BUNDLED_RUNTIME_INVALID');
      }
      verifyFiles(sessionDirectory, manifest);
      if (manifest.size) throw new Error('BUNDLED_RUNTIME_INVALID');
      return sessionDirectory;
    },
    activate: (prepared, { signal, clientCapabilities, onMessage }) => startVerifiedBackend({
      nodeBinary: process.execPath,
      sessionDirectory: prepared,
      backendHome: instance.root,
      dataDirectory,
      baseline,
      profile,
      clientCapabilities,
      onMessage,
      sourceRoot,
      environment,
      signal,
    }),
  });
  const shutdown = () => server.shutdown();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    const outcome = await server.done;
    if (outcome.status === 'failed') {
      process.stderr.write(`KIWI_LAUNCHER_HOLD:${outcome.code}\n`);
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  }
}

// Packaging runs this without a host to prove the submitted module graph
// loads. A missing runtimeSources entry fails here instead of at first launch.
if (process.argv.includes('--self-check')) {
  process.exit(0);
}

main().catch(error => {
  const reason = error?.code ?? error?.message;
  const code = startupHoldCodes.has(reason) ? reason : 'EXPERT_STARTUP_FAILED';
  process.stderr.write(`KIWI_STATUS:FAILED_STARTUP\nKIWI_LAUNCHER_HOLD:${code}\n`);
  process.exitCode = 1;
});
