/**
 * 组合锁候选预检（scripts/verify-portfolio-lock-candidate.mjs + lib）测试。
 *
 * 覆盖：合法临时 fixture 全链路通过；错误 SHA / 错误仓库 / HEAD 不匹配 /
 * contract digest 不匹配 / 缺文件与缺参数；consumer lock 查找路径安全
 * （不跟随 symlink、跳过 .git/node_modules）。全部离线：`git` 只做本地
 * init/commit/rev-parse，不访问网络。
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCK_FILENAME,
  PortfolioLockError,
  findConsumerLockFiles,
  gitHeadCommit,
  readConsumerLockFile,
  validateLock,
  verifyCentralLock,
  verifyConsumerHead,
  verifyConsumerLock,
  verifyManifestBundle,
  verifyPortfolioLockCandidate,
  type PortfolioLock,
} from "../scripts/lib/portfolio-lock-verify.mjs";

const SCRIPT = fileURLToPath(
  new URL("../scripts/verify-portfolio-lock-candidate.mjs", import.meta.url),
);

// 真实 kiwi contracts/manifest.json 的固定 bundle digest 与 contract source
// commit（CLI 级合法用例用它，因为 CLI 从自身位置读取真实 kiwi 根）。
const REAL_BUNDLE_SHA = "2350ecaacebb791cd980cc2886511359e356378a6f18cdecc1ac6331c31b0e70";
const REAL_SOURCE_COMMIT = "009bc25cdae2668c8fd19ccedcc4e0c64a34f6be";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

/** 创建带一个提交的本地 git 仓库，返回 HEAD commit。 */
function makeGitRepo(dir: string, content = "fixture"): string {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Kiwi Lock Test"]);
  writeFileSync(join(dir, "fixture.txt"), content);
  runGit(dir, ["add", "fixture.txt"]);
  runGit(dir, ["commit", "-q", "-m", "fixture commit"]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

/** 可变的 lock 候选（用于结构校验的负向用例）。 */
interface MutableRepositoryEntry {
  repository: string;
  commit: string;
}
interface MutableLock {
  lock_version: number;
  contract_bundle_sha256: string;
  contract_source_commit: string;
  repositories: Record<string, MutableRepositoryEntry>;
}

function buildMutableLock(
  f: {
    catalogHead?: string;
    shoppingHead?: string;
    bundleSha?: string;
    sourceCommit?: string;
    kiwiCommit?: string;
  } = {},
): MutableLock {
  return {
    lock_version: 1,
    contract_bundle_sha256: f.bundleSha ?? "e".repeat(64),
    contract_source_commit: f.sourceCommit ?? "f".repeat(40),
    repositories: {
      kiwi: {
        repository: "harrylabsj/kiwi",
        commit: f.kiwiCommit ?? "6105eff0bbed3d5344aee1e699969d6d19fb9a47",
      },
      "kiwi-catalog": {
        repository: "harrylabsj/kiwi-catalog",
        commit: f.catalogHead ?? "a".repeat(40),
      },
      "shopping-cli": {
        repository: "harrylabsj/shopping-cli",
        commit: f.shoppingHead ?? "b".repeat(40),
      },
    },
  };
}

/** 写入组合锁文件。 */
function writeLock(lock: unknown): string {
  const lockPath = join(makeTempDir(), "portfolio.lock.json");
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return lockPath;
}

/** 写入 kiwi contracts/manifest.json 与中央 kiwi-contracts.lock.json fixture。 */
function writeManifest(kiwiRoot: string, bundleSha: string, sourceCommit = REAL_SOURCE_COMMIT): void {
  mkdirSync(join(kiwiRoot, "contracts"), { recursive: true });
  writeFileSync(
    join(kiwiRoot, "contracts", "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 1,
        authority: "kiwi/contracts",
        bundle_sha256: bundleSha,
        contracts: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(kiwiRoot, "contracts", LOCK_FILENAME),
    JSON.stringify(
      {
        lock_version: 1,
        source_repository: "harrylabsj/kiwi",
        source_commit: sourceCommit,
        bundle_sha256: bundleSha,
        contracts_manifest: "contracts/manifest.json",
      },
      null,
      2,
    ),
  );
}

/** 在 consumer 目录内写入 kiwi-contracts.lock.json，返回其绝对路径。 */
function writeConsumerLock(
  consumerDir: string,
  sourceCommit: string,
  bundleSha: string,
  relDir = "pkg/contracts",
): string {
  const lockDir = join(consumerDir, relDir);
  mkdirSync(lockDir, { recursive: true });
  const file = join(lockDir, LOCK_FILENAME);
  writeFileSync(
    file,
    JSON.stringify(
      {
        lock_version: 1,
        source_repository: "harrylabsj/kiwi",
        source_commit: sourceCommit,
        bundle_sha256: bundleSha,
        contracts_manifest: "contracts/manifest.json",
      },
      null,
      2,
    ),
  );
  return file;
}

describe("validateLock（结构校验）", () => {
  it("接受 lock_version=1、三仓 allowlist、合法 SHA/hex 的候选", () => {
    expect(() => validateLock(buildMutableLock())).not.toThrow();
  });

  it("拒绝非 1 的 lock_version", () => {
    expect(() => validateLock({ ...buildMutableLock(), lock_version: 2 })).toThrow(/lock_version/);
  });

  it("拒绝非 64 位小写 hex 的 contract_bundle_sha256", () => {
    expect(() =>
      validateLock({ ...buildMutableLock(), contract_bundle_sha256: "XYZ".repeat(24) }),
    ).toThrow(/contract_bundle_sha256/);
    expect(() => validateLock({ ...buildMutableLock(), contract_bundle_sha256: "abcd" })).toThrow(
      /contract_bundle_sha256/,
    );
  });

  it("拒绝非 40 位小写 SHA 的 contract_source_commit", () => {
    expect(() =>
      validateLock({ ...buildMutableLock(), contract_source_commit: "ABCDEFGH".repeat(5) }),
    ).toThrow(/contract_source_commit/);
    expect(() => validateLock({ ...buildMutableLock(), contract_source_commit: "short" })).toThrow(
      /contract_source_commit/,
    );
  });

  it("拒绝 allowlist 之外的仓库 key", () => {
    const lock = buildMutableLock();
    lock.repositories["evil"] = { repository: "harrylabsj/evil", commit: "c".repeat(40) };
    expect(() => validateLock(lock)).toThrow(/disallowed repo key/);
  });

  it("拒绝缺少任一必需仓库", () => {
    const lock = buildMutableLock();
    delete lock.repositories["kiwi-catalog"];
    expect(() => validateLock(lock)).toThrow(/missing required repo/);
  });

  it("拒绝仓库名不在 allowlist 的条目", () => {
    const lock = buildMutableLock();
    lock.repositories["kiwi"] = { repository: "harrylabsj/evil", commit: "d".repeat(40) };
    expect(() => validateLock(lock)).toThrow(/repository must be/);
  });

  it("拒绝非 40 位小写 SHA 的 repository commit", () => {
    const lock = buildMutableLock();
    lock.repositories["shopping-cli"] = {
      repository: "harrylabsj/shopping-cli",
      commit: "SHORT",
    };
    expect(() => validateLock(lock)).toThrow(/commit must be/);
  });
});

describe("gitHeadCommit", () => {
  it("返回本地 checkout 的 HEAD 40 位小写 SHA", () => {
    const repo = makeTempDir();
    const head = makeGitRepo(repo);
    expect(gitHeadCommit(repo)).toBe(head);
  });

  it("非 git 目录 fail-closed（GIT_HEAD）", () => {
    const notARepo = makeTempDir();
    expect(() => gitHeadCommit(notARepo)).toThrow(PortfolioLockError);
    expect(() => gitHeadCommit(notARepo)).toThrow(/rev-parse HEAD/);
  });
});

describe("verifyManifestBundle", () => {
  it("manifest bundle_sha256 与组合锁一致时通过", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, REAL_BUNDLE_SHA);
    const lock = buildMutableLock({ bundleSha: REAL_BUNDLE_SHA }) as PortfolioLock;
    await expect(verifyManifestBundle(kiwiRoot, lock)).resolves.toBeUndefined();
  });

  it("contract digest 不匹配时 fail-closed（MANIFEST_BUNDLE_MISMATCH）", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, "f".repeat(64));
    const lock = buildMutableLock({ bundleSha: REAL_BUNDLE_SHA }) as PortfolioLock;
    const error = await verifyManifestBundle(kiwiRoot, lock).catch((err) => err);
    expect(error).toBeInstanceOf(PortfolioLockError);
    expect(error.code).toBe("MANIFEST_BUNDLE_MISMATCH");
    expect(error.message).toMatch(/does not match portfolio/);
  });

  it("manifest 缺失时 fail-closed（MANIFEST_READ）", async () => {
    const kiwiRoot = makeTempDir();
    const lock = buildMutableLock() as PortfolioLock;
    const error = await verifyManifestBundle(kiwiRoot, lock).catch((err) => err);
    expect(error.code).toBe("MANIFEST_READ");
  });
});

