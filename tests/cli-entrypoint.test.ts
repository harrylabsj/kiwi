/**
 * Regression test for the packaged-CLI entrypoint guard: invoked through a
 * symlink (like npm's .bin shims), `kiwi --version` / `--help` must run
 * main; importing the module must have no side effects.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIST_CLI = path.resolve(__dirname, "..", "dist", "cli.js");

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: String(e.stdout ?? "") };
  }
}

// dist/ is gitignored: on a fresh clone `npm test` runs without a build, so
// these packaged-entrypoint tests skip there. `npm run verify` builds first
// and always exercises them.
describe.skipIf(!existsSync(DIST_CLI))("CLI entrypoint guard", () => {
  it("--version and --help work through a symlinked bin (npm .bin shape)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-bin-"));
    try {
      // npm creates .bin/kiwi as a symlink to dist/cli.js.
      const binDir = path.join(dir, ".bin");
      mkdirSync(binDir);
      const link = path.join(binDir, "kiwi");
      symlinkSync(DIST_CLI, link);

      const version = run([link, "--version"]);
      expect(version.status).toBe(0);
      expect(version.stdout).toBe("kiwi 0.3.0\n");

      const help = run([link, "--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--version also works on the real path directly", () => {
    const version = run([DIST_CLI, "--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout).toBe("kiwi 0.3.0\n");
  });

  it("importing the CLI module has no side effects", async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = process.stdout.write;
    try {
      // Cache-busting query forces a fresh module evaluation; the guard must
      // keep main() from running because argv[1] is the test runner.
      const mod = (await import("../src/cli.js?entrypoint-side-effect-check" as string)) as {
        isInvokedAsScript: () => boolean;
      };
      expect(mod.isInvokedAsScript()).toBe(false);
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrWrite;
    }
    expect(writes).toEqual([]);
  });
});
