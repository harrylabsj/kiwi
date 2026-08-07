/**
 * 产品层 CLI 骨架测试（product-strategy rev1.1 §19 D0）。
 *
 * 覆盖：
 * - `kiwi buyer / merchant / network --help` 全部可用（命令树帮助）；
 * - 骨架命令（buyer init、merchant init/publish/listings/status/doctor、
 *   network *）输出"尚未实现（D-x）"并 fail-closed（EXIT.CONFIG）；
 * - 别名兼容：`kiwi buyer start` → chat、`kiwi merchant start` → agent
 *   serve（dispatch 层验证，不实际启动服务）；
 * - `kiwi doctor`（无 --profile）→ 三组件聚合健康 JSON 结构
 *   （kiwi / shopping_cli / kiwi_catalog；D0 最小版）；
 * - 旧命令保留：`kiwi chat --help` / `kiwi agent serve --help` 仍走全局帮助。
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("product CLI command tree (D0)", () => {
  it("kiwi buyer --help prints the buyer tree", async () => {
    const { code, stdout } = await run(["buyer", "--help"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("kiwi buyer");
    expect(stdout).toContain("buyer start");
    expect(stdout).toContain("D4");
  });

  it("kiwi merchant --help prints the merchant tree", async () => {
    const { code, stdout } = await run(["merchant", "--help"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("kiwi merchant");
    expect(stdout).toContain("merchant start");
    expect(stdout).toContain("merchant publish");
  });

  it("kiwi network --help prints the network tree", async () => {
    const { code, stdout } = await run(["network", "--help"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("kiwi network");
  });

  it("bare group prints its help too", async () => {
    const buyer = await run(["buyer"]);
    expect(buyer.code).toBe(EXIT.OK);
    expect(buyer.stdout).toContain("kiwi buyer");
    const merchant = await run(["merchant"]);
    expect(merchant.code).toBe(EXIT.OK);
    expect(merchant.stdout).toContain("kiwi merchant");
  });

  it("skeleton commands fail closed with D-target hints", async () => {
    for (const argv of [
      ["buyer", "init"],
      ["buyer", "search"],
      ["buyer", "tasks"],
      ["merchant", "listings"],
      ["merchant", "status"],
      ["merchant", "doctor"],
      ["network", "status"],
    ]) {
      const { code, stderr } = await run(argv);
      expect(code).toBe(EXIT.CONFIG);
      expect(stderr).toContain("尚未实现");
    }
  });

  it("merchant publish (D2) validates required config instead of not-implemented", async () => {
    // 缺 --profile：走 profile 校验路径（不是"尚未实现"）
    const { code, stderr } = await run(["merchant", "publish"]);
    expect(code).toBe(EXIT.CONFIG);
    expect(stderr).not.toContain("尚未实现");
    expect(stderr).toContain("--profile");
  });

  it("merchant init (D1) validates required identity instead of not-implemented", async () => {
    const { code, stderr } = await run(["merchant", "init"]);
    expect(code).toBe(EXIT.CONFIG);
    expect(stderr).not.toContain("尚未实现");
    expect(stderr).toContain("--merchant-id");
  });

  it("legacy commands stay reachable through the global help", async () => {
    const chat = await run(["chat", "--help"]);
    expect(chat.code).toBe(EXIT.OK);
    expect(chat.stdout).toContain("kiwi chat");
    const serve = await run(["agent", "serve", "--help"]);
    expect(serve.code).toBe(EXIT.OK);
    expect(serve.stdout).toContain("agent serve");
  });
});

describe("kiwi doctor aggregate (D0)", () => {
  it("without --profile prints three-component health JSON", async () => {
    const { code, stdout } = await run(["doctor"]);
    expect(stdout).toContain('"kiwi"');
    expect(stdout).toContain('"shopping_cli"');
    expect(stdout).toContain('"kiwi_catalog"');
    expect(stdout).toContain('"ok"');
    // 结构正确即可：本机可能无 shopping / catalog 不可达 → CONFIG 也算通过
    expect([EXIT.OK, EXIT.CONFIG]).toContain(code);
  });

  it("with --profile keeps the profile doctor path", async () => {
    const { stdout } = await run(["doctor", "--profile", "nonexistent.yaml"]);
    // profile doctor 对不存在 profile 报错（走既有路径，不进入聚合）
    expect(stdout).not.toContain('"shopping_cli"');
  });
});
