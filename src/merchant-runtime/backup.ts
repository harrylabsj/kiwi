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
import { writeFileAtomic } from "../fs/atomic-write.js";

export interface BackupManifest {
  created_at: string;
  source_dir: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  /** 审查 P2：跳过未备份的路径（如 symlink），让恢复侧的数据缺口可见。 */
  skipped?: string[];
}

export interface BackupResult {
  snapshot_dir: string;
  manifest: BackupManifest;
  rotated_out: string[];
}

function walk(dir: string, base: string, out: string[], skipped: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out, skipped);
    else if (entry.isFile()) out.push(path.relative(base, full));
    else if (entry.isSymbolicLink()) {
      // 审查 P2：symlink 数据静默丢弃会让恢复后出现「校验全绿」的数据缺口
      // ——至少记入 manifest 跳过清单，让缺口可见。
      skipped.push(path.relative(base, full));
    }
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
  if (!existsSync(src)) {
    // 审查 P2：DatabaseSync 缺省会静默建空库——源在 walk 与快照之间消失时
    // 会产出「校验全绿」的空库快照（静默数据丢失）。fail-closed。
    throw new Error(`SQLite 源库不存在，拒绝快照（fail-closed）：${src}`);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(src, { readOnly: true });
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

/** 快照备份 + 轮换（keepLatest 份）。幂等：同时间戳目录复用覆盖。
 *  启动时清理孤儿快照目录（审查 P2：优雅关闭/崩溃打断备份留下的无 manifest
 *  目录既不参与轮换也永不清理，反复在备份窗口重启可累积占满磁盘）。 */
export function runBackup(options: {
  dataDir: string;
  backupsDir: string;
  now?: () => string;
  keepLatest?: number;
}): BackupResult {
  const now = (options.now ?? (() => new Date().toISOString()))();
  const keep = options.keepLatest ?? 10;
  // 孤儿快照清理：无 manifest.json 且修改时间超过 1 小时的目录（1 小时缓冲
  // 避免误删并发进行中的快照——jobs 已串行，此处是双保险）。
  try {
    for (const entry of readdirSync(options.backupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(options.backupsDir, entry.name);
      if (existsSync(path.join(dir, "manifest.json"))) continue;
      try {
        if (Date.now() - statSync(dir).mtimeMs > 60 * 60 * 1000) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // 单个目录清理失败不影响本轮备份
      }
    }
  } catch {
    // backups 目录不存在等：交给下方 mkdirSync
  }
  const stamp = now.replace(/[:.]/g, "-");
  const snapshotDir = path.join(options.backupsDir, stamp);
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });

  const files: string[] = [];
  const skipped: string[] = [];
  walk(options.dataDir, options.dataDir, files, skipped);
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
    const manifest: BackupManifest = {
      created_at: now,
      source_dir: options.dataDir,
      files: [],
      ...(skipped.length > 0 ? { skipped } : {}),
    };
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
    // 审查 P2：成功备份的最新时间戳（health 的 backup_stale 告警读取）。
    writeFileAtomic(
      path.join(options.backupsDir, "latest-backup.json"),
      `${JSON.stringify({ created_at: now, snapshot_dir: snapshotDir }, null, 2)}\n`,
      { mode: 0o600 },
    );
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
  // 路径越界守卫（审查 P2）：manifest 可能来自异地/他人，files[].path 含
  // `..` 段或绝对路径即是任意文件写入原语——逐条校验后再落盘。
  const targetRoot = path.resolve(options.targetDir);
  const safeRel = (rel: string): string => {
    const normalized = path.normalize(rel);
    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) {
      throw new Error(`备份清单路径越界（拒绝恢复）：${rel}`);
    }
    return normalized;
  };
  // 先校验完整性（manifest 内每个文件存在且 sha256 一致）——不完整拒绝恢复。
  for (const f of manifest.files) {
    const rel = safeRel(f.path);
    const src = path.join(options.snapshotDir, rel);
    if (!existsSync(src)) throw new Error(`备份快照缺文件 ${f.path}（不完整，拒绝恢复）`);
    if (sha256File(src) !== f.sha256) {
      throw new Error(`备份快照文件 ${f.path} 摘要不一致（损坏，拒绝恢复）`);
    }
  }
  mkdirSync(options.targetDir, { recursive: true, mode: 0o700 });
  for (const f of manifest.files) {
    const dst = path.join(targetRoot, safeRel(f.path));
    mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    cpSync(path.join(options.snapshotDir, safeRel(f.path)), dst);
  }
  return { restored: manifest.files.length, verified: true };
}