describe("verifyCentralLock", () => {
  it("中央锁 source_commit/bundle_sha256 与组合锁一致时通过", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, REAL_BUNDLE_SHA);
    const lock = buildMutableLock({
      bundleSha: REAL_BUNDLE_SHA,
      sourceCommit: REAL_SOURCE_COMMIT,
    }) as PortfolioLock;
    await expect(verifyCentralLock(kiwiRoot, lock)).resolves.toBeUndefined();
  });

  it("中央锁 source_commit 与组合锁不一致时 fail-closed（CENTRAL_SOURCE_COMMIT_MISMATCH）", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, REAL_BUNDLE_SHA, "a".repeat(40));
    const lock = buildMutableLock({
      bundleSha: REAL_BUNDLE_SHA,
      sourceCommit: REAL_SOURCE_COMMIT,
    }) as PortfolioLock;
    const error = await verifyCentralLock(kiwiRoot, lock).catch((err) => err);
    expect(error.code).toBe("CENTRAL_SOURCE_COMMIT_MISMATCH");
  });

  it("中央锁 bundle_sha256 与组合锁不一致时 fail-closed（CENTRAL_BUNDLE_MISMATCH）", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, "f".repeat(64));
    const lock = buildMutableLock({
      bundleSha: REAL_BUNDLE_SHA,
      sourceCommit: REAL_SOURCE_COMMIT,
    }) as PortfolioLock;
    const error = await verifyCentralLock(kiwiRoot, lock).catch((err) => err);
    expect(error.code).toBe("CENTRAL_BUNDLE_MISMATCH");
  });

  it("中央锁缺失时 fail-closed（CENTRAL_LOCK_READ）", async () => {
    const kiwiRoot = makeTempDir();
    mkdirSync(join(kiwiRoot, "contracts"), { recursive: true });
    writeFileSync(join(kiwiRoot, "contracts", "manifest.json"), "{}");
    const lock = buildMutableLock() as PortfolioLock;
    const error = await verifyCentralLock(kiwiRoot, lock).catch((err) => err);
    expect(error.code).toBe("CENTRAL_LOCK_READ");
  });

  it("中央锁非 40 位 source_commit fail-closed（CENTRAL_SOURCE_COMMIT_SHA）", async () => {
    const kiwiRoot = makeTempDir();
    mkdirSync(join(kiwiRoot, "contracts"), { recursive: true });
    writeFileSync(
      join(kiwiRoot, "contracts", LOCK_FILENAME),
      JSON.stringify({
        lock_version: 1,
        source_repository: "harrylabsj/kiwi",
        source_commit: "short",
        bundle_sha256: REAL_BUNDLE_SHA,
      }),
    );
    const lock = buildMutableLock({
      bundleSha: REAL_BUNDLE_SHA,
      sourceCommit: REAL_SOURCE_COMMIT,
    }) as PortfolioLock;
    const error = await verifyCentralLock(kiwiRoot, lock).catch((err) => err);
    expect(error.code).toBe("CENTRAL_SOURCE_COMMIT_SHA");
  });
});

