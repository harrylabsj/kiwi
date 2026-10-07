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

/** Atomic replacement: file fsync before rename, directory fsync after rename.
 * Directory sync failure reports committed=true; never roll back a renamed file.
 * No power-loss guarantee is inferred from fault injection. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
export type AtomicWriteIo = Pick<
  typeof fs,
  | "mkdirSync"
  | "lstatSync"
  | "openSync"
  | "writeFileSync"
  | "fchmodSync"
  | "fsyncSync"
  | "closeSync"
  | "renameSync"
  | "unlinkSync"
>;
export class AtomicWriteError extends Error {
  constructor(
    readonly code: string,
    readonly committed: boolean,
    options: ErrorOptions,
  ) {
    super(code, options);
  }
}
export function writeFileAtomic(
  file: string,
  data: string,
  options: { mode?: number; io?: AtomicWriteIo } = {},
): void {
  const io = options.io ?? fs,
    dir = path.dirname(file);
  io.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let oldMode: number | undefined;
  try {
    const s = io.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink()) throw new Error("ATOMIC_TARGET_NOT_REGULAR");
    oldMode = s.mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined,
    dirFd: number | undefined,
    committed = false;
  try {
    fd = io.openSync(tmp, "wx", options.mode ?? 0o600);
    io.writeFileSync(fd, data);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, file);
    committed = true;
    dirFd = io.openSync(dir, "r");
    io.fsyncSync(dirFd);
  } catch (e) {
    throw new AtomicWriteError(
      committed ? "ATOMIC_DIRECTORY_SYNC_FAILED" : "ATOMIC_REPLACE_FAILED",
      committed,
      { cause: e },
    );
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {}
    }
    if (dirFd !== undefined) {
      try {
        io.closeSync(dirFd);
      } catch {}
    }
    if (!committed) {
      try {
        io.unlinkSync(tmp);
      } catch (e) {
        /* A cleanup fault leaves owned temp evidence; it must not mask the primary failure. */
      }
    }
  }
}
