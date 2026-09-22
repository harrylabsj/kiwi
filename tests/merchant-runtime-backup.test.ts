import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { restoreBackup, runBackup } from "../src/merchant-runtime/backup.js";

describe("merchant runtime backup and restore", () => {
  it("creates an integrity-checked snapshot and restores SQLite plus files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-backup-"));
    const dataDir = path.join(root, "data");
    const backupsDir = path.join(root, "backups");
    const targetDir = path.join(root, "restored");
    mkdirSync(dataDir, { recursive: true });
    try {
      const db = new DatabaseSync(path.join(dataDir, "state.sqlite"));
      db.exec("CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO facts (id, value) VALUES (?, ?)").run("f1", "kept");
      db.close();
      mkdirSync(path.join(dataDir, "ledger"), { recursive: true });
      writeFileSync(path.join(dataDir, "ledger", "neg.jsonl"), '{"event":"one"}\n');

      const result = runBackup({
        dataDir,
        backupsDir,
        now: () => "2026-09-22T12:00:00.000Z",
        keepLatest: 2,
      });
      expect(result.manifest.files.map((file) => file.path)).toEqual([
        "state.sqlite",
        "ledger/neg.jsonl",
      ]);
      expect(existsSync(path.join(result.snapshot_dir, "manifest.json"))).toBe(true);

      expect(restoreBackup({ snapshotDir: result.snapshot_dir, targetDir })).toEqual({
        restored: 2,
        verified: true,
      });
      const restored = new DatabaseSync(path.join(targetDir, "state.sqlite"), { readOnly: true });
      expect(restored.prepare("SELECT value FROM facts WHERE id='f1'").get()).toEqual({ value: "kept" });
      restored.close();
      expect(readFileSync(path.join(targetDir, "ledger", "neg.jsonl"), "utf8")).toContain("one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered snapshot before writing the restore target", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-backup-tamper-"));
    const dataDir = path.join(root, "data");
    const backupsDir = path.join(root, "backups");
    const targetDir = path.join(root, "restored");
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(path.join(dataDir, "note.txt"), "original\n");
      const result = runBackup({ dataDir, backupsDir, now: () => "2026-09-22T12:01:00.000Z" });
      writeFileSync(path.join(result.snapshot_dir, "note.txt"), "tampered\n");
      expect(() => restoreBackup({ snapshotDir: result.snapshot_dir, targetDir })).toThrow(/摘要不一致/);
      expect(existsSync(targetDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