describe("verifyConsumerHead", () => {
  it("HEAD 与 lock commit 一致时返回 HEAD", async () => {
    const consumer = makeTempDir();
    const head = makeGitRepo(consumer);
    const lock = buildMutableLock({ catalogHead: head }) as PortfolioLock;
    await expect(verifyConsumerHead(consumer, lock, "kiwi-catalog")).resolves.toBe(head);
  });

  it("HEAD 不匹配时 fail-closed（HEAD_MISMATCH）", async () => {
    const consumer = makeTempDir();
    makeGitRepo(consumer);
    const lock = buildMutableLock({ catalogHead: "1".repeat(40) }) as PortfolioLock;
    const error = await verifyConsumerHead(consumer, lock, "kiwi-catalog").catch((err) => err);
    expect(error).toBeInstanceOf(PortfolioLockError);
    expect(error.code).toBe("HEAD_MISMATCH");
    expect(error.message).toMatch(/does not match lock commit/);
  });

  it("目录不存在时 fail-closed（CONSUMER_READ）", async () => {
    const lock = buildMutableLock() as PortfolioLock;
    const error = await verifyConsumerHead(
      join(makeTempDir(), "missing"),
      lock,
      "kiwi-catalog",
    ).catch((err) => err);
    expect(error.code).toBe("CONSUMER_READ");
  });
});

