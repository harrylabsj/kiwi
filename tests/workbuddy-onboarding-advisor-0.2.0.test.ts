/**
 * 开通顾问 0.2.0 本地候选：可续传安装、超时误杀分类、移动式备份。
 * 只验证本地包结构与脚本行为，不代表平台上传、审核或真实云部署验收。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expertRoot = path.join(
  root,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.2.0",
);
const skillRoot = path.join(expertRoot, "skills/kiwi-cloud-deploy");
const scriptsRoot = path.join(skillRoot, "scripts");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(prefix = "kiwi-onboarding-advisor-020-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function run(args: string[], script = path.join(scriptsRoot, "cloud-session-cli.mjs"), cwd?: string) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", cwd });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("开通顾问 0.2.0 本地候选", () => {
  it("插件版本 0.2.0 与内嵌技能 0.3.7 一致", () => {
    const plugin = JSON.parse(readFileSync(path.join(expertRoot, ".codebuddy-plugin/plugin.json"), "utf8")) as {
      version: string;
      skills: string[];
    };
    expect(plugin.version).toBe("0.2.0");
    expect(plugin.skills).toEqual(["./skills/kiwi-cloud-deploy"]);
    expect(readFileSync(path.join(skillRoot, "SKILL.md"), "utf8")).toMatch(/^version: 0\.3\.7$/m);
  });

  it("技能文档写明续跑、超时分类与版本探针，且不再要求删除会话目录", () => {
    const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(skill).toContain("resume --session");
    expect(skill).toContain("INSTALL_TIMEOUT_KILLED");
    expect(skill).toContain("绝对不要删除或重建 session 目录");
    expect(skill).toContain("product-help.html");
    expect(skill).not.toMatch(/不自动换版本或重试/);
  });

  it("取包脚本使用 prefer-offline 与收紧的 fetch 参数，并提供可复用的安装入口", () => {
    const preflight = readFileSync(path.join(scriptsRoot, "preflight.mjs"), "utf8");
    expect(preflight).toContain("--prefer-offline");
    expect(preflight).toContain("--fetch-retries=5");
    expect(preflight).toContain("--fetch-timeout=600000");
    expect(preflight).toContain("export async function installStaged");
    expect(preflight).toContain("DEFAULT_INSTALL_TIMEOUT_MS = 1_800_000");
    expect(preflight).toContain("KIWI_CLOUD_INSTALL_TIMEOUT_MS");
  });

  it("安装诊断把近预算的 SIGTERM 归为 INSTALL_TIMEOUT_KILLED 且标记可续跑", () => {
    const dir = sandbox();
    const probe = path.join(dir, "probe.mjs");
    writeFileSync(
      probe,
      [
        `import {classifyInstallFailure} from ${JSON.stringify(path.join(scriptsRoot, "install-diagnostics.mjs"))};`,
        "const killed={exitCode:1,signal:null,timedOut:false};",
        "const dependency={code:'ERESOLVE',exitCode:1,signal:null};",
        "process.stdout.write(JSON.stringify({",
        "  killedByBudget:classifyInstallFailure(killed,{timeoutMs:600000,elapsedMs:595000}),",
        "  timedOut:classifyInstallFailure({timedOut:true},{timeoutMs:1800000,elapsedMs:1000}),",
        "  dependency:classifyInstallFailure(dependency,{timeoutMs:1800000,elapsedMs:90000}),",
        "}));",
        "",
      ].join("\n"),
    );
    const out = execFileSync(process.execPath, [probe], { encoding: "utf8" });
    type Classification = { detailCode: string; resumable: boolean; killed_by_timeout: boolean };
    const parsed = JSON.parse(out) as {
      killedByBudget: Classification;
      timedOut: Classification;
      dependency: Classification;
    };
    expect(parsed.killedByBudget.detailCode).toBe("INSTALL_TIMEOUT_KILLED");
    expect(parsed.killedByBudget.killed_by_timeout).toBe(true);
    expect(parsed.killedByBudget.resumable).toBe(true);
    expect(parsed.timedOut.detailCode).toBe("INSTALL_TIMEOUT_KILLED");
    expect(parsed.dependency.detailCode).toBe("INSTALL_SYSTEM_ERROR");
    expect(parsed.dependency.resumable).toBe(true);
  });

  it("resume 只接受会话目录，缺会话内容时明确停止且不重解析 latest", () => {
    const session = sandbox();
    const base = [
      "--session", session,
      "--node", process.execPath,
      "--npm", path.join(path.dirname(process.execPath), "npm"),
      "--python", "/usr/bin/python3",
    ];
    const missing = run(["resume", ...base]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("HOLD: SESSION_INCOMPLETE");

    const withPrevious = run(["resume", ...base, "--previous", "0.12.40"]);
    expect(withPrevious.code).toBe(1);
    expect(withPrevious.stderr).toContain("HOLD: ARGUMENT_INVALID");

    const stageWithoutParent = run(["stage", "--node", process.execPath, "--npm", process.execPath, "--python", process.execPath, "--previous", "initial"]);
    expect(stageWithoutParent.code).toBe(1);
    expect(stageWithoutParent.stderr).toContain("HOLD: ABSOLUTE_PATH_REQUIRED");
  });
});

const upgradeScript = path.join(scriptsRoot, "upgrade-in-place.mjs");
const upgradeConfig = {
  public_origin: "https://kiwi-reception.app.workbuddy.host",
  data_dir: "/workspace/.kiwi-runtime-demo",
  profile: "pilot/merchant.yaml",
  products_file: "/workspace/.kiwi-runtime-demo/products.json",
  a2a_auth: "signature",
};

function makePublish(dir: string, version: string): void {
  mkdirSync(path.join(dir, "app"), { recursive: true });
  mkdirSync(path.join(dir, "pilot"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "app", "index.js"), `// app ${version}\n`);
  writeFileSync(path.join(dir, "index.js"), "export const entry = 1;\n");
  writeFileSync(path.join(dir, "scripts", "bootstrap.mjs"), `// bootstrap ${version}\n`);
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "kiwi-merchant-cloud", version }, null, 2)}\n`);
  writeFileSync(path.join(dir, "build-manifest.json"), `${JSON.stringify({ runtime_version: version })}\n`);
  writeFileSync(path.join(dir, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`);
  writeFileSync(path.join(dir, "cloud.config.json"), `${JSON.stringify(upgradeConfig, null, 2)}\n`);
  writeFileSync(path.join(dir, "pilot", "merchant.yaml"), "agent_id: merchant-agent:test\nname: demo\n");
}

describe("0.2.0 原地升级：移动式备份", () => {
  it("旧程序文件移入备份目录、新程序文件就位、保留文件不变", () => {
    const base = sandbox("kiwi-upgrade-020-");
    const publish = path.join(base, "publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.40");
    makePublish(staged, "0.12.41");
    writeFileSync(path.join(staged, "deployment-lock.json"), "{}\n");
    const configBefore = readFileSync(path.join(publish, "cloud.config.json"), "utf8");
    const profileBefore = readFileSync(path.join(publish, "pilot", "merchant.yaml"), "utf8");

    const result = run(["--publish-dir", publish, "--staged", staged], upgradeScript);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      version: { from: string; to: string };
      backup_mode: string;
      moved_into_backup: string[];
      rollback: { backup_dir: string; entries: string[] };
      verified: { config_unchanged: boolean; profile_unchanged: boolean; version: string };
    };
    expect(receipt.version).toEqual({ from: "0.12.40", to: "0.12.41" });
    expect(receipt.backup_mode).toBe("move");
    expect(receipt.moved_into_backup).toContain("app");
    expect(receipt.rollback.entries).toContain("app");
    expect(receipt.verified).toMatchObject({ config_unchanged: true, profile_unchanged: true, version: "0.12.41" });
    expect(readFileSync(path.join(publish, "app", "index.js"), "utf8")).toContain("0.12.41");
    expect(readFileSync(path.join(publish, "cloud.config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(path.join(publish, "pilot", "merchant.yaml"), "utf8")).toBe(profileBefore);
    // 回退点保存的是升级前的旧程序文件（移动而非删除）
    expect(readFileSync(path.join(receipt.rollback.backup_dir, "app", "index.js"), "utf8")).toContain("0.12.40");
    expect(JSON.parse(readFileSync(path.join(receipt.rollback.backup_dir, "package.json"), "utf8")).version).toBe("0.12.40");
    expect(existsSync(path.join(receipt.rollback.backup_dir, "cloud.config.json"))).toBe(true);
  });

  it("新版本缺少某目录时保留现网副本并记录 not_replaced", () => {
    const base = sandbox("kiwi-upgrade-020-keep-");
    const publish = path.join(base, "publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.40");
    makePublish(staged, "0.12.41");
    rmSync(path.join(staged, "scripts"), { recursive: true, force: true });
    writeFileSync(path.join(staged, "deployment-lock.json"), "{}\n");

    const result = run(["--publish-dir", publish, "--staged", staged], upgradeScript);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout) as { not_replaced: string[] };
    expect(receipt.not_replaced).toContain("scripts");
    expect(readFileSync(path.join(publish, "scripts", "bootstrap.mjs"), "utf8")).toContain("0.12.40");
  });

  it("--dry-run 不落地、不产生备份目录", () => {
    const base = sandbox("kiwi-upgrade-020-dry-");
    const publish = path.join(base, "publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.40");
    makePublish(staged, "0.12.41");
    writeFileSync(path.join(staged, "deployment-lock.json"), "{}\n");
    const before = readFileSync(path.join(publish, "package.json"), "utf8");

    const result = run(["--publish-dir", publish, "--staged", staged, "--dry-run"], upgradeScript);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).backup_dir).toBeNull();
    expect(readFileSync(path.join(publish, "package.json"), "utf8")).toBe(before);
    expect(readdirSync(base).filter((name) => name.includes("-backup"))).toEqual([]);
  });

  it("发布目录缺少保留身份文件时拒绝执行", () => {
    const base = sandbox("kiwi-upgrade-020-refuse-");
    const publish = path.join(base, "publish");
    const staged = path.join(base, "staged");
    makePublish(publish, "0.12.40");
    makePublish(staged, "0.12.41");
    writeFileSync(path.join(staged, "deployment-lock.json"), "{}\n");
    rmSync(path.join(publish, "pilot"), { recursive: true, force: true });

    const result = run(["--publish-dir", publish, "--staged", staged], upgradeScript);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pilot/merchant.yaml");
    expect(JSON.parse(readFileSync(path.join(publish, "package.json"), "utf8")).version).toBe("0.12.40");
  });
});
