import { expertDataDirectory } from './expert-data.mjs';

function hold(code) {
  process.stderr.write(`KIWI_STATUS:FAILED_STARTUP\nKIWI_LAUNCHER_HOLD:${code}\n`);
  process.exitCode = 1;
}

// Keep the data-directory check separate from module loading: a missing or
// broken production-launcher module must not be reported as a home-directory
// permission problem.
let dataDirectory;
try {
  dataDirectory = expertDataDirectory();
} catch {
  hold('EXPERT_DATA_UNAVAILABLE');
}
if (dataDirectory !== undefined) {
  process.env.CODEBUDDY_PLUGIN_DATA = dataDirectory;
  process.env.KIWI_EXPERT_DEFER_PREPARE = '1';
  try {
    await import('./production-launcher.mjs');
  } catch {
    hold('EXPERT_RUNTIME_UNAVAILABLE');
  }
}
