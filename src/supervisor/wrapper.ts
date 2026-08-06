#!/usr/bin/env node
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
 * kiwi child-runner (internal; never invoked by users directly).
 *
 *   node wrapper.js --kiwi-nonce <hex> --manifest <path> --log <path> \
 *     --exit <path> -- <cmd> [args...]
 *
 * Responsibilities:
 * - spawn the exact child argv (array, never a shell string), piping its
 *   stdout/stderr into the instance-owned log file;
 * - forward SIGINT/SIGTERM to that exact child only;
 * - on child exit, write the exit record and exit with the child's code
 *   (or 128+signo), so up/status can see crashes.
 *
 * The nonce in argv lets status/down verify PID ownership with ps and makes
 * PID-reuse kills cryptographically improbable.
 */

import { spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";

interface WrapperArgs {
  nonce: string;
  manifest: string;
  log: string;
  exit: string;
  command: string[];
}

function parseArgs(argv: string[]): WrapperArgs | undefined {
  let nonce: string | undefined;
  let manifest: string | undefined;
  let log: string | undefined;
  let exit: string | undefined;
  let command: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--kiwi-nonce") nonce = argv[++i];
    else if (arg === "--manifest") manifest = argv[++i];
    else if (arg === "--log") log = argv[++i];
    else if (arg === "--exit") exit = argv[++i];
    else if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    } else return undefined;
  }
  if (!nonce || !manifest || !log || !exit || !command || command.length === 0) return undefined;
  return { nonce, manifest, log, exit, command };
}

function writeExitRecord(
  exitPath: string,
  record: { exit_code: number | null; signal: string | null; at: string },
): void {
  const tmp = `${exitPath}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, exitPath);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("kiwi child-runner: invalid arguments\n");
    process.exit(2);
  }

  const logFd = openSync(args.log, "a", 0o600);
  const child = spawn(args.command[0] as string, args.command.slice(1), {
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd); // the child holds its own descriptors now

  let exited = false;
  const forward = (signal: "SIGINT" | "SIGTERM"): void => {
    if (!exited) child.kill(signal);
  };
  // Signal handlers are installed before the ready marker is written, so a
  // supervisor that waits for readiness can never lose a signal.
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  child.on("error", (err) => {
    exited = true;
    writeExitRecord(args.exit, {
      exit_code: 1,
      signal: null,
      at: new Date().toISOString(),
    });
    process.stderr.write(
      `kiwi child-runner: failed to spawn ${args.command[0] ?? ""}: ${err.message}\n`,
    );
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    exited = true;
    writeExitRecord(args.exit, {
      exit_code: code,
      signal,
      at: new Date().toISOString(),
    });
    if (signal) {
      process.exit(128 + (signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1));
    }
    process.exit(code ?? 1);
  });

  // Ready marker: signal handlers are up and the child has been spawned.
  // The supervisor waits for this before it may signal us.
  writeExitRecord(`${args.manifest}.ready`, {
    exit_code: null,
    signal: null,
    at: new Date().toISOString(),
  });
}

main();
