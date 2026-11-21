import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Host and OS metadata is not executable input. Finder, iCloud and backup
// tools can create these at any time; refusing to start on them would brick a
// correctly installed package.
export function isHostMetadata(name) {
  return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini'
    || (name.startsWith('._') && name.length > 2)
    || (name.endsWith('.icloud') && name.length > 7);
}

export function verifyFiles(directory, manifest, relative = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const key = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      verifyFiles(file, manifest, key);
    } else if (entry.isFile() && manifest.has(key)) {
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (digest !== manifest.get(key)) throw new Error('BUNDLED_RUNTIME_INVALID');
      manifest.delete(key);
    } else if (entry.isFile() && isHostMetadata(entry.name)) {
      continue;
    } else {
      throw new Error('BUNDLED_RUNTIME_INVALID');
    }
  }
}
