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
 * `kiwi locks` —— 残留锁的只读盘点与显式恢复（review P1-4/P1-8）。
 *
 * 独立 flag 集（不经全局 parseArgs）：
 *
 *   kiwi locks list --data-dir <dir>
 *   kiwi locks recover-ledger --data-dir <dir> --negotiation-id <id> [--force]
 *   kiwi locks recover-enrollment --data-dir <dir> [--claim <file>] [--force]
 *
 * 自动接管仍由 `canTakeOverStaleLock` 判定；跨 host / 不可证明时恢复命令
 * 拒绝执行，必须由运营者显式加 `--force`。输出 JSON 便于审计留档。
 */
import { EXIT } from "../exit-codes.js";
import { listLocks, recoverEnrollmentLocks, recoverLedgerLock } from "./locks.js";

const USAGE = `usage:
  kiwi locks list --data-dir <dir>
  kiwi locks recover-ledger --data-dir <dir> --negotiation-id <id> [--force]
  kiwi locks recover-enrollment --data-dir <dir> [--claim <enrollment-create-...claim>] [--force]
`;

export interface LocksCommandOptions {
  argv: string[];
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function parseFlags(argv: string[]): Map<string, string | boolean> | undefined {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) return undefined;
    const name = arg.slice(2);
    if (name === "force") {
      flags.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

export function runLocksCommand(options: LocksCommandOptions): number {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const [sub, ...rest] = options.argv;
  const flags = parseFlags(rest);
  const dataDir = flags?.get("data-dir");
  if (sub === undefined || flags === undefined || typeof dataDir !== "string" || dataDir === "") {
    stderr(USAGE);
    return EXIT.CONFIG;
  }
  if (sub === "list") {
    stdout(`${JSON.stringify({ ok: true, data_dir: dataDir, locks: listLocks(dataDir) }, null, 2)}\n`);
    return EXIT.OK;
  }
  if (sub === "recover-ledger") {
    const negotiationId = flags.get("negotiation-id");
    if (typeof negotiationId !== "string" || negotiationId === "") {
      stderr("--negotiation-id is required\n");
      return EXIT.CONFIG;
    }
    const result = recoverLedgerLock(dataDir, negotiationId, {
      force: flags.get("force") === true,
    });
    stdout(`${JSON.stringify({ ok: result.refused.length === 0, ...result }, null, 2)}\n`);
    return result.refused.length === 0 ? EXIT.OK : EXIT.TRANSIENT;
  }
  if (sub === "recover-enrollment") {
    const claim = flags.get("claim");
    const result = recoverEnrollmentLocks(dataDir, {
      force: flags.get("force") === true,
      ...(typeof claim === "string" ? { claimName: claim } : {}),
    });
    stdout(`${JSON.stringify({ ok: result.refused.length === 0, ...result }, null, 2)}\n`);
    return result.refused.length === 0 ? EXIT.OK : EXIT.TRANSIENT;
  }
  stderr(USAGE);
  return EXIT.CONFIG;
}
