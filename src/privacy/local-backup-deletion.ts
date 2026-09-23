/** Physical erasure for the Runtime's own, file-backed backup generations. */

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";

import type { PrivacyDeletionNodeHandler } from "./workbench-retention.js";

interface LocalBackupManifest {
  created_at: string;
  source_dir: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

/**
 * Build the `controlled-backup` processor for backups created by runBackup().
 * It removes every verified snapshot owned by this Runtime instance. A fresh
 * snapshot is intentionally left to the normal backup job, after the live
 * deletion processors have completed. Remote/platform-managed backups need a
 * separate provider and must not be represented by this local receipt.
 */
export function createLocalBackupDeletionHandler(options: {
  dataDir: string;
  backupsDir: string;
}): PrivacyDeletionNodeHandler {
  const dataDir = path.resolve(options.dataDir);
  const backupsDir = path.resolve(options.backupsDir);
  if (backupsDir !== path.join(dataDir, "backups")) {
    throw new Error("controlled backup directory must be this Runtime's dataDir/backups");
  }

  return ({ requestId, consentGeneration }) => {
    if (!existsSync(backupsDir)) {
      return {
        receiptRef: `local-backup:${requestId}:${consentGeneration}:empty`,
        deletedArtifacts: 0,
      };
    }
    const rootStat = lstatSync(backupsDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("controlled backup directory is not a real directory");
    }

    const entries = readdirSync(backupsDir, { withFileTypes: true });
    const snapshots: string[] = [];
    let latestMarker: string | undefined;
    for (const entry of entries) {
      const full = path.join(backupsDir, entry.name);
      if (entry.name === "latest-backup.json") {
        const markerStat = lstatSync(full);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
          throw new Error("controlled backup latest marker is not a regular file");
        }
        latestMarker = full;
        continue;
      }
      if (!entry.isDirectory()) {
        throw new Error(`unrecognized entry in controlled backup directory: ${entry.name}`);
      }
      const snapshotStat = lstatSync(full);
      if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) {
        throw new Error(`controlled backup snapshot is not a real directory: ${entry.name}`);
      }
      const manifestPath = path.join(full, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error(`controlled backup snapshot has no manifest: ${entry.name}`);
      }
      const manifestStat = lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        throw new Error(`controlled backup manifest is not a regular file: ${entry.name}`);
      }
      const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
      if (path.resolve(manifest.source_dir) !== dataDir) {
        throw new Error(`backup manifest belongs to a different data directory: ${entry.name}`);
      }
      snapshots.push(full);
    }

    // Validate the complete set before deleting any generation.
    for (const snapshot of snapshots) rmSync(snapshot, { recursive: true, force: false });
    if (latestMarker !== undefined) unlinkSync(latestMarker);
    const remaining = readdirSync(backupsDir);
    if (remaining.length !== 0) {
      throw new Error("controlled backup directory was not fully cleared");
    }
    return {
      receiptRef: `local-backup:${requestId}:${consentGeneration}:purged-${snapshots.length}`,
      deletedArtifacts: snapshots.length,
    };
  };
}

function parseManifest(serialized: string): LocalBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("controlled backup manifest is invalid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("controlled backup manifest must be an object");
  }
  const manifest = value as Partial<LocalBackupManifest>;
  if (
    typeof manifest.created_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.created_at)) ||
    typeof manifest.source_dir !== "string" ||
    !path.isAbsolute(manifest.source_dir) ||
    !Array.isArray(manifest.files) ||
    manifest.files.some(
      (file) =>
        file === null ||
        typeof file !== "object" ||
        typeof file.path !== "string" ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        typeof file.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    )
  ) {
    throw new Error("controlled backup manifest does not match runBackup format");
  }
  return manifest as LocalBackupManifest;
}
