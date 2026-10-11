/**
 * supply-chain SBOM 生成守卫（scripts/verify-facade-supply-chain.mjs）测试。
 *
 * 背景（WP21）：package.json files 含 dist，但 dist 未构建时 npm pack 不报错，
 * 只会静默打出缺 dist 的小 tarball（57600 bytes），SBOM 因此描述了一个不完整
 * 的发布物。守卫要求：白名单目录缺失 → 打包前 fail；目录为空/被排除 → 打包后
 * fail；正常路径产出完整 SBOM。全部离线：fixture 不安装依赖，npm pack 只读
 * 本地文件。
 *
 * A432（2026-10-11）：受保护源 supply-chain.sbom.json 是源审计快照，正常核验
 * 默认只读（覆写会令 fullverify 后 assertSource 判源漂移，run104 实际冲突）；
 * 真实新鲜包证据写入派生输出 build/supply-chain.sbom.derived.json；源快照仅
 * owner 显式 --update-sbom 写候选。
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/verify-facade-supply-chain.mjs", import.meta.url),
);
const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-sbom-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 从真实 package-lock 取一条带 integrity 的锁定依赖（npm pack 不安装依赖，
// fixture 只要求锁里查得到 resolved + integrity，因此可完全离线）。
const realLock = JSON.parse(readFileSync(join(REAL_ROOT, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version: string; resolved: string; integrity: string }>;
};
const lockedEntry = Object.entries(realLock.packages).find(
  ([key, value]) => key.startsWith("node_modules/") && value.integrity !== undefined,
);
if (lockedEntry === undefined) {
  throw new Error("real package-lock.json has no locked dependency with integrity");
}
const fixtureDep = { name: lockedEntry[0].slice("node_modules/".length), meta: lockedEntry[1] };

interface FixtureOptions {
  distDirEmpty?: boolean;
  /** 预置已提交源 SBOM：fresh = 依赖面与 lock 一致；stale = 依赖面落后。 */
  seedSbom?: "fresh" | "stale";
  /** 变体：lock 条目缺 integrity，或 lock 为空（依赖未锁定）。 */
  lockMode?: "no-integrity" | "empty";
}

