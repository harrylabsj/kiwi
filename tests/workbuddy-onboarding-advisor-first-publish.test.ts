/**
 * 开通顾问 0.1.5 是不可变审核候选；0.1.6 是新增本地候选，只增加固定首次
 * 发布取址入口。测试同时锁住：
 * - 0.1.5 逐文件哈希与文件列表未变化；
 * - 0.1.6 的 first-publish 可实际启动并如实报告就绪状态；
 * - latest 一次解析与 executionAuthorized/test-only 安全门未被改动。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buddyRoot = path.join(root, "integrations/hosts/workbuddy/kiwi-merchant-buddy");
const expertsRoot = path.join(buddyRoot, "experts");
const immutable15 = path.join(expertsRoot, "kiwi-onboarding-advisor-0.1.5");
const candidate16 = path.join(expertsRoot, "kiwi-onboarding-advisor-0.1.6");
const skillRoot = path.join(candidate16, "skills/kiwi-cloud-deploy");
const firstPublishRoot = path.join(skillRoot, "first-publish");

type HashEntry = { path: string; sha256: string };

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(full, base)
      : [path.relative(base, full).split(path.sep).join("/")];
  });
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readHashEntries(file: string): HashEntry[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      if (!match) throw new Error(`invalid hash line: ${line}`);
      return { sha256: match[1]!, path: match[2]! };
    });
}

function waitForListening(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, port?: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(port!);
    };
    timer = setTimeout(
      () => finish(new Error(`first-publish did not start in time. stdout=${stdout} stderr=${stderr}`)),
      10_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /listening on [^\s]+:(\d+)/.exec(stdout);
      if (match?.[1]) finish(null, Number(match[1]));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      finish(new Error(`first-publish exited early with code ${code}. stderr=${stderr}`));
    });
  });
}

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  children.length = 0;
});

describe("开通顾问不可变候选与首次发布入口", () => {
  it("0.1.5 文件列表和逐文件 SHA-256 保持不变", () => {
    const hashFile = path.join(expertsRoot, "kiwi-onboarding-advisor-0.1.5.sha256");
    const entries = readHashEntries(hashFile);
    const actualFiles = listFiles(immutable15).sort();
    expect(actualFiles).toEqual(entries.map((entry) => entry.path).sort());
    expect(entries).toHaveLength(26);
    for (const entry of entries) {
      expect(sha256(path.join(immutable15, entry.path)), entry.path).toBe(entry.sha256);
    }
    expect(JSON.parse(readFileSync(path.join(immutable15, ".codebuddy-plugin/plugin.json"), "utf8")).version).toBe(
      "0.1.5",
    );
    // 0.1.5 是进入审核的原始候选，不应被本次修复追加任何文件。
    expect(existsSync(path.join(immutable15, "skills/kiwi-cloud-deploy/first-publish"))).toBe(false);
    expect(
      readFileSync(path.join(immutable15, "skills/kiwi-cloud-deploy/SKILL.md"), "utf8"),
    ).toMatch(/^version: 0\.3\.2$/m);
    expect(
      readFileSync(
        path.join(buddyRoot, "skills/candidate-archives/kiwi-cloud-deploy/0.3.2/SKILL.md"),
        "utf8",
      ),
    ).toMatch(/^version: 0\.3\.2$/m);
  });

  it("0.1.6 固定 first-publish 目录只含取址入口且不固定云端包版本", () => {
    const plugin = JSON.parse(
      readFileSync(path.join(candidate16, ".codebuddy-plugin/plugin.json"), "utf8"),
    ) as { version: string; skills: string[] };
    expect(plugin.version).toBe("0.1.6");
    expect(plugin.skills).toEqual(["./skills/kiwi-cloud-deploy"]);

    expect(readdirSync(firstPublishRoot).sort()).toEqual(["README.md", "index.js", "package.json"]);
    const pkg = JSON.parse(readFileSync(path.join(firstPublishRoot, "package.json"), "utf8")) as {
      private?: boolean;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.scripts?.start).toBe("node index.js");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();

    const bootstrap = `${readFileSync(path.join(firstPublishRoot, "index.js"), "utf8")}\n${readFileSync(
      path.join(firstPublishRoot, "README.md"),
      "utf8",
    )}`;
    expect(bootstrap).not.toMatch(/@harrylabsj\/kiwi-merchant-cloud@\d/);
    expect(bootstrap).toContain("first_publish_bootstrap");
    expect(bootstrap).not.toContain("registry.npmjs.org");

    const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^version: 0\.3\.3$/m);
    expect(skill).toContain("first-publish/");
    expect(skill).toContain("latest");
    expect(skill).toContain("test-only");
    expect(skill).toContain("executionAuthorized:false");
  });

  it("0.1.6 保留 0.1.5 的 latest 一次解析与 executionAuthorized/test-only 安全门", () => {
    const gatedScripts = [
      "scripts/preflight.mjs",
      "scripts/cloud-session.mjs",
      "scripts/cloud-session-cli.mjs",
      "scripts/cloud-candidate-check.mjs",
      "scripts/latest-resolver.mjs",
      "scripts/audit-gate.mjs",
      "scripts/sigstore-gate.mjs",
    ];
    for (const relative of gatedScripts) {
      expect(sha256(path.join(skillRoot, relative)), relative).toBe(
        sha256(path.join(immutable15, "skills/kiwi-cloud-deploy", relative)),
      );
    }

    const preflight = readFileSync(path.join(skillRoot, "scripts/preflight.mjs"), "utf8");
    const cloudSession = readFileSync(path.join(skillRoot, "scripts/cloud-session.mjs"), "utf8");
    const candidateCheck = readFileSync(path.join(skillRoot, "scripts/cloud-candidate-check.mjs"), "utf8");
    expect(preflight).toContain("executionAuthorized:false");
    expect(cloudSession).toContain("executionAuthorized:false");
    expect(candidateCheck).toContain("executionAuthorized !== false");
    expect(readFileSync(path.join(skillRoot, "scripts/latest-resolver.mjs"), "utf8")).toContain("/latest");
  });

  it("first-publish 入口可直接启动，且不会把占位页误报为正式运行时", async () => {
    const child = spawn(process.execPath, [path.join(firstPublishRoot, "index.js")], {
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
      stdio: "pipe",
    });
    children.push(child);
    const port = await waitForListening(child);
    const base = `http://127.0.0.1:${port}`;

    const live = await fetch(`${base}/livez`);
    expect(live.status).toBe(200);
    expect(await live.text()).toBe("ok\n");

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, reason: "first_publish_bootstrap" });

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("首次发布取址占位入口已启动");

    const notAllowed = await fetch(`${base}/livez`, { method: "POST" });
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get("x-content-type-options")).toBe("nosniff");

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  });

  it("端口被占用时输出稳定 HOLD 码而不是未捕获崩溃", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const child = spawn(process.execPath, [path.join(firstPublishRoot, "index.js")], {
        env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
        stdio: "pipe",
      });
      children.push(child);
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("exit", (code) => resolve({ code, stderr }));
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("KIWI_LAUNCHER_HOLD:FIRST_PUBLISH_PORT_IN_USE");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("发布资产清单同时记录 0.1.5 审核候选和 0.1.6 本地候选", () => {
    const manifestPath = path.join(root, "integrations/hosts/workbuddy/release-bundle-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assets: Array<{
        kind?: string;
        name?: string;
        platform_version?: string;
        observed_state?: string;
        source?: string;
        mapping?: string;
        bundle_mode?: string;
      }>;
    };
    const rows = manifest.assets.filter(
      (asset) =>
        asset.name === "开通顾问" &&
        (asset.platform_version === "0.1.5" || asset.platform_version === "0.1.6"),
    );
    expect(rows).toHaveLength(2);
    const v15 = rows.find((asset) => asset.platform_version === "0.1.5")!;
    const v16 = rows.find((asset) => asset.platform_version === "0.1.6")!;
    expect(v15.observed_state).toContain("reviewing");
    expect(v15.observed_state).toContain("immutable");
    expect(v15.observed_state).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(v16.observed_state).toContain("local candidate");
    expect(v16.observed_state).toContain("not uploaded");
    expect(v16.observed_state).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(v16.mapping).toContain("latest");
    expect(v16.mapping).toContain("once");
    expect(v16.mapping).toContain("first-publish");
    expect(v16.mapping).toContain("embedded skill 0.3.3");
    expect(v16.mapping).toContain("not independently published");
    expect(v16.mapping).toContain("independent 0.3.2 unchanged");
    const independent033 = manifest.assets.filter(
      (asset) => asset.kind === "skill" && asset.platform_version === "0.3.3",
    );
    expect(independent033).toHaveLength(0);
    const independent032 = manifest.assets.filter(
      (asset) =>
        asset.kind === "skill" &&
        asset.platform_version === "0.3.2" &&
        asset.source?.includes("candidate-archives/kiwi-cloud-deploy/0.3.2"),
    );
    expect(independent032).toHaveLength(1);
    expect(v15.source).toBe("kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.1.5");
    expect(v16.source).toBe("kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.1.6");
    expect(v15.bundle_mode).toBe("candidate-source");
    expect(v16.bundle_mode).toBe("candidate-source");
  });
});
