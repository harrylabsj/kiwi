/**
 * Release manifest 验证 + rollback drill 离线链路 characterization tests。
 *
 * 覆盖（全部离线，临时目录 + process.execPath 子进程，不访问网络/registry，
 * 不调用 git）：
 * - 生成两个最小合法 release 目录（artifact 文件 + SHA256SUMS +
 *   kiwi.portfolio.release-manifest.v1 manifest），scripts/verify-release-manifest.mjs
 *   各自验证成功；
 * - 篡改 artifact / manifest / SHA256SUMS 后 verifier fail-closed；
 * - scripts/rollback-drill.mjs 对 previous/current/state 的 `active`（previous）与
 *   `active.restore`（current）symlink 都指向正确目录；
 * - 路径穿越 / 未绑定 SHA 条目 / 非法 SHA256SUMS 行失败（如现有 verifier 覆盖）。
 *
 * SHA256SUMS 使用 sha256sum 输出同构的 `<64hex>  <path>`（双空格）格式，与
 * `.github/workflows/portfolio-release.yml` 的生成方式一致。
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERIFIER = fileURLToPath(new URL("../scripts/verify-release-manifest.mjs", import.meta.url));
const DRILL = fileURLToPath(new URL("../scripts/rollback-drill.mjs", import.meta.url));

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-release-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface ReleaseFile {
  /** Release-root 相对路径（正斜杠，与 SHA256SUMS/manifest 一致）。 */
  path: string;
  content: string;
}

interface ReleaseManifestFile {
  path: string;
  sha256: string;
}

/** 写一行 SHA256SUMS（sha256sum 文本模式输出同构：`<64hex>  <path>` 双空格）。 */
function sumsLine(path: string, content: string): string {
  return `${sha256Hex(content)}  ${path}`;
}

function writeSha256Sums(root: string, lines: string[]): void {
  writeFileSync(join(root, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function writeReleaseManifest(root: string, files: ReleaseManifestFile[]): void {
  writeFileSync(
    join(root, "release-manifest.json"),
    `${JSON.stringify(
      {
        schema: "kiwi.portfolio.release-manifest.v1",
        contract_source_commit: "a".repeat(40),
        files,
      },
      null,
      2,
    )}\n`,
  );
}

function readReleaseManifest(root: string): { files: ReleaseManifestFile[] } {
  return JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")) as {
    files: ReleaseManifestFile[];
  };
}

/**
 * 构建一个最小合法 release 目录：artifact 文件 + SHA256SUMS + release-manifest.json。
 * SHA256SUMS 与 manifest.files 完全绑定（与 workflow 生成顺序一致：先 SUM 后 manifest，
 * 均不包含自身）。返回 release 目录根。
 */
function writeMinimalRelease(root: string, files: ReleaseFile[]): string {
  mkdirSync(root, { recursive: true });
  for (const file of files) {
    const abs = join(root, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
  }
  writeSha256Sums(root, files.map((f) => sumsLine(f.path, f.content)).sort());
  writeReleaseManifest(root, files.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) })));
  return root;
}

