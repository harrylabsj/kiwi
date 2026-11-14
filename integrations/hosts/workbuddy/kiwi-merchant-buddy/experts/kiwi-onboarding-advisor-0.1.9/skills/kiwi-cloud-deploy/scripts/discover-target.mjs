#!/usr/bin/env node
/** Read the workspace .wbapp_*.genie markers and the target app's config. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());
const files = (await readdir(root)).filter((name) => /^\.wbapp_.+\.genie$/.test(name));
const apps = [];
for (const file of files) {
  const text = await readFile(path.join(root, file), 'utf8');
  const read = (key) => new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text)?.[1]?.trim();
  const appId = read('appId');
  const rawLocalDir = read('localDir');
  if (!appId || !rawLocalDir) continue;
  // Marker paths are written by the platform; resolve relative values against the workspace root,
  // not the caller's cwd, so a relative localDir cannot silently point at the wrong directory.
  const localDir = path.resolve(root, rawLocalDir);
  let config = {};
  let pkg = {};
  let localDirExists = true;
  try { config = JSON.parse(await readFile(path.join(localDir, 'cloud.config.json'), 'utf8')); } catch { config = {}; }
  try { pkg = JSON.parse(await readFile(path.join(localDir, 'package.json'), 'utf8')); } catch { pkg = {}; }
  try { await readdir(localDir); } catch { localDirExists = false; }
  apps.push({
    app_id: appId,
    name: read('name') ?? null,
    local_dir: localDir,
    local_dir_exists: localDirExists,
    origin: config.public_origin ?? null,
    data_dir: config.data_dir ?? null,
    version: pkg.version ?? null,
  });
}
process.stdout.write(`${JSON.stringify({ workspace: root, apps }, null, 2)}\n`);
