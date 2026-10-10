/** Short local RMW exclusion. Never held over network or a challenge callback.
 * Unknown/stale locks are refused, not deleted or stolen. */

import * as nativeFs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
export class EnrollmentStoreBusy extends Error {
  readonly code = "ENROLLMENT_STORE_BUSY";
}
export function withEnrollmentStoreLock<T>(
  dataDir: string,
  fn: () => T,
  options: {
    io?: Pick<
      typeof nativeFs,
      "mkdirSync" | "openSync" | "closeSync" | "writeFileSync" | "readFileSync" | "unlinkSync"
    >;
  } = {},
): T {
  const { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } =
    options.io ?? nativeFs;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "merchant-enrollments.lock"),
    token = randomUUID();
  let fd: number | undefined;
  const until = process.hrtime.bigint() + 1_000_000_000n;
  for (;;) {
    try {
      fd = openSync(file, "wx", 0o600);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      if (process.hrtime.bigint() >= until)
        throw new EnrollmentStoreBusy("Enrollment state is locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    closeSync(fd);
    fd = undefined;
    return fn();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Best-effort owned descriptor cleanup; retain the original lock/write failure. */
      }
    }
    try {
      const owner = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
      if (owner.token === token) unlinkSync(file);
    } catch {
      /* Unknown ownership is retained, never force removed. */
    }
  }
}

/** Durable effect claim for creating an enrollment. Unknown claims are never stolen. */
export function reserveEnrollmentCreation(
  dataDir: string,
  scope: string,
): { complete: () => void } {
  nativeFs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(scope).digest("hex");
  const file = path.join(dataDir, `enrollment-create-${name}.claim`);
  const token = randomUUID();
  let fd: number;
  try {
    fd = nativeFs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST")
      throw new EnrollmentStoreBusy("Unresolved enrollment creation");
    throw error;
  }
  try {
    nativeFs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, state: "unresolved" }));
    nativeFs.fsyncSync(fd);
  } finally {
    nativeFs.closeSync(fd);
  }
  return {
    complete: () => {
      const owner = JSON.parse(nativeFs.readFileSync(file, "utf8")) as { token?: string };
      if (owner.token === token) nativeFs.unlinkSync(file);
    },
  };
}