/** 建 fixture：files 只声明 dist；distEntries 为 dist 下的相对路径列表（空数组 = 不建 dist）。 */
function makeFixture(distEntries: string[], options: FixtureOptions = {}): string {
  const dir = makeTempDir();
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "kiwi-sbom-fixture",
        version: "0.0.1",
        files: ["dist"],
        dependencies: { [fixtureDep.name]: fixtureDep.meta.version },
      },
      null,
      2,
    )}\n`,
  );
  const lockedRow =
    options.lockMode === "no-integrity"
      ? { version: fixtureDep.meta.version, resolved: "https://registry.npmjs.org/x/-/x.tgz" }
      : fixtureDep.meta;
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "kiwi-sbom-fixture",
        version: "0.0.1",
        lockfileVersion: 3,
        packages:
          options.lockMode === "empty" ? {} : { [`node_modules/${fixtureDep.name}`]: lockedRow },
      },
      null,
      2,
    )}\n`,
  );
  if (options.distDirEmpty) mkdirSync(join(dir, "dist"));
  for (const rel of distEntries) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "// fixture\n");
  }
  if (options.seedSbom) {
    writeFileSync(
      join(dir, "supply-chain.sbom.json"),
      `${JSON.stringify(
        {
          sbom_version: 1,
          package: "kiwi-sbom-fixture",
          package_version: "0.0.1",
          runtime_dependencies: [
            {
              name: fixtureDep.name,
              spec: fixtureDep.meta.version,
              resolved: options.seedSbom === "stale" ? "0.0.0-stale" : fixtureDep.meta.version,
              integrity: fixtureDep.meta.integrity,
            },
          ],
          artifact: { name: "kiwi-sbom-fixture-0.0.1.tgz", sha256: "0".repeat(64), bytes: 1 },
          mcp_protocol_versions: ["2024-11-05", "2025-06-18", "2025-11-25"],
          generated_at: "2026-10-01T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}

function runScript(
  fixtureRoot: string,
  args: string[] = [],
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, KIWI_SUPPLY_CHAIN_ROOT: fixtureRoot },
  });
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

describe("verify-facade-supply-chain 完整性守卫", () => {
  it("dist 缺失 → 打包前 fail-closed，不产出 SBOM", () => {
    const dir = makeFixture([]);
    const result = runScript(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist");
    expect(existsSync(join(dir, "supply-chain.sbom.json"))).toBe(false);
  });

  it("dist 为空目录 → 打包后 fail-closed（tarball 里没有 dist 条目）", () => {
    const dir = makeFixture([], { distDirEmpty: true });
    const result = runScript(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("打包产物缺少 files 白名单目录：dist");
    expect(existsSync(join(dir, "supply-chain.sbom.json"))).toBe(false);
  });

  it("runtime dependency 缺 integrity → fail-closed，无任何写入", () => {
    const dir = makeFixture(["dist/index.js"], { lockMode: "no-integrity" });
    const result = runScript(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing integrity");
    expect(existsSync(join(dir, "build/supply-chain.sbom.derived.json"))).toBe(false);
  });

  it("运行时依赖未锁定（未知版本）→ fail-closed，无任何写入", () => {
    const dir = makeFixture(["dist/index.js"], { lockMode: "empty" });
    const result = runScript(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not locked in package-lock.json");
    expect(existsSync(join(dir, "build/supply-chain.sbom.derived.json"))).toBe(false);
  });

  it("未知参数 → fail-closed，源与派生零写入", () => {
    const dir = makeFixture(["dist/index.js"], { seedSbom: "fresh" });
    const before = readFileSync(join(dir, "supply-chain.sbom.json"), "utf8");
    const result = runScript(dir, ["--bogus"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未知参数");
    expect(readFileSync(join(dir, "supply-chain.sbom.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "build/supply-chain.sbom.derived.json"))).toBe(false);
  });

  it("默认核验只读：源 SBOM 字节不变，真实新鲜包证据写入派生输出", () => {
    const dir = makeFixture(["dist/index.js"], { seedSbom: "fresh" });
    const before = readFileSync(join(dir, "supply-chain.sbom.json"), "utf8");
    const result = runScript(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("source snapshot read-only");
    // 源审计快照逐字节不变（artifact 变化只提示）。
    expect(readFileSync(join(dir, "supply-chain.sbom.json"), "utf8")).toBe(before);
    const derived = JSON.parse(
      readFileSync(join(dir, "build/supply-chain.sbom.derived.json"), "utf8"),
    ) as {
      derived: boolean;
      runtime_dependencies: { resolved: string; integrity: string }[];
      artifact: { name: string; bytes: number; sha256: string };
    };
    expect(derived.derived).toBe(true);
    expect(derived.runtime_dependencies).toEqual([
      { name: fixtureDep.name, spec: fixtureDep.meta.version, resolved: fixtureDep.meta.version, integrity: fixtureDep.meta.integrity },
    ]);
    expect(derived.artifact.name).toBe("kiwi-sbom-fixture-0.0.1.tgz");
    expect(derived.artifact.bytes).toBeGreaterThan(0);
    expect(derived.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(derived.artifact.sha256).not.toBe("0".repeat(64));
  });

  it("依赖漂移 → 默认 fail-closed 且源快照不变，派生仍记录新鲜包", () => {
    const dir = makeFixture(["dist/index.js"], { seedSbom: "stale" });
    const stale = readFileSync(join(dir, "supply-chain.sbom.json"), "utf8");
    const result = runScript(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SBOM 依赖面与已提交版本不一致");
    expect(result.stderr).toContain("源审计快照未被修改");
    expect(readFileSync(join(dir, "supply-chain.sbom.json"), "utf8")).toBe(stale);
    const derived = JSON.parse(
      readFileSync(join(dir, "build/supply-chain.sbom.derived.json"), "utf8"),
    ) as { runtime_dependencies: { resolved: string }[] };
    expect(derived.runtime_dependencies[0]!.resolved).toBe(fixtureDep.meta.version);
  });

  it("owner 显式 --update-sbom → 候选写入源快照（漂移时提示审阅，不静默）", () => {
    const dir = makeFixture(["dist/index.js"], { seedSbom: "stale" });
    const result = runScript(dir, ["--update-sbom"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("候选已写入 supply-chain.sbom.json");
    expect(result.stdout).toContain("source candidate written");
    const updated = JSON.parse(readFileSync(join(dir, "supply-chain.sbom.json"), "utf8")) as {
      runtime_dependencies: { resolved: string }[];
      artifact: { sha256: string };
    };
    expect(updated.runtime_dependencies[0]!.resolved).toBe(fixtureDep.meta.version);
    expect(updated.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("包内容差异（模拟跨环境）只改变派生 artifact，不影响源快照", () => {
    const dir = makeFixture(["dist/index.js"], { seedSbom: "fresh" });
    expect(runScript(dir).status).toBe(0);
    const first = JSON.parse(
      readFileSync(join(dir, "build/supply-chain.sbom.derived.json"), "utf8"),
    ) as { artifact: { sha256: string } };
    const sourceBefore = readFileSync(join(dir, "supply-chain.sbom.json"), "utf8");
    writeFileSync(join(dir, "dist/index.js"), "// fixture variant B\n");
    const second = runScript(dir);
    expect(second.status).toBe(0);
    const derived = JSON.parse(
      readFileSync(join(dir, "build/supply-chain.sbom.derived.json"), "utf8"),
    ) as { artifact: { sha256: string } };
    expect(derived.artifact.sha256).not.toBe(first.artifact.sha256);
    expect(readFileSync(join(dir, "supply-chain.sbom.json"), "utf8")).toBe(sourceBefore);
  });
});
