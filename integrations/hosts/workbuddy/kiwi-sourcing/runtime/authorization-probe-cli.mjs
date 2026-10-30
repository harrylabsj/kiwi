import { isAbsolute } from 'node:path';
import { runAuthorizationProbe } from './authorization-probe.mjs';
if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) {
  process.stderr.write('AUTH_PROBE_ARGUMENT_INVALID\n'); process.exitCode=1;
} else {
  try { process.stdout.write(`${JSON.stringify(await runAuthorizationProbe(process.argv[2]))}\n`); }
  catch { process.stderr.write('AUTH_PROBE_FAILED\n'); process.exitCode=1; }
}
