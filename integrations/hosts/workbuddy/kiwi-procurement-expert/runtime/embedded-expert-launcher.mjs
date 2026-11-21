import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVerifiedBackend } from './backend-client.mjs';
import { expertDataDirectory } from './expert-data.mjs';
import { prepareInstanceData } from './instance-store.mjs';
import { startProductionMcpServer } from './mcp-production-server.mjs';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const sessionDirectory = join(sourceRoot, 'buyer');

function verifyFiles(directory, manifest, relative = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const key = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      verifyFiles(file, manifest, key);
    } else if (entry.isFile() && manifest.has(key)) {
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (digest !== manifest.get(key)) throw new Error('BUNDLED_RUNTIME_INVALID');
      manifest.delete(key);
    } else {
      throw new Error('BUNDLED_RUNTIME_INVALID');
    }
  }
}

async function main() {
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

  const baseline = JSON.parse(readFileSync(join(sourceRoot, 'mcp-tools-0.12.12.json'), 'utf8'));
  if (environment.KIWI_QUOTE_HISTORY_DELEGATION === 'true') {
    baseline.find(tool => tool.name === 'kiwi_request_quotes').inputSchema.properties.reuse_history = { type: 'boolean' };
  }
  const server = startProductionMcpServer({
    input: process.stdin,
    output: process.stdout,
    baseline,
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

main().catch(() => {
  process.stderr.write('KIWI_STATUS:FAILED_STARTUP\n');
  process.exitCode = 1;
});
