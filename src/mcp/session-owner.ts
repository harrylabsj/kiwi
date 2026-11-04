/**
 * Buyer session ownership.
 *
 * `sessionId` is a display/namespace label and is NEVER sufficient to identify
 * a client. A host must allocate a per-client instance identity (`clientId`)
 * and persist it in host-owned storage, or supply a per-client token file.
 * Without a host identity this function returns an ephemeral owner: two default
 * clients cannot read each other's tasks, but they also cannot resume after a
 * restart (there is no trustworthy identity to recover).
 *
 * A token file must be non-empty and client-private; this is a local credential,
 * not remote authentication. Hosts such as DSH/Hermes/WorkBuddy/OpenClaw must
 * generate/persist clientId themselves.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SessionOwnerInput {
  dbPath?: string;
  principal: string;
  buyerAgentId: string;
  sessionId: string;
  /** Host-generated, host-persisted identity for this client instance. */
  clientId?: string;
  sessionToken?: string;
  sessionTokenFile?: string;
  tokenDir?: string;
}

function readTokenFile(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    // A concurrent creator may briefly hold the other link of the temp file;
    // the inode is already fully written and mode 0600, so this is safe.
    if (!st.isFile() || (st.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
      throw new Error("session token file is not private");
    }
    const token = readFileSync(fd, "utf8").trim();
    if (token === "") throw new Error("session token file is empty");
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("session token file does not exist");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readExplicitTokenFile(file: string): string {
  // Explicit token files retain value-format compatibility (any non-empty
  // token), but not insecure filesystem semantics: no symlink, private mode,
  // current owner, regular file. Only the 64-hex check is auto-file-specific.
  return readTokenFile(file);
}

function readAutoTokenFile(file: string): string {
  const token = readTokenFile(file);
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("session token file is corrupted");
  }
  return token;
}

function autoTokenFile(input: SessionOwnerInput): string {
  const key = createHash("sha256")
    .update(`${input.dbPath ?? ""}\u0000${input.principal}\u0000${input.buyerAgentId}\u0000${input.clientId ?? ""}\u0000${input.sessionId}`)
    .digest("hex");
  const dir = input.tokenDir ?? path.join(homedir(), ".kiwi", "mcp", "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
    throw new Error("session token directory is not private");
  }
  return path.join(dir, `${key}.token`);
}

function createTokenFileOnce(file: string): void {
  const token = randomBytes(32).toString("hex");
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, token, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    // link(2) publishes a fully written inode atomically. Readers can never
    // observe the winner's half-written file; only EEXIST means another
    // process won, in which case its complete file is read below.
    try {
      linkSync(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* already removed */ }
  }
}

export function resolveSessionOwner(input: SessionOwnerInput): string {
  let token = input.sessionToken?.trim() ?? "";
  if (token === "" && input.sessionTokenFile !== undefined) token = readExplicitTokenFile(input.sessionTokenFile);
  const clientId = input.clientId?.trim() ?? "";
  if (token === "" && clientId === "") {
    // Fail closed on identity: do not silently share a file keyed only by a
    // caller-controlled session label.
    return `ephemeral:${randomBytes(32).toString("hex")}`;
  }
  if (token === "") {
    const file = autoTokenFile(input);
    try {
      token = readAutoTokenFile(file);
    } catch (error) {
      if ((error as Error).message !== "session token file does not exist") throw error;
      createTokenFileOnce(file);
      token = readAutoTokenFile(file);
    }
  }
  const identity = `${input.principal}\u0000${input.buyerAgentId}\u0000${clientId}\u0000${input.sessionId}`;
  return createHmac("sha256", token).update(identity).digest("hex");
}
