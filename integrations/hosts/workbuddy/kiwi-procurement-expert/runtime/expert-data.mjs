import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Deployment assumption: one OS user represents one buyer; WorkBuddy accounts
// belonging to different buyers must not share that OS user.
export function expertDataDirectory(home = homedir(), namespace = '.kiwi-workbuddy-buyer-v1') {
  if (!['.kiwi-workbuddy-buyer-v1', '.kiwi-workbuddy-company-procurement-v1'].includes(namespace)) throw new Error('EXPERT_DATA_UNAVAILABLE');
  if (!['darwin', 'linux'].includes(process.platform) || !isAbsolute(home) || typeof process.getuid !== 'function') throw new Error('EXPERT_DATA_UNAVAILABLE');
  const root = realpathSync(home);
  const homeStat = lstatSync(root);
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid() || (homeStat.mode & 0o022) !== 0) throw new Error('EXPERT_DATA_UNAVAILABLE');
  const dir = join(root, namespace);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700 || realpathSync(dir) !== dir) throw new Error('EXPERT_DATA_UNAVAILABLE');
  return dir;
}

// Keep using the established buyer identity. Only start in host storage when
// HOME cannot host a new instance, and keep using it on subsequent launches.
export function procurementDataDirectory(home = homedir(), pluginData = process.env.CODEBUDDY_PLUGIN_DATA) {
  const namespace = '.kiwi-workbuddy-buyer-v1';
  const denied = error => ['EACCES', 'EPERM', 'EROFS'].includes(error.code);
  try {
    if (!pluginData) return expertDataDirectory(home, namespace);
    if (!isAbsolute(pluginData)) throw new Error('EXPERT_DATA_UNAVAILABLE');
    const parent = lstatSync(pluginData, {throwIfNoEntry:false});
    if (!parent) return expertDataDirectory(home, namespace);
    if (!parent.isDirectory()) throw new Error('EXPERT_DATA_UNAVAILABLE');
    if (lstatSync(join(pluginData, namespace), {throwIfNoEntry:false})) return expertDataDirectory(pluginData, namespace);
    if (lstatSync(join(home, namespace), {throwIfNoEntry:false})) return expertDataDirectory(home, namespace);
    const homeStat = lstatSync(realpathSync(home));
    if ((homeStat.mode & 0o200) && homeStat.uid === process.getuid?.()) {
      try { return expertDataDirectory(home, namespace); }
      catch (error) { if (!denied(error)) throw error; }
    }
    return expertDataDirectory(pluginData, namespace);
  } catch (error) {
    if (denied(error) || error.code === 'ENOENT') throw new Error('EXPERT_DATA_UNAVAILABLE', {cause: error});
    throw error;
  }
}
