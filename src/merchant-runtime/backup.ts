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
 * 持续备份（V2 阶段四 + BUG-06 修复：src/merchant-runtime/backup.ts）。
 *
 * 事务一致性：
 *   - SQLite 文件用 `VACUUM INTO`（读事务一致性快照；源库 WAL 模式下并发写
 *     安全；busy 时短暂重试，仍失败则本轮备份 fail-closed 记错误）；
 *   - 快照完成后实际打开备份库跑 `PRAGMA integrity_check`，不通过即删除该轮
 *     快照并抛错（绝不留下不可恢复的快照）；
 *   - Ledger 等文件类数据在 SQLite 快照之后复制——最终一致性边界：append
 *     中的最后一行可能是部分写入，恢复端按 Ledger 链校验容错（文档化，
 *     见 deploy/merchant-bundle/README.md）。
 *
 * RPO 口径（工程诚实）：周期快照的 RPO ≤ 备份周期（缺省 5 分钟），
 * 不宣称 RPO=0；RPO=0 需同步持久化/持续复制（留主备阶段）。
 * 快照写 manifest（文件清单 + 大小 + sha256）供恢复校验；轮换保留最近 N 份。
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
import { DatabaseSync } from "node:sqlite";

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

/**
 * SQLite 事务一致性快照（BUG-06）：VACUUM INTO（读事务一致；源库 WAL 下并发
 * 写安全）。busy/失败短暂重试，仍失败抛错（本轮备份 fail-closed）。
 * 快照后打开备份库跑 integrity_check——不通过即抛错（调用方删除该轮快照）。
 */
function snapshotSqlite(src: string, dst: string): void {
  mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  rmSync(dst, { force: true });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(src);
      db.exec("PRAGMA busy_timeout = 2000");
      // VACUUM INTO 目标路径防注入：单引号转义
      db.exec(`VACUUM INTO '${dst.replaceAll("'", "''")}'`);
      db.close();
      db = undefined;
      const check = new DatabaseSync(dst);
      try {
        const rows = check.prepare("PRAGMA integrity_check").all() as Array<{
          integrity_check: string;
        }>;
        if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
          throw new Error(`备份库 integrity_check 未通过：${dst}（${JSON.stringify(rows)}）`);
        }
      } finally {
        check.close();
      }
      return;
    } catch (err) {
      lastErr = err;
      if (db !== undefined) {
        try {
          db.close();
        } catch {
          // 忽略
        }
      }
      rmSync(dst, { force: true });
    }
  }
  throw new Error(
    `SQLite 快照失败（${src}）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
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
  // 不备份 backups 自身（若 backups 在 dataDir 内）、锁文件与 SQLite WAL/SHM 临时文件
  const included = files.filter(
    (f) =>
      !f.startsWith("backups") &&
      !f.endsWith(".lock") &&
      !f.endsWith(".tmp") &&
      !f.endsWith(".sqlite-wal") &&
      !f.endsWith(".sqlite-shm"),
  );
  try {
    // SQLite 先行（VACUUM INTO 一致性快照），文件类随后（最终一致性边界见文件头）
    const sorted = included.sort((a, b) => {
      const aSql = a.endsWith(".sqlite") ? 0 : 1;
      const bSql = b.endsWith(".sqlite") ? 0 : 1;
      return aSql - bSql || (a < b ? -1 : 1);
    });
    const manifest: BackupManifest = { created_at: now, source_dir: options.dataDir, files: [] };
    for (const rel of sorted) {
      const src = path.join(options.dataDir, rel);
      const dst = path.join(snapshotDir, rel);
      if (rel.endsWith(".sqlite")) {
        snapshotSqlite(src, dst);
      } else {
        mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        cpSync(src, dst);
      }
      // manifest 记录的是**快照内容**的摘要（dst），恢复校验的是快照自身完整性
      manifest.files.push({ path: rel, bytes: statSync(dst).size, sha256: sha256File(dst) });
    }
    writeFileSync(path.join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    // 失败轮次不留半成品快照
    rmSync(snapshotDir, { recursive: true, force: true });
    throw err;
  }

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
  const manifest = JSON.parse(
    readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"),
  ) as BackupManifest;
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
