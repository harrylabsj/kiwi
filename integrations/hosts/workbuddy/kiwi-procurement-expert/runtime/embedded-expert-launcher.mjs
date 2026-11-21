import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVerifiedBackend } from './backend-client.mjs';
import { verifyFiles } from './bundle-verify.mjs';
import { expertDataDirectory } from './expert-data.mjs';
import { prepareInstanceData } from './instance-store.mjs';
import { startProductionMcpServer } from './mcp-production-server.mjs';
import { enableQuoteHistory } from './tool-contract.mjs';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const sessionDirectory = join(sourceRoot, 'buyer');
const startupHoldCodes = new Set([
  'EXPERT_DATA_UNAVAILABLE', 'INSTANCE_DATA_NOT_PRIVATE', 'INSTANCE_DATA_UNAVAILABLE',
  'INSTANCE_STATE_CONFLICT', 'INSTANCE_STATE_CORRUPT', 'INSTANCE_STATE_INCOMPLETE',
  'TOOL_BASELINE_INVALID', 'EXPERT_SERVER_NAME_INVALID',
]);

async function main() {
  const serverName = process.argv[2] ?? 'kiwi-embedded-buyer';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(serverName)) throw new Error('EXPERT_SERVER_NAME_INVALID');
  const dataDirectory = expertDataDirectory();
  const instance = prepareInstanceData(dataDirectory);
  const environment = { ...process.env };
  for (const key of ['KIWI_CLIENT_ID', 'KIWI_SESSION', 'KIWI_SESSION_TOKEN',
    'KIWI_SESSION_TOKEN_FILE', 'KIWI_SESSION_TOKEN_DIR', 'KIWI_MCP_DB']) {
    delete environment[key];
  }
  environment.KIWI_MCP_DB = instance.dbPath;
  environment.KIWI_CLIENT_ID = instance.instanceId;
  environment.KIWI_SESSION_TOKEN_FILE = instance.tokenFile;

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(join(sourceRoot, 'mcp-tools-0.12.12.json'), 'utf8'));
  } catch {
    throw new Error('TOOL_BASELINE_INVALID');
  }
  if (!Array.isArray(baseline) || baseline.length !== 13) throw new Error('TOOL_BASELINE_INVALID');
  if (environment.KIWI_QUOTE_HISTORY_DELEGATION === 'true') {
    enableQuoteHistory(baseline);
  }
  const server = startProductionMcpServer({
    input: process.stdin,
    output: process.stdout,
    baseline,
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
    await server.done;
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
