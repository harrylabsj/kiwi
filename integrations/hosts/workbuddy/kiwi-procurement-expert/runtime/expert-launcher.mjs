import { expertDataDirectory } from './expert-data.mjs';
try {
  process.env.CODEBUDDY_PLUGIN_DATA = expertDataDirectory();
  process.env.KIWI_EXPERT_DEFER_PREPARE = '1';
  await import('./production-launcher.mjs');
} catch {
  process.stderr.write('KIWI_STATUS:FAILED_STARTUP\nKIWI_LAUNCHER_HOLD:EXPERT_DATA_UNAVAILABLE\n');
  process.exitCode = 1;
}
