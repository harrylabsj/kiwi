import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Deployment assumption: one OS user represents one buyer; WorkBuddy accounts
// belonging to different buyers must not share that OS user.
export function expertDataDirectory(home = homedir()) {
  if (!['darwin', 'linux'].includes(process.platform) || !isAbsolute(home) || typeof process.getuid !== 'function') throw new Error('EXPERT_DATA_UNAVAILABLE');
  const root = realpathSync(home);
  const homeStat = lstatSync(root);
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid() || (homeStat.mode & 0o022) !== 0) throw new Error('EXPERT_DATA_UNAVAILABLE');
  const dir = join(root, '.kiwi-workbuddy-buyer-v1');
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700 || realpathSync(dir) !== dir) throw new Error('EXPERT_DATA_UNAVAILABLE');
  return dir;
}
