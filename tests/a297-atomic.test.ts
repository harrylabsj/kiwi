import { it, expect } from "vitest";
import * as fs from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic, AtomicWriteError } from "../src/fs/atomic-write.js";
it("file sync/rename failures retain old target, clean own temp; directory sync failure is committed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a297-atomic-")),
    file = path.join(root, "state");
  writeFileSync(file, "old");
  chmodSync(file, 0o640);
  const mask = process.umask();
  for (const kind of ["file-sync", "rename", "dir-sync"]) {
    writeFileSync(file, "old");
    chmodSync(file, 0o640);
    let sync = 0;
    const io = {
      ...fs,
      fsyncSync: (fd: number) => {
        sync++;
        if ((kind === "file-sync" && sync === 1) || (kind === "dir-sync" && sync === 2))
          throw new Error("injected");
        return fs.fsyncSync(fd);
      },
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (kind === "rename") throw new Error("injected");
        fs.renameSync(from, to);
      },
    };
    let error;
    try {
      writeFileAtomic(file, "new", { mode: 0o600, io });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AtomicWriteError);
    expect((error as AtomicWriteError).committed).toBe(kind === "dir-sync");
    expect(readFileSync(file, "utf8")).toBe(kind === "dir-sync" ? "new" : "old");
    expect(readdirSync(root).filter((x) => x.includes(".tmp-"))).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(kind === "dir-sync" ? 0o600 : 0o640);
    expect(process.umask()).toBe(mask);
  }
  writeFileAtomic(file, "success", { mode: 0o600 });
  expect(readFileSync(file, "utf8")).toBe("success");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  chmodSync(file, 0o644);
  writeFileAtomic(file, "private", { mode: 0o600 });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

import { withEnrollmentStoreLock } from "../src/cloud/binding/store-lock.js";
it("lock metadata write fault closes own fd and retains unknown lock without calling callback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a297-lock-"));
  let opened: number | undefined,
    closed = 0,
    calls = 0;
  const io = {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      opened = fs.openSync(...args);
      return opened;
    },
    writeFileSync: (..._args: Parameters<typeof fs.writeFileSync>) => {
      throw Error("metadata-fault");
    },
    closeSync: (fd: number) => {
      closed++;
      fs.closeSync(fd);
    },
  };
  expect(() =>
    withEnrollmentStoreLock(
      root,
      () => {
        calls++;
      },
      { io },
    ),
  ).toThrow("metadata-fault");
  expect(calls).toBe(0);
  expect(closed).toBe(1);
  expect(opened).toBeTypeOf("number");
  expect(() => fs.fstatSync(opened!)).toThrow();
  expect(readdirSync(root)).toContain("merchant-enrollments.lock");
});
