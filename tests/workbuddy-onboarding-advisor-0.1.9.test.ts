/**
 * 开通顾问 0.1.9 本地候选：执行授权、原地升级入口与过时文案清理。
 * 只验证本地包结构与脚本行为，不代表平台上传、审核或真实云部署验收。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expertRoot = path.join(
  root,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.1.9",
);
const skillRoot = path.join(expertRoot, "skills/kiwi-cloud-deploy");
const scriptsRoot = path.join(skillRoot, "scripts");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-onboarding-advisor-019-"));
  tempDirs.push(dir);
  return realpathSync(dir);
}

const appId = "wbapp_demo";
const origin = "https://demo.app.workbuddy.host";

function run(script: string, args: string[], cwd?: string) {
  return spawnSync(process.execPath, [path.join(scriptsRoot, script), ...args], { encoding: "utf8", cwd });
}

function mark(workspace: string, id: string, localDir: string): void {
  writeFileSync(
    path.join(workspace, `.${id}.genie`),
    [`appId: ${id}`, "name: Kiwi商家接待", `localDir: ${localDir}`, "appType: node"].join("\n"),
  );
}

function makeApp(workspace: string, id: string, appOrigin: string, version: string): string {
  const localDir = path.join(workspace, id);
  mkdirSync(path.join(localDir, "app"), { recursive: true });
  mkdirSync(path.join(localDir, "pilot"));
  writeFileSync(path.join(localDir, "cloud.config.json"), JSON.stringify({ public_origin: appOrigin }));
  writeFileSync(path.join(localDir, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(localDir, "pilot", "merchant.yaml"), "agent_id: test\n");
  writeFileSync(path.join(localDir, "index.js"), "export {};\n");
  writeFileSync(path.join(localDir, "build-manifest.json"), "{}\n");
  writeFileSync(path.join(localDir, "deployment-lock.json"), "{}\n");
  mark(workspace, id, id);
  return localDir;
}

describe("开通顾问 0.1.9 本地候选", () => {
  it("插件与内嵌技能版本一致，且包含新增的发布资源", () => {
    const plugin = JSON.parse(readFileSync(path.join(expertRoot, ".codebuddy-plugin/plugin.json"), "utf8")) as {
      version: string;
      skills: string[];
    };
    expect(plugin.version).toBe("0.1.9");
    expect(plugin.skills).toEqual(["./skills/kiwi-cloud-deploy"]);
    expect(readFileSync(path.join(skillRoot, "SKILL.md"), "utf8")).toMatch(/^version: 0\.3\.6$/m);

    expect(existsSync(path.join(skillRoot, "references/publish-params.json"))).toBe(true);
    expect(existsSync(path.join(scriptsRoot, "discover-target.mjs"))).toBe(true);
    const params = JSON.parse(readFileSync(path.join(skillRoot, "references/publish-params.json"), "utf8")) as {
      installCmd?: string;
      startCmd?: string;
      port?: number;
    };
    expect(params.port).toBe(3000);
    expect(params.installCmd).toContain("node@22.19.0");
    expect(params.startCmd).toContain("node index.js");
  });

  it("执行授权由用户请求触发：完整性校验通过后返回 executionAuthorized:true，不依赖环境变量", () => {
    const cli = readFileSync(path.join(scriptsRoot, "cloud-session-cli.mjs"), "utf8");
    expect(cli).toContain("const authorized=true");
    expect(cli).not.toContain("process.env.KIWI_DEPLOY_AUTHORIZED");
    for (const file of ["preflight.mjs", "cloud-session.mjs", "cloud-candidate-check.mjs"]) {
      const text = readFileSync(path.join(scriptsRoot, file), "utf8");
      expect(text, file).not.toMatch(/return\s*\{[^}]*executionAuthorized\s*:\s*false/);
    }
    expect(readFileSync(path.join(scriptsRoot, "cloud-candidate-check.mjs"), "utf8")).not.toContain(
      "checked.executionAuthorized !== false",
    );
  });

  it("过时文案已清理：方案 B 与 first-publish 不再引用已失效的预检门", () => {
    const fallback = readFileSync(path.join(skillRoot, "references/fallback-prompt.md"), "utf8");
    expect(fallback).not.toContain("暂不可执行");
    expect(fallback).not.toContain("executionAuthorized:false");
    expect(fallback).not.toContain("0.12.15");
    expect(fallback).not.toContain("KIWI_DEPLOY_AUTHORIZED");
    expect(fallback).toContain("publish-params.json");

    const firstPublish = readFileSync(path.join(skillRoot, "first-publish/README.md"), "utf8");
    expect(firstPublish).not.toContain("executionAuthorized:false");
    expect(firstPublish).not.toContain("KIWI_DEPLOY_AUTHORIZED");

    const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(skill).not.toContain("V1 遗留待确认点");
    expect(skill).not.toMatch(/实际 prepare 必须来自本次 session 验证通过的完整 npm 包。\s*实际 prepare/);
  });

  it("只读取已核验应用的绑定，并将相对目录按原任务解析", () => {
    const workspace = sandbox();
    const appDir = makeApp(workspace, appId, origin, "0.12.30");
    makeApp(workspace, "wbapp_other", "https://other.app.workbuddy.host", "0.12.29");

    const result = run("discover-target.mjs", [workspace, appId, origin], sandbox());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      app_id: appId,
      local_dir: appDir,
      origin,
      version: "0.12.30",
    });
  });

  it("缺少账号核验输入或当前任务绑定时，不搜索历史任务或返回其他应用", () => {
    const workspace = sandbox();
    makeApp(workspace, "wbapp_other", "https://other.app.workbuddy.host", "0.12.29");
    makeApp(sandbox(), appId, origin, "0.12.30");
    for (const [args, error] of [
      [[workspace], "WORKSPACE_AND_VERIFIED_APP_ID_AND_ORIGIN_REQUIRED"],
      [[workspace, appId, origin], "TARGET_MARKER_UNAVAILABLE"],
    ] as const) {
      const result = run("discover-target.mjs", [...args]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(result.stderr).not.toContain("wbapp_other");
      expect(result.stdout).toBe("");
    }
  });

  it("拒绝越过工作区的绑定与指向其他工作区的目录链接", () => {
    const workspace = sandbox();
    const outside = sandbox();
    const appDir = makeApp(outside, appId, origin, "0.12.30");
    symlinkSync(outside, path.join(workspace, "alias"), "dir");
    for (const localDir of [appDir, path.join("alias", appId)]) {
      mark(workspace, appId, localDir);
      const result = run("discover-target.mjs", [workspace, appId, origin]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("TARGET_PATH_OUTSIDE_WORKSPACE");
      expect(result.stdout).toBe("");
    }
  });

  it("执行替换前核对 appId 与 origin，并仅升级匹配的应用", () => {
    const workspace = sandbox();
    const appDir = makeApp(workspace, appId, origin, "0.12.30");
    mark(workspace, appId, appDir);
    const otherId = "wbapp_other";
    const otherDir = makeApp(workspace, otherId, "https://other.app.workbuddy.host", "0.12.29");
    const staged = makeApp(sandbox(), "wbapp_staged", origin, "0.12.35");
    const currentVersion = (directory: string) => JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).version;
    const args = ["--workspace", workspace, "--origin", origin, "--staged", staged];

    const unscoped = run("upgrade-in-place.mjs", ["--publish-dir", otherDir, "--staged", staged]);
    expect(unscoped.status).toBe(1);
    const crossAccount = run("upgrade-in-place.mjs", [...args, "--app-id", otherId]);
    expect(crossAccount.status).toBe(1);
    expect(crossAccount.stderr).toContain("TARGET_ORIGIN_MISMATCH");
    expect(crossAccount.stdout).toBe("");
    expect(currentVersion(appDir)).toBe("0.12.30");
    expect(currentVersion(otherDir)).toBe("0.12.29");

    const upgraded = run("upgrade-in-place.mjs", [...args, "--app-id", appId]);
    expect(upgraded.status).toBe(0);
    expect(JSON.parse(upgraded.stdout)).toMatchObject({ app_id: appId, publish_dir: appDir });
    expect(currentVersion(appDir)).toBe("0.12.35");
    expect(currentVersion(otherDir)).toBe("0.12.29");
  });

  it("发布资产清单把 0.1.9 记为未上传的本地候选", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, "integrations/hosts/workbuddy/release-bundle-manifest.json"), "utf8"),
    ) as {
      assets: Array<{
        name?: string;
        platform_version?: string;
        observed_state?: string;
        source?: string;
        bundle_mode?: string;
      }>;
    };
    const rows = manifest.assets.filter(
      (asset) => asset.name === "开通顾问" && asset.platform_version === "0.1.9",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observed_state).toContain("local candidate");
    expect(rows[0]?.observed_state).toContain("not uploaded");
    expect(rows[0]?.source).toBe("kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.1.9");
    expect(rows[0]?.bundle_mode).toBe("candidate-source");
  });
});
