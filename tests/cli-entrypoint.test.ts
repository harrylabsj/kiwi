/**
 * Regression test for the packaged-CLI entrypoint guard: invoked through a
 * symlink (like npm's .bin shims), `kiwi --version` / `--help` must run
 * main; importing the module must have no side effects.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli.js";

const DIST_CLI = path.resolve(__dirname, "..", "dist", "cli.js");
const PRODUCT_VERSION = (JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8")) as { version: string }).version;

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
      expect(version.stdout).toBe(`kiwi ${PRODUCT_VERSION}\n`);

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
    expect(version.stdout).toBe(`kiwi ${PRODUCT_VERSION}\n`);
  });

  it("importing the CLI module has no side effects", async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    // Keep stderr outside this assertion: importing node:sqlite may emit an
    // ExperimentalWarning asynchronously, which is unrelated to CLI guards.
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

describe("parseArgs: weixin --a2a flag（审查 P2-L）", () => {
  it("--a2a 被解析（此前 Unknown argument: --a2a，exit 2）", () => {
    const parsed = parseArgs(["weixin", "--a2a", "--no-qr"]);
    expect(parsed.a2aExplicit).toBe(true);
    expect(parsed.noA2a).toBe(false);
  });

  it("默认不显式开启 A2A（weixin 文档承诺默认关）", () => {
    const parsed = parseArgs(["weixin"]);
    expect(parsed.a2aExplicit).toBe(false);
  });

  it("--no-a2a 仍可覆盖 --a2a", () => {
    const parsed = parseArgs(["weixin", "--a2a", "--no-a2a"]);
    expect(parsed.a2aExplicit).toBe(true);
    expect(parsed.noA2a).toBe(true);
  });
});