function runVerifier(releaseDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [VERIFIER, releaseDir], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runDrill(
  previous: string,
  current: string,
  state: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [DRILL, previous, current, state], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("verify-release-manifest.mjs（最小合法 release）", () => {
  it("两个最小合法 release 目录都验证成功并输出固定摘要", () => {
    const releases = [
      writeMinimalRelease(makeTempDir(), [
        { path: "npm/kiwi-0.6.0.tgz", content: "previous release artifact" },
      ]),
      writeMinimalRelease(makeTempDir(), [
        { path: "npm/kiwi-0.7.0.tgz", content: "current release artifact" },
      ]),
    ];

    for (const release of releases) {
      const { status, stdout, stderr } = runVerifier(release);
      expect(status).toBe(0);
      expect(stdout).toContain("release manifest verified: 1 files");
      expect(stderr).toBe("");
    }
  });

  it("多 artifact 且 SHA256SUMS 顺序无关时仍验证成功", () => {
    const release = writeMinimalRelease(makeTempDir(), [
      { path: "kiwi-catalog/kiwi_catalog-0.1.0-py3-none-any.whl", content: "catalog wheel" },
      { path: "shopping-cli/shopping_cli-3.0.1.tar.gz", content: "shopping sdist" },
      { path: "sbom/kiwi.spdx.json", content: "spdx sbom" },
    ]);
    const { status, stdout } = runVerifier(release);
    expect(status).toBe(0);
    expect(stdout).toContain("release manifest verified: 3 files");
  });
});

describe("verify-release-manifest.mjs（篡改 fail-closed）", () => {
  it("篡改 artifact 内容后 digest 不匹配，verifier 退出 1", () => {
    const release = writeMinimalRelease(makeTempDir(), [
      { path: "npm/kiwi-0.6.0.tgz", content: "original bytes" },
    ]);
    writeFileSync(join(release, "npm", "kiwi-0.6.0.tgz"), "tampered bytes");

    const { status, stderr } = runVerifier(release);
    expect(status).toBe(1);
    expect(stderr).toMatch(/npm\/kiwi-0\.6\.0\.tgz digest [a-f0-9]{64} != [a-f0-9]{64}/);
  });

  it("篡改 manifest 中记录的 sha256 后 manifest/SHA256SUMS 不匹配，退出 1", () => {
    const release = writeMinimalRelease(makeTempDir(), [
      { path: "npm/kiwi-0.6.0.tgz", content: "original bytes" },
    ]);
    const manifest = readReleaseManifest(release);
    expect(manifest.files).toHaveLength(1);
    manifest.files[0]!.sha256 = "0".repeat(64);
    writeReleaseManifest(release, manifest.files);

    const { status, stderr } = runVerifier(release);
    expect(status).toBe(1);
    expect(stderr).toContain("manifest/SHA256SUMS mismatch for npm/kiwi-0.6.0.tgz");
  });

  it("篡改 SHA256SUMS 中记录的 hash 后 manifest/SHA256SUMS 不匹配，退出 1", () => {
    const release = writeMinimalRelease(makeTempDir(), [
      { path: "npm/kiwi-0.6.0.tgz", content: "original bytes" },
    ]);
    writeSha256Sums(release, [`${"0".repeat(64)}  npm/kiwi-0.6.0.tgz`]);

    const { status, stderr } = runVerifier(release);
    expect(status).toBe(1);
    expect(stderr).toContain("manifest/SHA256SUMS mismatch for npm/kiwi-0.6.0.tgz");
  });
});

describe("verify-release-manifest.mjs（路径安全 / 条目一致性）", () => {
  it("manifest 条目路径穿越 release 目录时 fail-closed", () => {
    const release = makeTempDir();
    writeSha256Sums(release, [sumsLine("../escape.txt", "escape content")]);
    writeReleaseManifest(release, [{ path: "../escape.txt", sha256: sha256Hex("escape content") }]);

    const { status, stderr } = runVerifier(release);
    expect(status).toBe(1);
    expect(stderr).toContain("path escapes release directory: ../escape.txt");
  });

  it("SHA256SUMS 含未绑定条目（不在 manifest.files）时 fail-closed", () => {
    const release = writeMinimalRelease(makeTempDir(), [
      { path: "artifact.bin", content: "bound artifact" },
    ]);
    const sums = readFileSync(join(release, "SHA256SUMS"), "utf8");
    writeSha256Sums(release, [...sums.trim().split("\n"), sumsLine("stray.bin", "stray")]);

    const { status, stderr } = runVerifier(release);
    expect(status).toBe(1);
    expect(stderr).toContain("SHA256SUMS contains an unbound file: stray.bin");
  });

  it("非法 SHA256SUMS 行 fail-closed", () => {
    const release = makeTempDir();
    writeSha256Sums(release, ["not a valid sums line"]);
    writeReleaseManifest(release, [{ path: "artifact.bin", sha256: "0".repeat(64) }]);

    const { status, stderr } = runVerifier(release);
    expect(status).toBe(1);
    expect(stderr).toContain("invalid SHA256SUMS line: not a valid sums line");
  });
});

describe("rollback-drill.mjs（previous → active / current → active.restore）", () => {
  it("对合法 previous/current 激活 previous，并把 current 恢复为 active.restore", () => {
    const previous = writeMinimalRelease(makeTempDir(), [
      { path: "npm/kiwi-0.6.0.tgz", content: "previous release artifact" },
    ]);
    const current = writeMinimalRelease(makeTempDir(), [
      { path: "npm/kiwi-0.7.0.tgz", content: "current release artifact" },
    ]);
    const state = join(makeTempDir(), "state");

    const { status, stdout } = runDrill(previous, current, state);
    expect(status).toBe(0);
    expect(stdout).toContain("rollback drill: previous release activated");
    expect(stdout).toContain("rollback drill: current release restored");

    const active = join(state, "active");
    const restore = join(state, "active.restore");
    expect(lstatSync(active).isSymbolicLink()).toBe(true);
    expect(realpathSync(active)).toBe(realpathSync(previous));
    expect(lstatSync(restore).isSymbolicLink()).toBe(true);
    expect(realpathSync(restore)).toBe(realpathSync(current));
    // 两者必须指向不同目录，避免恢复与回滚互相覆盖。
    expect(realpathSync(previous)).not.toBe(realpathSync(current));
  });

  it("previous 不可验证时 fail-closed，且不创建 state 目录", () => {
    const previous = writeMinimalRelease(makeTempDir(), [
      { path: "artifact.bin", content: "previous" },
    ]);
    writeFileSync(join(previous, "artifact.bin"), "tampered previous");
    const current = writeMinimalRelease(makeTempDir(), [{ path: "artifact.bin", content: "current" }]);
    const state = join(makeTempDir(), "state");

    const { status, stderr } = runDrill(previous, current, state);
    expect(status).toBe(1);
    expect(stderr).toContain("rollback drill stopped: previous release is not verifiable");
    expect(existsSync(state)).toBe(false);
  });

  it("state 目录已存在 active 时拒绝，绝不覆盖", () => {
    const previous = writeMinimalRelease(makeTempDir(), [
      { path: "artifact.bin", content: "previous" },
    ]);
    const current = writeMinimalRelease(makeTempDir(), [{ path: "artifact.bin", content: "current" }]);
    const state = makeTempDir();
    writeFileSync(join(state, "active"), "existing marker");

    const { status, stderr } = runDrill(previous, current, state);
    expect(status).toBe(1);
    expect(stderr).toContain("rollback drill requires a new state directory");
    expect(readFileSync(join(state, "active"), "utf8")).toBe("existing marker");
  });
});
