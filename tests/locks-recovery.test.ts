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
 * review P1-4/P1-8：跨 host / 不可证明残留锁的显式恢复出口。
 *
 * 自动接管仍只发生在同 host 且可证明持有者已死；这里的命令是运营者的
 * 显式出口——默认拒绝跨 host 锁，必须 --force。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerFileName } from "../src/negotiation/ledger/store.js";
import {
  listLocks,
  recoverEnrollmentLocks,
  recoverLedgerLock,
} from "../src/runtime/locks.js";
import { runLocksCommand } from "../src/runtime/locks-cli.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-locks-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledgerPaths(dataDir: string, negotiationId: string) {
  const main = path.join(dataDir, "ledger", `${ledgerFileName(negotiationId)}.lock`);
  return { main, guard: `${main}.guard` };
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("could not spawn a dead-pid fixture");
  return child.pid;
}

function writeOwner(
  file: string,
  owner: { pid: number; host: string; boot_id?: string; token?: string },
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ token: "owner-token", ...owner }));
}

describe("residual lock inspection and explicit recovery", () => {
  it("lists dead same-host ledger locks and live/foreign ones distinctly", () => {
    const dir = temp();
    const paths = ledgerPaths(dir, "neg-1");
    writeOwner(paths.main, { pid: deadPid(), host: hostname(), boot_id: "old-boot" });
    const foreign = path.join(dir, "ledger", "other.lock");
    writeOwner(foreign, { pid: 1, host: "another-host.example" });

    const locks = listLocks(dir);
    expect(locks).toHaveLength(2);
    const dead = locks.find((lock) => lock.path === paths.main);
    const remote = locks.find((lock) => lock.path === foreign);
    expect(dead?.autoRecoverable).toBe(true);
    expect(dead?.kind).toBe("ledger");
    expect(remote?.autoRecoverable).toBe(false);
    expect(remote?.owner?.host).toBe("another-host.example");
  });

  it("removes provably dead same-host locks without --force", () => {
    const dir = temp();
    const paths = ledgerPaths(dir, "neg-2");
    writeOwner(paths.main, { pid: deadPid(), host: hostname(), boot_id: "old-boot" });
    writeOwner(paths.guard, { pid: deadPid(), host: hostname(), boot_id: "old-boot" });

    const result = recoverLedgerLock(dir, "neg-2");
    expect(result.refused).toEqual([]);
    expect(result.removed.sort()).toEqual([paths.guard, paths.main].sort());
    expect(existsSync(paths.main)).toBe(false);
    expect(existsSync(paths.guard)).toBe(false);
  });

  it("refuses a live or foreign-host lock unless --force is explicit", () => {
    const dir = temp();
    const paths = ledgerPaths(dir, "neg-3");
    writeOwner(paths.main, { pid: process.pid, host: hostname() });

    const refused = recoverLedgerLock(dir, "neg-3");
    expect(refused.removed).toEqual([]);
    expect(refused.refused).toHaveLength(1);
    expect(existsSync(paths.main)).toBe(true);

    const forced = recoverLedgerLock(dir, "neg-3", { force: true });
    expect(forced.removed).toEqual([paths.main]);
    expect(existsSync(paths.main)).toBe(false);
  });

  it("recovers enrollment store locks and validates claim names", () => {
    const dir = temp();
    const lock = path.join(dir, "merchant-enrollments.lock");
    writeOwner(lock, { pid: 1, host: "another-host.example" });

    const refused = recoverEnrollmentLocks(dir);
    expect(refused.removed).toEqual([]);
    expect(refused.refused).toHaveLength(1);

    const forced = recoverEnrollmentLocks(dir, { force: true });
    expect(forced.removed).toEqual([lock]);

    const traversal = recoverEnrollmentLocks(dir, { claimName: "../escape.claim" });
    expect(traversal.removed).toEqual([]);
    expect(traversal.refused[0]?.reason).toContain("enrollment-create");

    const claim = `enrollment-create-${"a".repeat(64)}.claim`;
    writeFileSync(path.join(dir, claim), JSON.stringify({ token: "t", pid: 1, state: "unresolved" }));
    const claimRecovery = recoverEnrollmentLocks(dir, { claimName: claim, force: true });
    expect(claimRecovery.removed).toEqual([path.join(dir, claim)]);
  });

  it("CLI list prints JSON and recovery exit code reflects refusals", () => {
    const dir = temp();
    const paths = ledgerPaths(dir, "neg-4");
    writeOwner(paths.main, { pid: 1, host: "another-host.example" });
    let output = "";
    const listCode = runLocksCommand({
      argv: ["list", "--data-dir", dir],
      stdout: (text) => {
        output += text;
      },
      stderr: () => undefined,
    });
    expect(listCode).toBe(0);
    expect(JSON.parse(output).locks).toHaveLength(1);

    const refusedCode = runLocksCommand({
      argv: ["recover-ledger", "--data-dir", dir, "--negotiation-id", "neg-4"],
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(refusedCode).toBe(10);

    const forcedCode = runLocksCommand({
      argv: ["recover-ledger", "--data-dir", dir, "--negotiation-id", "neg-4", "--force"],
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(forcedCode).toBe(0);
  });
});
