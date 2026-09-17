/**
 * deploy/merchant-bundle 安装器测试（V2 阶段一；BUG-09 修订）：
 * - 新实例必须显式 --confirm-new-instance；
 * - 已有安装（data 非空 / state.sqlite）拒绝，绝不新建空库替代；
 * - shopping-cli 版本低于兼容范围（>= 2.0.0）拒绝；
 * - BUG-09：缺 --profile / profile 非 merchant / 应用包缺 dist 或 node_modules
 *   / 凭据引用缺失 → 一律拒绝（不产出"装完却起不来"的实例）；
 * - 成功安装产出：目录布局 + 可运行应用（app/dist/cli.js + node_modules）+
 *   profile + 实例凭据引用 + 服务单元（--profile/--data-dir、shopping 托管
 *   单元与依赖关系）+ preflight 全过 + install.json；
 * - versions.lock.json 与 src/product-compat.ts 单一来源防漂移。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SHOPPING_CLI_COMPAT, compatRangeText } from "../src/product-compat.js";

const SCRIPT = path.resolve(__dirname, "../deploy/merchant-bundle/install.mjs");
const LOCK = path.resolve(__dirname, "../deploy/merchant-bundle/versions.lock.json");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "kiwi-bundle-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

/** 假 shopping 可执行文件（打印给定版本）。 */
function fakeShoppingBin(version: string): string {
  const dir = tmp();
  const bin = path.join(dir, "shopping");
  writeFileSync(bin, `#!/bin/sh\necho "shopping-cli ${version}"\n`, { mode: 0o755 });
  return bin;
}

/** BUG-09：假应用包（dist/cli.js 真可执行——`node cli.js --version` 输出版本）。 */
function fakeAppDir(version = "0.0.0-test"): string {
  const dir = tmp();
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    path.join(dir, "dist", "cli.js"),
    `if (process.argv.includes("--version")) console.log("kiwi ${version}");\n`,
  );
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "kiwi", version }));
  writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), "{}");
  return dir;
}

/** BUG-09：merchant profile（安装器轻量校验：role: merchant + agent_id）。 */
function fakeProfile(): string {
  const dir = tmp();
  const file = path.join(dir, "merchant.yaml");
  writeFileSync(
    file,
    [
      "runtime_version: '0.5.0'",
      "agent_id: merchant-agent:merchant-001",
      "role: merchant",
      "owner_id: merchant-001",
      "commerce:",
      "  base_url: http://127.0.0.1:8765",
      "  token_env: SHOPPING_AGENT_TOKEN",
      "  backend: local_marketplace",
      "",
    ].join("\n"),
  );
  return file;
}

/** 实例凭据引用文件（值不参与断言；token_env 名与 tests/helpers.ts profile 一致）。 */
function fakeCredentialsEnv(): string {
  const dir = tmp();
  const file = path.join(dir, "credentials.env");
  writeFileSync(file, "KIWI_MERCHANT_TOKEN=test-token\nSHOPPING_AGENT_TOKEN=test-engine-token\n");
  return file;
}

interface RunOptions {
  envHome?: string;
}

function run(args: string[], options: RunOptions = {}): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  if (options.envHome !== undefined) env.HOME = options.envHome;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

/** 基础合法参数（各测试再叠加/覆盖）。 */
function baseArgs(prefix: string): string[] {
  return [
    "--prefix",
    prefix,
    "--confirm-new-instance",
    "--profile",
    fakeProfile(),
    "--app-dir",
    fakeAppDir(),
    "--shopping-bin",
    fakeShoppingBin("2.1.0"),
    "--credentials-env",
    fakeCredentialsEnv(),
  ];
}

