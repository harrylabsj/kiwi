/**
 * 开通顾问 0.1.7 的原地升级脚本：只替换程序文件、保留 cloud.config.json 与
 * pilot/merchant.yaml，并在替换前整目录备份。测试覆盖：正常替换、dry-run 不落地、
 * 缺保留文件时拒绝、新版本配置不覆盖现网配置。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  root,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.1.7",
  "skills/kiwi-cloud-deploy/scripts/upgrade-in-place.mjs",
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-upgrade-in-place-"));
  dirs.push(dir);
  return dir;
}

const config = {
  public_origin: "https://linkluck-reception.app.workbuddy.host",
  data_dir: "/workspace/.kiwi-runtime-linkluck",
  profile: "pilot/merchant.yaml",
  products_file: "/workspace/.kiwi-runtime-linkluck/products.json",
  a2a_auth: "signature",
};

function makePublish(dir: string, version: string): void {
  mkdirSync(path.join(dir, "app"), { recursive: true });
  mkdirSync(path.join(dir, "pilot"), { recursive: true });
  writeFileSync(path.join(dir, "app", "index.js"), `// app ${version}\n`);
  writeFileSync(path.join(dir, "index.js"), "export const entry = 1;\n");
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "kiwi-merchant-cloud", version }, null, 2)}\n`);
  writeFileSync(path.join(dir, "build-manifest.json"), `${JSON.stringify({ runtime_version: version })}\n`);
  writeFileSync(path.join(dir, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`);
  writeFileSync(path.join(dir, "cloud.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(path.join(dir, "pilot", "merchant.yaml"), "agent_id: merchant-agent:test\nname: linkluck\n");
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("kiwi-cloud-deploy 原地升级脚本", () => {
  it("只替换程序文件并保留配置与身份文件", () => {
    const base = sandbox();
    const publish = path.join(base, "linkluck-publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.26");
    makePublish(staged, "0.12.29");
    mkdirSync(path.join(staged, "contracts"), { recursive: true });
    writeFileSync(path.join(staged, "contracts", "manifest.json"), "{}\n");
    writeFileSync(path.join(staged, "deployment-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } })}\n`);
    const configBefore = readFileSync(path.join(publish, "cloud.config.json"), "utf8");
    const profileBefore = readFileSync(path.join(publish, "pilot", "merchant.yaml"), "utf8");

    const result = run(["--publish-dir", publish, "--staged", staged]);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      version: { from: string; to: string };
      verified: { config_unchanged: boolean; profile_unchanged: boolean };
      backup_dir: string;
    };
    expect(receipt.version).toEqual({ from: "0.12.26", to: "0.12.29" });
    expect(receipt.verified.config_unchanged).toBe(true);
    expect(receipt.verified.profile_unchanged).toBe(true);
    expect(readFileSync(path.join(publish, "cloud.config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(path.join(publish, "pilot", "merchant.yaml"), "utf8")).toBe(profileBefore);
    expect(JSON.parse(readFileSync(path.join(publish, "package.json"), "utf8")).version).toBe("0.12.29");
    expect(readFileSync(path.join(publish, "app", "index.js"), "utf8")).toContain("0.12.29");
    expect(existsSync(path.join(publish, "contracts", "manifest.json"))).toBe(true);
    // 备份是替换前的完整副本
    expect(JSON.parse(readFileSync(path.join(receipt.backup_dir, "package.json"), "utf8")).version).toBe("0.12.26");
    expect(readdirSync(path.join(receipt.backup_dir, "app"))).toContain("index.js");
  });

  it("--dry-run 只报告不落地", () => {
    const base = sandbox();
    const publish = path.join(base, "publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.26");
    makePublish(staged, "0.12.29");
    writeFileSync(path.join(staged, "deployment-lock.json"), "{}\n");
    const before = readFileSync(path.join(publish, "package.json"), "utf8");

    const result = run(["--publish-dir", publish, "--staged", staged, "--dry-run"]);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout) as { dry_run: boolean; backup_dir: string | null };
    expect(receipt.dry_run).toBe(true);
    expect(receipt.backup_dir).toBeNull();
    expect(readFileSync(path.join(publish, "package.json"), "utf8")).toBe(before);
    expect(existsSync(publish)).toBe(true);
    expect(readdirSync(base).filter((name) => name.includes("-backup"))).toEqual([]);
  });

  it("发布目录缺少必须保留的身份文件时拒绝执行", () => {
    const base = sandbox();
    const publish = path.join(base, "publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.26");
    makePublish(staged, "0.12.29");
    writeFileSync(path.join(staged, "deployment-lock.json"), "{}\n");
    rmSync(path.join(publish, "pilot"), { recursive: true, force: true });

    const result = run(["--publish-dir", publish, "--staged", staged]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pilot/merchant.yaml");
    expect(JSON.parse(readFileSync(path.join(publish, "package.json"), "utf8")).version).toBe("0.12.26");
  });

  it("新版本配置与现网不同时只记录差异、不采用", () => {
    const base = sandbox();
    const publish = path.join(base, "publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.26");
    makePublish(staged, "0.12.29");
    writeFileSync(path.join(staged, "deployment-lock.json"), "{}\n");
    writeFileSync(
      path.join(staged, "cloud.config.json"),
      `${JSON.stringify({ ...config, data_dir: "/workspace/.kiwi-runtime" }, null, 2)}\n`,
    );

    const result = run(["--publish-dir", publish, "--staged", staged]);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      staged_config_differences_not_adopted: Array<{ field: string; staged: string; kept: string }>;
    };
    expect(receipt.staged_config_differences_not_adopted).toEqual([
      { field: "data_dir", staged: "/workspace/.kiwi-runtime", kept: "/workspace/.kiwi-runtime-linkluck" },
    ]);
    expect(JSON.parse(readFileSync(path.join(publish, "cloud.config.json"), "utf8")).data_dir).toBe(
      "/workspace/.kiwi-runtime-linkluck",
    );
  });
});
