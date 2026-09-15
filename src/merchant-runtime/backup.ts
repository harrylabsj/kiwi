/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 持续备份（V2 阶段四：src/merchant-runtime/backup.ts；阶段一 jobs 接缝落地）。
 *
 * 状态目录快照：复制 SQLite/JSONL/Ledger 等到 backups/<ISO 时间戳>/，
 * 写 manifest（文件清单 + 大小 + sha256）供恢复校验；轮换保留最近 N 份。
 * 恢复演练：restore(snapshot, target) 按 manifest 校验后回写。
 * RPO=0 口径：已确认询价/协议在 Ledger（<dataDir>/a2a/ledger）内，快照包含之。
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface BackupManifest {
  created_at: string;
  source_dir: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export interface BackupResult {
  snapshot_dir: string;
  manifest: BackupManifest;
  rotated_out: string[];
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 快照备份 + 轮换（keepLatest 份）。幂等：同时间戳目录复用覆盖。 */
export function runBackup(options: {
  dataDir: string;
  backupsDir: string;
  now?: () => string;
  keepLatest?: number;
}): BackupResult {
  const now = (options.now ?? (() => new Date().toISOString()))();
  const keep = options.keepLatest ?? 10;
  const stamp = now.replace(/[:.]/g, "-");
  const snapshotDir = path.join(options.backupsDir, stamp);
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });

  const files: string[] = [];
  walk(options.dataDir, options.dataDir, files);
  // 不备份 backups 自身（若 backups 在 dataDir 内）与锁文件
  const included = files.filter(
    (f) => !f.startsWith("backups") && !f.endsWith(".lock") && !f.endsWith(".tmp"),
  );
  const manifest: BackupManifest = { created_at: now, source_dir: options.dataDir, files: [] };
  for (const rel of included.sort()) {
    const src = path.join(options.dataDir, rel);
    const dst = path.join(snapshotDir, rel);
    mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    cpSync(src, dst);
    manifest.files.push({ path: rel, bytes: statSync(src).size, sha256: sha256File(src) });
  }
  writeFileSync(path.join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });

  // 轮换：保留最近 keep 份
  const snapshots = readdirSync(options.backupsDir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(path.join(options.backupsDir, e.name, "manifest.json")),
    )
    .map((e) => e.name)
    .sort()
    .reverse();
  const rotatedOut: string[] = [];
  for (const old of snapshots.slice(keep)) {
    rmSync(path.join(options.backupsDir, old), { recursive: true, force: true });
    rotatedOut.push(old);
  }
  return { snapshot_dir: snapshotDir, manifest, rotated_out: rotatedOut };
}

/** 恢复（恢复演练同路径）：按 manifest 校验快照完整性后回写目标目录。 */
export function restoreBackup(options: { snapshotDir: string; targetDir: string }): {
  restored: number;
  verified: true;
} {
  const manifest = JSON.parse(
    readFileSync(path.join(options.snapshotDir, "manifest.json"), "utf8"),
  ) as BackupManifest;
  // 先校验完整性（manifest 内每个文件存在且 sha256 一致）——不完整拒绝恢复。
  for (const f of manifest.files) {
    const src = path.join(options.snapshotDir, f.path);
    if (!existsSync(src)) throw new Error(`备份快照缺文件 ${f.path}（不完整，拒绝恢复）`);
    if (sha256File(src) !== f.sha256) {
      throw new Error(`备份快照文件 ${f.path} 摘要不一致（损坏，拒绝恢复）`);
    }
  }
  mkdirSync(options.targetDir, { recursive: true, mode: 0o700 });
  for (const f of manifest.files) {
    const dst = path.join(options.targetDir, f.path);
    mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    cpSync(path.join(options.snapshotDir, f.path), dst);
  }
  return { restored: manifest.files.length, verified: true };
}
