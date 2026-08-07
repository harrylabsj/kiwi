/**
 * `kiwi merchant init` 测试（product-strategy rev1.1 §3.2/§19 D1）。
 *
 * 覆盖：
 * - 非交互生成：merchant profile 写盘 + 结构正确（role/agent_id 身份统一
 *   = shopping-cli merchant_id、commerce.base_url、token_env 只写环境变量名）；
 * - 生成文件可被 loadProfile 读取（可用性验证）；
 * - shopping-cli 缺失 → warning 不阻塞（mock spawn 注入）；
 * - shopping-cli 不可达 → warning 不阻塞（mock fetch 注入）；
 * - 已存在输出文件 → fail-closed（--force 覆盖）；
 * - 数据目录初始化（0700）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/config/profile.js";
import { merchantInit } from "../src/product-init.js";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kiwi-init-"));
}

function shoppingCliFoundSpawn() {
  return (() => ({
    status: 0,
    stdout: "shopping 2.0.0\n",
    stderr: "",
    error: undefined,
  })) as unknown as typeof import("node:child_process").spawnSync;
}

function shoppingCliMissingSpawn() {
  return (() => ({
    status: 127,
    stdout: "",
    stderr: "shopping: not found",
    error: new Error("spawn shopping ENOENT"),
  })) as unknown as typeof import("node:child_process").spawnSync;
}

function healthOkFetch() {
  return (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function healthDownFetch() {
  return (async () => {
    throw new Error("fetch failed: connection refused");
  }) as typeof fetch;
}

describe("merchant init (D1)", () => {
  it("generates a loadable merchant profile with unified identity", async () => {
    const dir = tmpDir();
    try {
      const outputPath = path.join(dir, "merchant.yaml");
      const report = await merchantInit({
        merchantName: "West Lake Tea",
        merchantId: "seller-b",
        shoppingCliUrl: "http://127.0.0.1:8765",
        outputPath,
        spawnImpl: shoppingCliFoundSpawn(),
        fetchImpl: healthOkFetch(),
      });

      expect(report.ok).toBe(true);
      expect(report.agent_id).toBe("seller-b");
      expect(report.steps.profile_written.ok).toBe(true);
      expect(report.steps.shopping_cli_detected.ok).toBe(true);
      expect(report.steps.shopping_cli_reachable.ok).toBe(true);
      expect(report.steps.data_dir_initialized.ok).toBe(true);
      expect(report.warnings).toEqual([]);

      // 生成文件可被 loadProfile 读取（可用性验证）
      const profile = loadProfile(outputPath);
      expect(profile.role).toBe("merchant");
      expect(profile.agent_id).toBe("seller-b");
      expect(profile.owner_id).toBe("seller-b");
      expect(profile.commerce.base_url).toBe("http://127.0.0.1:8765");
      expect(profile.merchant_policy?.min_unit_price_private).toBe(0);

      // secret 不入 profile：token_env 只写环境变量名
      const raw = readFileSync(outputPath, "utf-8");
      expect(raw).toContain("token_env: SHOPPING_MERCHANT_TOKEN");
      expect(raw).not.toMatch(/api_key:\s*\S+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing shopping-cli warns but does not block generation", async () => {
    const dir = tmpDir();
    try {
      const report = await merchantInit({
        merchantName: "Offline Merchant",
        merchantId: "offline-1",
        outputPath: path.join(dir, "merchant.yaml"),
        spawnImpl: shoppingCliMissingSpawn(),
        fetchImpl: healthOkFetch(),
      });
      expect(report.ok).toBe(true); // 生成不阻塞
      expect(report.steps.shopping_cli_detected.ok).toBe(false);
      expect(report.warnings.some((w) => w.includes("shopping-cli 未检测到"))).toBe(true);
      expect(existsSync(path.join(dir, "merchant.yaml"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unreachable shopping-cli warns but does not block generation", async () => {
    const dir = tmpDir();
    try {
      const report = await merchantInit({
        merchantName: "Solo Merchant",
        merchantId: "solo-1",
        outputPath: path.join(dir, "merchant.yaml"),
        spawnImpl: shoppingCliFoundSpawn(),
        fetchImpl: healthDownFetch(),
      });
      expect(report.ok).toBe(true);
      expect(report.steps.shopping_cli_reachable.ok).toBe(false);
      expect(report.warnings.some((w) => w.includes("不可达"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("existing output fails closed unless --force", async () => {
    const dir = tmpDir();
    try {
      const outputPath = path.join(dir, "merchant.yaml");
      const first = await merchantInit({
        merchantName: "A",
        merchantId: "a-1",
        outputPath,
        spawnImpl: shoppingCliFoundSpawn(),
        fetchImpl: healthOkFetch(),
      });
      expect(first.ok).toBe(true);

      const second = await merchantInit({
        merchantName: "B",
        merchantId: "b-2",
        outputPath,
        spawnImpl: shoppingCliFoundSpawn(),
        fetchImpl: healthOkFetch(),
      });
      expect(second.ok).toBe(false);
      expect(second.steps.profile_written.detail).toContain("已存在");

      const forced = await merchantInit({
        merchantName: "B",
        merchantId: "b-2",
        outputPath,
        force: true,
        spawnImpl: shoppingCliFoundSpawn(),
        fetchImpl: healthOkFetch(),
      });
      expect(forced.ok).toBe(true);
      expect(loadProfile(outputPath).agent_id).toBe("b-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merchant id is derived from name when not provided", async () => {
    const dir = tmpDir();
    try {
      const report = await merchantInit({
        merchantName: "West Lake Tea Co.",
        outputPath: path.join(dir, "merchant.yaml"),
        spawnImpl: shoppingCliFoundSpawn(),
        fetchImpl: healthOkFetch(),
      });
      expect(report.ok).toBe(true);
      expect(report.agent_id).toBe("west-lake-tea-co"); // slug 派生
      expect(loadProfile(path.join(dir, "merchant.yaml")).agent_id).toBe("west-lake-tea-co");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-install: missing shopping-cli is installed via pip then detected", async () => {
    const dir = tmpDir();
    try {
      let shoppingCalls = 0;
      const installCalls: string[] = [];
      const spawnImpl = ((cmd: string, args: string[]) => {
        if (cmd === "shopping") {
          shoppingCalls += 1;
          return shoppingCalls === 1
            ? { status: 127, stdout: "", stderr: "not found", error: new Error("ENOENT") }
            : { status: 0, stdout: "shopping.py 2.0.0\n", stderr: "" };
        }
        if (cmd === "pip") {
          installCalls.push(args.join(" "));
          return { status: 0, stdout: "installed", stderr: "" };
        }
        throw new Error(`unexpected spawn: ${cmd}`);
      }) as unknown as typeof import("node:child_process").spawnSync;

      const report = await merchantInit({
        merchantName: "Auto Merchant",
        merchantId: "auto-1",
        outputPath: path.join(dir, "merchant.yaml"),
        autoInstallShoppingCli: true,
        spawnImpl,
        fetchImpl: healthOkFetch(),
      });

      expect(report.ok).toBe(true);
      expect(installCalls).toEqual(["install shopping-cli"]);
      expect(report.steps.shopping_cli_detected.ok).toBe(true);
      expect(report.warnings.some((w) => w.includes("已自动安装"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-install: pip failure fails closed with guidance", async () => {
    const dir = tmpDir();
    try {
      const spawnImpl = ((cmd: string) => {
        if (cmd === "shopping") {
          return { status: 127, stdout: "", stderr: "not found", error: new Error("ENOENT") };
        }
        if (cmd === "pip") {
          return { status: 1, stdout: "", stderr: "pip: no network" };
        }
        throw new Error(`unexpected spawn: ${cmd}`);
      }) as unknown as typeof import("node:child_process").spawnSync;

      const report = await merchantInit({
        merchantName: "Fail Merchant",
        merchantId: "fail-1",
        outputPath: path.join(dir, "merchant.yaml"),
        autoInstallShoppingCli: true,
        spawnImpl,
        fetchImpl: healthOkFetch(),
      });

      // profile 仍生成（不阻塞），但 warning 明确安装失败 + 指引
      expect(report.ok).toBe(true);
      expect(report.warnings.some((w) => w.includes("自动安装失败"))).toBe(true);
      expect(report.warnings.some((w) => w.includes("手动安装"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-install is not triggered when shopping-cli is already present", async () => {
    const dir = tmpDir();
    try {
      let pipCalled = false;
      const spawnImpl = ((cmd: string, _args: string[]) => {
        if (cmd === "shopping") {
          return { status: 0, stdout: "shopping.py 2.0.0\n", stderr: "" };
        }
        if (cmd === "pip") {
          pipCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected spawn: ${cmd}`);
      }) as unknown as typeof import("node:child_process").spawnSync;

      const report = await merchantInit({
        merchantName: "Present Merchant",
        merchantId: "present-1",
        outputPath: path.join(dir, "merchant.yaml"),
        autoInstallShoppingCli: true,
        spawnImpl,
        fetchImpl: healthOkFetch(),
      });

      expect(report.ok).toBe(true);
      expect(pipCalled).toBe(false);
      expect(report.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
