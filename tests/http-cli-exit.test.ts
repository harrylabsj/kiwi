import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runHttpServe } from "../src/http/cli.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-http-exit-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HTTP CLI configuration exit codes", () => {
  it("whitespace auth token is a config error, not transient", async () => {
    expect(await runHttpServe(["--db", path.join(tempDir(), "state.sqlite"), "--auth-token", "   "])).toBe(2);
  });

  it("missing auth token is a config error", async () => {
    expect(await runHttpServe(["--db", path.join(tempDir(), "state.sqlite")])).toBe(2);
  });

  it("permissive session token file via CLI flag is a config error", async () => {
    const dir = tempDir();
    const tokenFile = path.join(dir, "flag-token");
    writeFileSync(tokenFile, "synthetic-token", { mode: 0o644 });
    chmodSync(tokenFile, 0o644);
    expect(await runHttpServe([
      "--db", path.join(dir, "flag.sqlite"),
      "--auth-token", "synthetic-auth",
      "--session-token-file", tokenFile,
    ])).toBe(2);
  });

  it("permissive session token file is a config error", async () => {
    const dir = tempDir();
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "synthetic-token", { mode: 0o644 });
    chmodSync(tokenFile, 0o644);
    const old = process.env.KIWI_SESSION_TOKEN_FILE;
    process.env.KIWI_SESSION_TOKEN_FILE = tokenFile;
    try {
      expect(await runHttpServe(["--db", path.join(dir, "state.sqlite"), "--auth-token", "synthetic-auth"])).toBe(2);
    } finally {
      if (old === undefined) delete process.env.KIWI_SESSION_TOKEN_FILE;
      else process.env.KIWI_SESSION_TOKEN_FILE = old;
    }
  });
});
