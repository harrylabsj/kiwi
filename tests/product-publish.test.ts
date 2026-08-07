/**
 * `kiwi merchant publish` 编排测试（product-strategy rev1.1 §4.5/§19 D2/D3）。
 *
 * 覆盖：
 * - 成功路径：agent 注册（mock fetch）+ shopping-cli spawn（mock spawn）→
 *   分步报告 {shopping_cli_compat, agent, listings} + 计数；
 * - spawn 参数构造：--db / --merchant / --kiwi-catalog-url /
 *   --owner-token-secret / --owner-agent-id 全部正确传递；
 * - owner token 与 kiwi-catalog 派生一致（固定向量）；
 * - 重复 publish 幂等：查询复用已有 agent（不二次注册）；
 * - agent 注册失败 → 短路（listings skipped），ok:false；
 * - listings 非零退出 / 报告 errors → ok:false + 明细；
 * - D3：shopping-cli 版本不兼容 → fail-closed（不执行注册与发布）。
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { AgentProfile } from "../src/config/profile.js";
import { merchantPublish } from "../src/product-publish.js";
import type { spawnSync } from "node:child_process";

const SECRET = "test-owner-secret";
const MERCHANT_ID = "merchant-acme";

const MERCHANT_PROFILE: AgentProfile = {
  runtime_version: "0.6.0",
  protocol_version: "shopping.negotiation/0.1",
  agent_id: MERCHANT_ID,
  role: "merchant",
  owner_id: "merchant-acme",
  commerce: {
    base_url: "http://127.0.0.1:8765",
    token_env: "SHOPPING_MERCHANT_TOKEN",
    backend: "local_marketplace",
  },
  model: { provider: "deepseek", model: "deepseek-v4-flash", api_key_env: "DEEPSEEK_API_KEY" },
  runtime: {
    mode: "once",
    poll_interval_seconds: 5,
    turn_timeout_seconds: 90,
    max_model_steps: 4,
    max_retries: 2,
  },
  merchant_policy: {
    min_unit_price_private: 1_000,
    auto_negotiate: false,
    human_review_on: [],
  },
};

function registerResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      catalog_agent: {
        catalog_agent_id: "cagt_published_001",
        status: "discovered",
        ...overrides,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function listingReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    published: [{ listing_id: "lst_1" }, { listing_id: "lst_2" }],
    skipped: [{ source_key: "SKU-3", reason: "digest unchanged" }],
    withdrawn: [],
    errors: [],
    ...overrides,
  };
}

type SpawnResult = { status: number; stdout: string; stderr: string };

/**
 * 统一 spawn mock：`--version` → 兼容版本（D3 Step 0）；其余 → listings 结果。
 * *trackArgs* 记录非版本调用的参数（断言 spawn 构造用）。
 */
function compatSpawn(
  listings: () => SpawnResult,
  trackArgs?: string[],
  versionOutput = "shopping.py 2.0.0\n",
): typeof spawnSync {
  return ((_cmd: string, args: string[]) => {
    if (args.includes("--version")) {
      return { status: 0, stdout: versionOutput, stderr: "" };
    }
    if (trackArgs !== undefined) trackArgs.push(args.join(" "));
    return listings();
  }) as unknown as typeof spawnSync;
}

describe("merchant publish orchestration (D2/D3)", () => {
  it("registers the agent then spawns shopping-cli with correct args", async () => {
    const spawnArgs: string[] = [];
    const fetchImpl = (async () => registerResponse()) as typeof fetch;
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: JSON.stringify(listingReport()), stderr: "" }),
      spawnArgs,
    );

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.steps.shopping_cli_compat.ok).toBe(true);
    expect(report.steps.agent.catalog_agent_id).toBe("cagt_published_001");
    expect(report.steps.listings.ok).toBe(true);
    expect(report.steps.listings.published).toBe(2);
    expect(report.steps.listings.skipped).toBe(1);

    const listingArgs = spawnArgs[0]?.split(" ") ?? [];
    expect(listingArgs).toContain("--db");
    expect(listingArgs[listingArgs.indexOf("--db") + 1]).toBe("/tmp/shop.sqlite");
    expect(listingArgs).toContain("--merchant");
    expect(listingArgs[listingArgs.indexOf("--merchant") + 1]).toBe(MERCHANT_ID);
    expect(listingArgs).toContain("--kiwi-catalog-url");
    expect(listingArgs[listingArgs.indexOf("--kiwi-catalog-url") + 1]).toBe("http://127.0.0.1:8600");
    expect(listingArgs).toContain("--owner-token-secret");
    expect(listingArgs[listingArgs.indexOf("--owner-token-secret") + 1]).toBe(SECRET);
    expect(listingArgs).toContain("--owner-agent-id");
    expect(listingArgs[listingArgs.indexOf("--owner-agent-id") + 1]).toBe("cagt_published_001");
  });

  it("owner token derivation matches kiwi-catalog (fixed vector)", async () => {
    const expected = createHmac("sha256", SECRET)
      .update(`kiwi-catalog-owner:${MERCHANT_ID}`)
      .digest("hex");
    let registerBody = "";
    const fetchImpl = (async (_url: string, init?: Parameters<typeof fetch>[1]) => {
      registerBody = String(init?.body ?? "");
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(listingReport()),
      stderr: "",
    }));

    await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(registerBody).toContain(`"owner_token":"${expected}"`);
    expect(registerBody).toContain(`"merchant_id":"${MERCHANT_ID}"`);
  });

  it("repeat publish is idempotent: reuses existing agent (lookup first)", async () => {
    let registerCalled = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/v1/agent-catalog/merchants/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            results: [{ catalog_agent_id: "cagt_existing_001" }],
            next_cursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      registerCalled = true;
      return registerResponse();
    }) as typeof fetch;
    const spawnArgs: string[] = [];
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: JSON.stringify(listingReport()), stderr: "" }),
      spawnArgs,
    );

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.steps.agent.catalog_agent_id).toBe("cagt_existing_001");
    expect(registerCalled).toBe(false);
    expect(spawnArgs[0]).toContain("--owner-agent-id cagt_existing_001");
  });

  it("agent registration failure short-circuits (listings skipped)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: "catalog register failed: boom" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const spawnArgs: string[] = [];
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: "{}", stderr: "" }),
      spawnArgs,
    );

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.steps.agent.ok).toBe(false);
    expect(spawnArgs.length).toBe(0); // listings 未执行
    expect(report.steps.listings.skipped_reason).toContain("agent 注册失败");
  });

  it("listings failure (non-zero exit) fails closed with detail", async () => {
    const fetchImpl = (async () => registerResponse()) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 2,
      stdout: JSON.stringify(listingReport({ errors: ["SKU-9: kiwi-catalog returned HTTP 400"] })),
      stderr: "",
    }));

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.steps.listings.ok).toBe(false);
    expect(report.steps.listings.errors).toContain("SKU-9: kiwi-catalog returned HTTP 400");
  });

  it("incompatible shopping-cli version fails closed before registration (D3)", async () => {
    const fetchImpl = (async () => registerResponse()) as typeof fetch;
    const spawnArgs: string[] = [];
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: JSON.stringify(listingReport()), stderr: "" }),
      spawnArgs,
      "shopping.py 1.9.9\n", // 低于支持范围 >= 2.0.0
    );

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.steps.shopping_cli_compat.ok).toBe(false);
    expect(report.steps.shopping_cli_compat.version).toBe("shopping.py 1.9.9");
    expect(report.steps.shopping_cli_compat.error).toContain("超出 Kiwi 支持范围");
    expect(spawnArgs.length).toBe(0); // listings 未执行
  });
});