describe("deploy/merchant-bundle install.mjs", () => {
  it("缺 --confirm-new-instance 拒绝新实例安装", () => {
    const r = run(["--prefix", path.join(tmp(), "inst"), "--shopping-bin", fakeShoppingBin("2.1.0"), "--profile", fakeProfile()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--confirm-new-instance");
  });

  it("shopping-cli 版本低于兼容范围拒绝（版本锁 fail-closed）", () => {
    const tooOld = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--profile",
      fakeProfile(),
      "--app-dir",
      fakeAppDir(),
      "--shopping-bin",
      fakeShoppingBin("1.9.9"),
    ]);
    expect(tooOld.status).toBe(1);
    expect(tooOld.stderr).toContain("1.9.9");
    expect(tooOld.stderr).toContain(">= 2.0.0");

    const missing = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--profile",
      fakeProfile(),
      "--app-dir",
      fakeAppDir(),
      "--shopping-bin",
      path.join(tmp(), "no-such-bin"),
    ]);
    expect(missing.status).toBe(1);
  });

  it("BUG-09：缺 --profile 拒绝；profile 非 merchant 拒绝", () => {
    const noProfile = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(noProfile.status).toBe(1);
    expect(noProfile.stderr).toContain("--profile");

    const dir = tmp();
    const buyerProfile = path.join(dir, "buyer.yaml");
    writeFileSync(buyerProfile, "role: buyer\nagent_id: buyer-agent:buyer-001\n");
    const wrongRole = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--profile",
      buyerProfile,
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(wrongRole.status).toBe(1);
    expect(wrongRole.stderr).toContain("merchant");
  });

  it("BUG-09：应用包缺 dist/cli.js 或缺 node_modules 拒绝（裸 dist 不可运行）", () => {
    const bareApp = tmp();
    mkdirSync(path.join(bareApp, "dist"), { recursive: true });
    writeFileSync(path.join(bareApp, "dist", "cli.js"), "console.log('kiwi 0.0.0');");
    writeFileSync(path.join(bareApp, "package.json"), JSON.stringify({ name: "kiwi", version: "0.0.0" }));
    const missingNodeModules = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--profile",
      fakeProfile(),
      "--app-dir",
      bareApp,
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(missingNodeModules.status).toBe(1);
    expect(missingNodeModules.stderr).toContain("node_modules");

    const emptyApp = tmp();
    const missingDist = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--profile",
      fakeProfile(),
      "--app-dir",
      emptyApp,
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(missingDist.status).toBe(1);
    expect(missingDist.stderr).toContain("dist");
  });

  it("BUG-09：凭据引用缺失拒绝；--skip-credentials-check 可显式跳过", () => {
    const noCredentials = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--profile",
      fakeProfile(),
      "--app-dir",
      fakeAppDir(),
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
      // 未提供 --credentials-env，且 fake HOME 无 ~/.kiwi/credentials.env
      "--skip-credentials-check",
    ]);
    expect(noCredentials.status).toBe(0);

    const emptyHome = tmp();
    const hardFail = run(
      [
        "--prefix",
        path.join(tmp(), "inst"),
        "--confirm-new-instance",
        "--profile",
        fakeProfile(),
        "--app-dir",
        fakeAppDir(),
        "--shopping-bin",
        fakeShoppingBin("2.1.0"),
      ],
      { envHome: emptyHome },
    );
    expect(hardFail.status).toBe(1);
    expect(hardFail.stderr).toContain("凭据引用不存在");
  });

  it("成功安装：布局 + 可运行应用 + profile + 凭据 + 服务单元（--profile/--data-dir、shopping 依赖）+ preflight", () => {
    const prefix = path.join(tmp(), "inst");
    const r = run(baseArgs(prefix));
    expect(r.status, r.stderr).toBe(0);
    for (const d of ["app", "data", "config", "run", "logs", "backups"]) {
      expect(existsSync(path.join(prefix, d)), d).toBe(true);
    }
    // 可运行应用 + profile + 凭据引用落位（BUG-09）
    expect(existsSync(path.join(prefix, "app", "dist", "cli.js"))).toBe(true);
    expect(existsSync(path.join(prefix, "app", "node_modules"))).toBe(true);
    expect(existsSync(path.join(prefix, "config", "profile.yaml"))).toBe(true);
    expect(existsSync(path.join(prefix, ".kiwi", "credentials.env"))).toBe(true);
    // 服务单元：--profile + --data-dir；shopping 托管单元与依赖关系
    const unit = readFileSync(path.join(prefix, "config", "kiwi-merchant.service"), "utf8");
    expect(unit).toContain(prefix);
    expect(unit).toContain("merchant runtime start");
    expect(unit).toContain(`--profile ${path.join(prefix, "config", "profile.yaml")}`);
    expect(unit).toContain(`--data-dir ${path.join(prefix, "data")}`);
    expect(unit).toContain("kiwi-shopping.service");
    const shoppingUnit = readFileSync(path.join(prefix, "config", "kiwi-shopping.service"), "utf8");
    expect(shoppingUnit).toContain("ExecStart=");
    const plist = readFileSync(path.join(prefix, "config", "com.kiwi.merchant.plist"), "utf8");
    expect(plist).toContain(prefix);
    expect(plist).toContain("--profile");
    // install.json：版本锁 + preflight 全过
    const manifest = JSON.parse(readFileSync(path.join(prefix, "config", "install.json"), "utf8"));
    expect(manifest.shopping_cli_detected).toEqual({ major: 2, minor: 1, patch: 0 });
    expect(manifest.versions.shopping_cli).toBe(">= 2.0.0");
    expect(manifest.profile.target).toBe(path.join(prefix, "config", "profile.yaml"));
    expect(manifest.preflight.every((p: { ok: boolean }) => p.ok)).toBe(true);
    // 真实冒烟：安装产出的 cli 可执行（安装器 preflight 已跑，这里复核产物）
    const smoke = spawnSync(process.execPath, [path.join(prefix, "app", "dist", "cli.js"), "--version"], {
      encoding: "utf8",
    });
    expect(smoke.status).toBe(0);
    expect(String(smoke.stdout)).toContain("kiwi");
  });

  it("已有安装拒绝：install.json / data 非空 / state.sqlite 存在，不新建空库替代", () => {
    const prefix = path.join(tmp(), "inst");
    const r1 = run(baseArgs(prefix));
    expect(r1.status).toBe(0);
    // 二次安装（审查 P2：install.json 已存在——已安装未首启的实例也不可被
    // 无确认重装覆盖，app/config/凭据在升级路径落地前一律拒绝）
    const r2 = run(baseArgs(prefix));
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("已有安装");
    // 写入 state.sqlite 后 → 拒绝
    writeFileSync(path.join(prefix, "data", "state.sqlite"), "db");
    const r3 = run(baseArgs(prefix));
    expect(r3.status).toBe(1);
    expect(r3.stderr).toContain("已有安装");
    // data/ 有其他内容也拒绝
    const prefix2 = path.join(tmp(), "inst2");
    mkdirSync(path.join(prefix2, "data"), { recursive: true });
    writeFileSync(path.join(prefix2, "data", "anything.txt"), "x");
    const r4 = run(baseArgs(prefix2));
    expect(r4.status).toBe(1);
  });

  it("--dry-run 不写盘（含 app/profile/服务计划）", () => {
    const prefix = path.join(tmp(), "dry");
    const r = run([...baseArgs(prefix), "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry_run");
    expect(r.stdout).toContain("profile");
    expect(existsSync(prefix)).toBe(false);
  });

  it("versions.lock.json 与 product-compat 单一来源一致（防漂移）", () => {
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as { shopping_cli: string };
    expect(lock.shopping_cli).toBe(compatRangeText(SHOPPING_CLI_COMPAT));
  });
});
