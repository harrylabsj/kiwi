/**
 * supply-chain SBOM 生成守卫（scripts/verify-facade-supply-chain.mjs）测试。
 *
 * 背景（WP21）：package.json files 含 dist，但 dist 未构建时 npm pack 不报错，
 * 只会静默打出缺 dist 的小 tarball（57600 bytes），SBOM 因此描述了一个不完整
 * 的发布物。守卫要求：白名单目录缺失 → 打包前 fail；目录为空/被排除 → 打包后
 * fail；正常路径产出完整 SBOM。全部离线：fixture 不安装依赖，npm pack 只读
 * 本地文件。
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

/** 建 fixture：files 只声明 dist；distEntries 为 dist 下的相对路径列表（空数组 = 不建 dist）。 */
function makeFixture(distEntries: string[], distDirEmpty = false): string {
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
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "kiwi-sbom-fixture",
        version: "0.0.1",
        lockfileVersion: 3,
        packages: { [`node_modules/${fixtureDep.name}`]: fixtureDep.meta },
      },
      null,
      2,
    )}\n`,
  );
  if (distDirEmpty) mkdirSync(join(dir, "dist"));
  for (const rel of distEntries) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "// fixture\n");
  }
  return dir;
}

function runScript(fixtureRoot: string): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
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
    const dir = makeFixture([], true);
    const result = runScript(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("打包产物缺少 files 白名单目录：dist");
    expect(existsSync(join(dir, "supply-chain.sbom.json"))).toBe(false);
  });

  it("dist 有产物 → 通过，SBOM 记录完整 artifact 与依赖 integrity", () => {
    const dir = makeFixture(["dist/index.js"]);
    const result = runScript(dir);
    expect(result.status).toBe(0);
    const sbom = JSON.parse(readFileSync(join(dir, "supply-chain.sbom.json"), "utf8")) as {
      package: string;
      package_version: string;
      runtime_dependencies: { name: string; resolved: string; integrity: string }[];
      artifact: { name: string; bytes: number; sha256: string };
    };
    expect(sbom.package).toBe("kiwi-sbom-fixture");
    expect(sbom.package_version).toBe("0.0.1");
    expect(sbom.runtime_dependencies).toEqual([
      { name: fixtureDep.name, spec: fixtureDep.meta.version, resolved: fixtureDep.meta.version, integrity: fixtureDep.meta.integrity },
    ]);
    expect(sbom.artifact.name).toBe("kiwi-sbom-fixture-0.0.1.tgz");
    expect(sbom.artifact.bytes).toBeGreaterThan(0);
    expect(sbom.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