describe("findConsumerLockFiles / 路径安全", () => {
  it("找到 consumer 内的 lock，跳过 .git 与 node_modules", async () => {
    const consumer = makeTempDir();
    makeGitRepo(consumer);
    const real = writeConsumerLock(consumer, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    const ignored = join(consumer, "node_modules", "dep", LOCK_FILENAME);
    mkdirSync(join(consumer, "node_modules", "dep"), { recursive: true });
    writeFileSync(ignored, "{}");

    const found = await findConsumerLockFiles(consumer);
    expect(found).toEqual([real]);
  });

  it("不跟随指向 consumer 目录外的 symlink（路径安全）", async () => {
    const consumer = makeTempDir();
    makeGitRepo(consumer);
    const outside = makeTempDir();
    const externalLock = join(outside, LOCK_FILENAME);
    writeFileSync(externalLock, JSON.stringify({ outside: true }));
    symlinkSync(outside, join(consumer, "external-link"));

    const found = await findConsumerLockFiles(consumer);
    expect(found).toEqual([]);
    expect(existsSync(externalLock)).toBe(true);
  });

  it("consumer 内无 lock 时 verifyConsumerLock fail-closed（CONSUMER_LOCK_MISSING）", async () => {
    const consumer = makeTempDir();
    makeGitRepo(consumer);
    const lock = buildMutableLock() as PortfolioLock;
    const error = await verifyConsumerLock(consumer, lock).catch((err) => err);
    expect(error.code).toBe("CONSUMER_LOCK_MISSING");
  });

  it("consumer lock 的 source_commit/bundle_sha256 与组合锁一致时通过", async () => {
    const consumer = makeTempDir();
    makeGitRepo(consumer);
    writeConsumerLock(consumer, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    const lock = buildMutableLock({
      bundleSha: REAL_BUNDLE_SHA,
      sourceCommit: REAL_SOURCE_COMMIT,
    }) as PortfolioLock;
    await expect(verifyConsumerLock(consumer, lock)).resolves.toEqual({ checked: 1 });
  });

  it("consumer lock 的 bundle_sha256 与组合锁不一致时 fail-closed", async () => {
    const consumer = makeTempDir();
    makeGitRepo(consumer);
    writeConsumerLock(consumer, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    const lock = buildMutableLock({
      bundleSha: "f".repeat(64),
      sourceCommit: REAL_SOURCE_COMMIT,
    }) as PortfolioLock;
    const error = await verifyConsumerLock(consumer, lock).catch((err) => err);
    expect(error.code).toBe("CONSUMER_BUNDLE_MISMATCH");
  });
});

describe("readConsumerLockFile", () => {
  it("解析合法 consumer lock", async () => {
    const consumer = makeTempDir();
    const file = writeConsumerLock(consumer, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    const parsed = await readConsumerLockFile(file);
    expect(parsed.source_commit).toBe(REAL_SOURCE_COMMIT);
    expect(parsed.bundle_sha256).toBe(REAL_BUNDLE_SHA);
  });

  it("非法 bundle_sha256 fail-closed（CONSUMER_BUNDLE_SHA）", async () => {
    const consumer = makeTempDir();
    const file = writeConsumerLock(consumer, REAL_SOURCE_COMMIT, "not-a-hex");
    const error = await readConsumerLockFile(file).catch((err) => err);
    expect(error.code).toBe("CONSUMER_BUNDLE_SHA");
  });
});

describe("verifyPortfolioLockCandidate（端到端）", () => {
  it("合法临时 fixture 全链路通过并输出固定摘要", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, REAL_BUNDLE_SHA);

    const catalog = makeTempDir();
    const shopping = makeTempDir();
    const catalogHead = makeGitRepo(catalog);
    const shoppingHead = makeGitRepo(shopping);
    writeConsumerLock(catalog, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    writeConsumerLock(shopping, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);

    const lockPath = writeLock(
      buildMutableLock({
        catalogHead,
        shoppingHead,
        bundleSha: REAL_BUNDLE_SHA,
        sourceCommit: REAL_SOURCE_COMMIT,
      }),
    );

    const lines = await verifyPortfolioLockCandidate({
      lockPath,
      kiwiCatalogDir: catalog,
      shoppingCliDir: shopping,
      kiwiRoot,
    });
    expect(lines[0]).toBe("portfolio lock candidate verified");
    expect(lines.join("\n")).toContain(`lock_version: 1`);
    expect(lines.join("\n")).toContain(`contract_bundle_sha256: ${REAL_BUNDLE_SHA}`);
    expect(lines.join("\n")).toContain(`kiwi-catalog HEAD: ${catalogHead}`);
    expect(lines.join("\n")).toContain(`shopping-cli HEAD: ${shoppingHead}`);
    expect(lines.join("\n")).toContain("kiwi contracts/manifest.json bundle_sha256: match");
    expect(lines.join("\n")).toContain(
      "kiwi contracts/kiwi-contracts.lock.json source_commit + bundle_sha256: match",
    );
  });

  it("HEAD 不匹配时 fail-closed（HEAD_MISMATCH）", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, REAL_BUNDLE_SHA);
    const catalog = makeTempDir();
    const shopping = makeTempDir();
    makeGitRepo(catalog);
    const shoppingHead = makeGitRepo(shopping);
    writeConsumerLock(catalog, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    writeConsumerLock(shopping, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);

    const lockPath = writeLock(
      buildMutableLock({
        catalogHead: "1".repeat(40),
        shoppingHead,
        bundleSha: REAL_BUNDLE_SHA,
        sourceCommit: REAL_SOURCE_COMMIT,
      }),
    );

    const error = await verifyPortfolioLockCandidate({
      lockPath,
      kiwiCatalogDir: catalog,
      shoppingCliDir: shopping,
      kiwiRoot,
    }).catch((err) => err);
    expect(error.code).toBe("HEAD_MISMATCH");
  });

  it("contract digest 不匹配时 fail-closed（MANIFEST_BUNDLE_MISMATCH）", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, "f".repeat(64));
    const lockPath = writeLock(
      buildMutableLock({
        bundleSha: REAL_BUNDLE_SHA,
        sourceCommit: REAL_SOURCE_COMMIT,
      }),
    );

    const error = await verifyPortfolioLockCandidate({
      lockPath,
      kiwiCatalogDir: makeTempDir(),
      shoppingCliDir: makeTempDir(),
      kiwiRoot,
    }).catch((err) => err);
    expect(error.code).toBe("MANIFEST_BUNDLE_MISMATCH");
  });

  it("中央锁 source_commit 漂移时 fail-closed（CENTRAL_SOURCE_COMMIT_MISMATCH）", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, REAL_BUNDLE_SHA, "a".repeat(40));
    const lockPath = writeLock(
      buildMutableLock({
        bundleSha: REAL_BUNDLE_SHA,
        sourceCommit: REAL_SOURCE_COMMIT,
      }),
    );

    const error = await verifyPortfolioLockCandidate({
      lockPath,
      kiwiCatalogDir: makeTempDir(),
      shoppingCliDir: makeTempDir(),
      kiwiRoot,
    }).catch((err) => err);
    expect(error.code).toBe("CENTRAL_SOURCE_COMMIT_MISMATCH");
  });

  it("consumer 缺 kiwi-contracts.lock.json 时 fail-closed", async () => {
    const kiwiRoot = makeTempDir();
    writeManifest(kiwiRoot, REAL_BUNDLE_SHA);
    const catalog = makeTempDir();
    const shopping = makeTempDir();
    const catalogHead = makeGitRepo(catalog);
    const shoppingHead = makeGitRepo(shopping);
    // shopping 有 lock，catalog 没有。
    writeConsumerLock(shopping, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);

    const lockPath = writeLock(
      buildMutableLock({
        catalogHead,
        shoppingHead,
        bundleSha: REAL_BUNDLE_SHA,
        sourceCommit: REAL_SOURCE_COMMIT,
      }),
    );

    const error = await verifyPortfolioLockCandidate({
      lockPath,
      kiwiCatalogDir: catalog,
      shoppingCliDir: shopping,
      kiwiRoot,
    }).catch((err) => err);
    expect(error.code).toBe("CONSUMER_LOCK_MISSING");
  });

  it("lock 文件缺失时 fail-closed（LOCK_READ）", async () => {
    const error = await verifyPortfolioLockCandidate({
      lockPath: join(makeTempDir(), "missing.json"),
      kiwiCatalogDir: makeTempDir(),
      shoppingCliDir: makeTempDir(),
      kiwiRoot: makeTempDir(),
    }).catch((err) => err);
    expect(error.code).toBe("LOCK_READ");
  });

  it("lock 文件非法 JSON 时 fail-closed（LOCK_PARSE）", async () => {
    const lockPath = join(makeTempDir(), "bad.json");
    writeFileSync(lockPath, "{ not json");
    const error = await verifyPortfolioLockCandidate({
      lockPath,
      kiwiCatalogDir: makeTempDir(),
      shoppingCliDir: makeTempDir(),
      kiwiRoot: makeTempDir(),
    }).catch((err) => err);
    expect(error.code).toBe("LOCK_PARSE");
  });
});

