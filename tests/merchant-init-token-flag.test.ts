/**
 * `--merchant-token` 非交互商品服务令牌入口。
 *
 * 覆盖：
 *   - parseArgs 两种形式（空格 / =）都能解析；
 *   - 帮助文案区分 shopping-cli 商品服务令牌与 Catalog Runtime 绑定；
 *   - 非交互路径：flag 令牌经 merchantInit 写入 credentials.env（0600），
 *     secret 不进 profile yaml。
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli.js";
import { productHelp } from "../src/product-cli.js";
import { merchantInit } from "../src/product-init.js";
import { loadProfile } from "../src/config/profile.js";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kiwi-token-flag-"));
}

function shoppingCliFoundSpawn() {
  return (() => ({
    status: 0,
    stdout: "shopping 2.0.0\n",
    stderr: "",
    error: undefined,
  })) as unknown as typeof import("node:child_process").spawnSync;
}

function healthOkFetch() {
  return (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

let defaultProfileDir: string | undefined;

beforeEach(() => {
  defaultProfileDir = tmpDir();
  process.env.KIWI_DEFAULT_PROFILE = path.join(defaultProfileDir, "kiwi.yaml");
});

afterEach(() => {
  delete process.env.KIWI_DEFAULT_PROFILE;
  if (defaultProfileDir !== undefined) {
    rmSync(defaultProfileDir, { recursive: true, force: true });
  }
});

describe("merchant token 的非交互安全入口", () => {
  it("parseArgs 拒绝裸令牌（shell history/ps 泄漏面）", () => {
    expect(() => parseArgs(["merchant", "init", "--merchant-token", "tok_abc"])).toThrow(
      /not accepted on the command line/,
    );
    expect(() => parseArgs(["merchant", "init", "--merchant-token=tok_xyz"])).toThrow(
      /not accepted on the command line/,
    );
  });

  it("parseArgs 支持环境变量与 0600 文件两种非交互入口", () => {
    process.env.KIWI_TEST_MERCHANT_TOKEN = "tok_env";
    try {
      expect(
        parseArgs(["merchant", "init", "--merchant-token-env", "KIWI_TEST_MERCHANT_TOKEN"])
          .merchantToken,
      ).toBe("tok_env");
      expect(() =>
        parseArgs(["merchant", "init", "--merchant-token-env", "KIWI_TEST_MISSING_TOKEN"]),
      ).toThrow(/not set or empty/);
    } finally {
      delete process.env.KIWI_TEST_MERCHANT_TOKEN;
    }

    const dir = tmpDir();
    try {
      const file = path.join(dir, "token");
      writeFileSync(file, "tok_file\n", { mode: 0o600 });
      expect(parseArgs(["merchant", "init", "--merchant-token-file", file]).merchantToken).toBe(
        "tok_file",
      );
      chmodSync(file, 0o644);
      expect(() => parseArgs(["merchant", "init", "--merchant-token-file", file])).toThrow(
        /mode 0600/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(parseArgs(["merchant", "init"]).merchantToken).toBeUndefined();
    expect(
      parseArgs(["merchant", "init", "--public-url=https://merchant.example.test"]).publicUrl,
    ).toBe("https://merchant.example.test");
  });

  it("帮助文案标注：令牌不进入 argv，且仅用于商品服务", () => {
    const help = productHelp("merchant");
    expect(help).toContain("--merchant-token-env");
    expect(help).toContain("--merchant-token-file");
    expect(help).toContain("只用于 shopping-cli");
  });

  it("非交互注入：令牌写入 credentials.env（0600），不进 profile yaml", async () => {
    const dir = tmpDir();
    try {
      const credentialsPath = path.join(dir, "credentials.env");
      const outputPath = path.join(dir, "merchant.yaml");
      const report = await merchantInit({
        merchantName: "Cloud Merchant",
        merchantId: "cloud-seller",
        merchantToken: "tok_cloud_secret",
        credentialsPath,
        outputPath,
        shoppingCliUrl: "http://127.0.0.1:8765",
        autoInstallShoppingCli: false,
        spawnImpl: shoppingCliFoundSpawn(),
        fetchImpl: healthOkFetch(),
      });
      expect(report.ok).toBe(true);
      const written = (
        report.steps as { credentials_written?: { ok: boolean; detail?: string } }
      ).credentials_written;
      expect(written).toMatchObject({ ok: true, detail: credentialsPath });

      // 0600 + 商品服务凭据独立保存。
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(credentialsPath, "utf-8")).toBe("SHOPPING_MERCHANT_TOKEN=tok_cloud_secret\n");

      // secret 不进 profile（loadProfile 可读，且 yaml 文本不含令牌）。
      expect(existsSync(outputPath)).toBe(true);
      expect(readFileSync(outputPath, "utf-8")).not.toContain("tok_cloud_secret");
      const profile = loadProfile(outputPath);
      expect(profile.agent_id).toBe("cloud-seller");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
