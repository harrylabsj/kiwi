/**
 * 开通顾问 0.1.9 本地候选：执行授权、原地升级入口与过时文案清理。
 * 只验证本地包结构与脚本行为，不代表平台上传、审核或真实云部署验收。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return dir;
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

  it("discover-target 把相对 localDir 解析到工作区根目录并读取目标配置", () => {
    const workspace = sandbox();
    const appDir = path.join(workspace, "apps", "kiwi-reception");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(appDir, "cloud.config.json"),
      JSON.stringify({ public_origin: "https://demo.app.workbuddy.host", data_dir: "/workspace/.kiwi-runtime-demo" }),
    );
    writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ version: "0.12.30" }));
    writeFileSync(
      path.join(workspace, ".wbapp_cb_demo.genie"),
      ["appId: cb_demo", "name: Kiwi商家接待", "localDir: apps/kiwi-reception", "appType: node"].join("\n"),
    );

    const stdout = execFileSync(process.execPath, [path.join(scriptsRoot, "discover-target.mjs"), workspace], {
      encoding: "utf8",
      cwd: sandbox(), // 故意不是工作区：相对路径必须按 workspace 解析
    });
    const report = JSON.parse(stdout) as {
      apps: Array<{
        app_id: string;
        local_dir: string;
        local_dir_exists: boolean;
        origin: string | null;
        data_dir: string | null;
        version: string | null;
      }>;
    };
    expect(report.apps).toHaveLength(1);
    expect(report.apps[0]).toMatchObject({
      app_id: "cb_demo",
      local_dir: appDir,
      local_dir_exists: true,
      origin: "https://demo.app.workbuddy.host",
      data_dir: "/workspace/.kiwi-runtime-demo",
      version: "0.12.30",
    });
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
