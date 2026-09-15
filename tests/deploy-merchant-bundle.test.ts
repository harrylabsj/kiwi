/**
 * deploy/merchant-bundle 安装器测试（V2 阶段一）：
 * - 新实例必须显式 --confirm-new-instance；
 * - 已有安装（data 非空 / state.sqlite）拒绝，绝不新建空库替代；
 * - shopping-cli 版本超出已验证范围（>= 2.0.0 < 3.0.0）拒绝；
 * - 成功安装产出目录布局 + 服务单元 + install.json；
 * - versions.lock.json 与 src/product-compat.ts 单一来源防漂移。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

describe("deploy/merchant-bundle install.mjs", () => {
  it("缺 --confirm-new-instance 拒绝新实例安装", () => {
    const r = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--confirm-new-instance");
  });

  it("shopping-cli 版本超出已验证范围拒绝（版本锁 fail-closed）", () => {
    const tooNew = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--shopping-bin",
      fakeShoppingBin("3.0.0"),
    ]);
    expect(tooNew.status).toBe(1);
    expect(tooNew.stderr).toContain("3.0.0");
    expect(tooNew.stderr).toContain(">= 2.0.0 < 3.0.0");

    const missing = run([
      "--prefix",
      path.join(tmp(), "inst"),
      "--confirm-new-instance",
      "--shopping-bin",
      path.join(tmp(), "no-such-bin"),
    ]);
    expect(missing.status).toBe(1);
  });

  it("成功安装：目录布局 + 服务单元 + install.json（含版本锁）", () => {
    const prefix = path.join(tmp(), "inst");
    const r = run([
      "--prefix",
      prefix,
      "--confirm-new-instance",
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(r.status, r.stderr).toBe(0);
    for (const d of ["data", "config", "run", "logs", "backups"]) {
      expect(existsSync(path.join(prefix, d)), d).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(path.join(prefix, "config", "install.json"), "utf8"));
    expect(manifest.shopping_cli_detected).toEqual({ major: 2, minor: 1, patch: 0 });
    expect(manifest.versions.shopping_cli).toBe(">= 2.0.0 < 3.0.0");
    const unit = readFileSync(path.join(prefix, "config", "kiwi-merchant.service"), "utf8");
    expect(unit).toContain(prefix);
    expect(unit).toContain("merchant runtime start");
    const plist = readFileSync(path.join(prefix, "config", "com.kiwi.merchant.plist"), "utf8");
    expect(plist).toContain(prefix);
  });

  it("已有安装拒绝：data 非空或 state.sqlite 存在，不新建空库替代", () => {
    const prefix = path.join(tmp(), "inst");
    const r1 = run([
      "--prefix",
      prefix,
      "--confirm-new-instance",
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(r1.status).toBe(0);
    // 二次安装（data/ 已被创建但为空——目录本身存在不算已有安装）
    const r2 = run([
      "--prefix",
      prefix,
      "--confirm-new-instance",
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(r2.status).toBe(0);
    // 写入 state.sqlite 后 → 拒绝
    writeFileSync(path.join(prefix, "data", "state.sqlite"), "db");
    const r3 = run([
      "--prefix",
      prefix,
      "--confirm-new-instance",
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(r3.status).toBe(1);
    expect(r3.stderr).toContain("已有安装");
    // data/ 有其他内容也拒绝
    const prefix2 = path.join(tmp(), "inst2");
    mkdirSync(path.join(prefix2, "data"), { recursive: true });
    writeFileSync(path.join(prefix2, "data", "anything.txt"), "x");
    const r4 = run([
      "--prefix",
      prefix2,
      "--confirm-new-instance",
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(r4.status).toBe(1);
  });

  it("--dry-run 不写盘", () => {
    const prefix = path.join(tmp(), "dry");
    const r = run([
      "--prefix",
      prefix,
      "--confirm-new-instance",
      "--dry-run",
      "--shopping-bin",
      fakeShoppingBin("2.1.0"),
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry_run");
    expect(existsSync(prefix)).toBe(false);
  });

  it("versions.lock.json 与 product-compat 单一来源一致（防漂移）", () => {
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as { shopping_cli: string };
    expect(lock.shopping_cli).toBe(compatRangeText(SHOPPING_CLI_COMPAT));
  });
});