describe("CLI（scripts/verify-portfolio-lock-candidate.mjs）", () => {
  const runCli = (
    args: string[],
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

  it("--help 输出用法并退出 0", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: node scripts\/verify-portfolio-lock-candidate\.mjs/);
    expect(stdout).toMatch(/--kiwi-catalog-dir/);
    expect(stdout).toMatch(/--shopping-cli-dir/);
  });

  it("缺必填参数退出 2 并提示 missing required", () => {
    const { status, stderr } = runCli([]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/missing required --lock/);
  });

  it("未知参数退出 2", () => {
    const { status, stderr } = runCli(["--nope"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unknown argument/);
  });

  it("缺值参数退出 2", () => {
    const { status, stderr } = runCli(["--lock"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/missing value for --lock/);
  });

  it("合法 fixture 端到端退出 0 并输出固定摘要（CLI 使用真实 kiwi manifest）", () => {
    const catalog = makeTempDir();
    const shopping = makeTempDir();
    const catalogHead = makeGitRepo(catalog);
    const shoppingHead = makeGitRepo(shopping);
    writeConsumerLock(catalog, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    writeConsumerLock(shopping, REAL_SOURCE_COMMIT, REAL_BUNDLE_SHA);
    const lockPath = writeLock(
      buildMutableLock({
        catalogHead,
        shoppingHead,
        bundleSha: REAL_BUNDLE_SHA,
        sourceCommit: REAL_SOURCE_COMMIT,
      }),
    );

    const { status, stdout } = runCli([
      "--lock",
      lockPath,
      "--kiwi-catalog-dir",
      catalog,
      "--shopping-cli-dir",
      shopping,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("portfolio lock candidate verified");
    expect(stdout).toContain(`kiwi-catalog HEAD: ${catalogHead}`);
    expect(stdout).toContain(`shopping-cli HEAD: ${shoppingHead}`);
  });

  it("校验失败退出 1，且错误输出不泄露环境秘密", () => {
    const secret = "super-secret-env-value-987654";
    const result = runCli(
      [
        "--lock",
        join(makeTempDir(), "missing.json"),
        "--kiwi-catalog-dir",
        makeTempDir(),
        "--shopping-cli-dir",
        makeTempDir(),
      ],
      { PORTFOLIO_TEST_SECRET: secret },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/portfolio lock candidate verification failed/);
    expect(result.stderr).toMatch(/cannot read lock file/);
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
  });
});
