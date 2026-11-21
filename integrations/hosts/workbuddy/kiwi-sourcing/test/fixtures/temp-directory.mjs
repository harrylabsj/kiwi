import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempDirectory(prefix) {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}
