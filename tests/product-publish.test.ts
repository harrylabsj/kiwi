/**
 * `kiwi merchant publish` 编排测试（product-strategy rev1.1 §4.5/§19 D2）。
 *
 * 覆盖：
 * - 成功路径：agent 注册（mock fetch）+ shopping-cli spawn（mock spawn）→
 *   分步报告 {agent, listings} + 计数；
 * - spawn 参数构造：--db / --merchant / --kiwi-catalog-url /
 *   --owner-token-secret / --owner-agent-id 全部正确传递；
 * - agent 注册失败 → 短路（listings skipped），ok:false；
 * - listings 非零退出 / 报告 errors → ok:false + 明细；
 * - owner token 与 kiwi-catalog 派生一致（固定向量）。
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { AgentProfile } from "../src/config/profile.js";
import { merchantPublish } from "../src/product-publish.js";

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

describe("merchant publish orchestration (D2)", () => {
  it("registers the agent then spawns shopping-cli with correct args", async () => {
    let spawnArgs: string[] = [];
    const fetchImpl = (async () => registerResponse()) as typeof fetch;
    const spawnImpl = ((_cmd: string, args: string[]) => {
      spawnArgs = args;
      return { status: 0, stdout: JSON.stringify(listingReport()), stderr: "" };
    }) as unknown as typeof import("node:child_process").spawnSync;

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.steps.agent.ok).toBe(true);
    expect(report.steps.agent.catalog_agent_id).toBe("cagt_published_001");
    expect(report.steps.listings.ok).toBe(true);
    expect(report.steps.listings.published).toBe(2);
    expect(report.steps.listings.skipped).toBe(1);

    // spawn 参数：--db / --merchant / --kiwi-catalog-url /
    // --owner-token-secret / --owner-agent-id
    expect(spawnArgs).toContain("--db");
    expect(spawnArgs[spawnArgs.indexOf("--db") + 1]).toBe("/tmp/shop.sqlite");
    expect(spawnArgs).toContain("--merchant");
    expect(spawnArgs[spawnArgs.indexOf("--merchant") + 1]).toBe(MERCHANT_ID);
    expect(spawnArgs).toContain("--kiwi-catalog-url");
    expect(spawnArgs[spawnArgs.indexOf("--kiwi-catalog-url") + 1]).toBe("http://127.0.0.1:8600");
    expect(spawnArgs).toContain("--owner-token-secret");
    expect(spawnArgs[spawnArgs.indexOf("--owner-token-secret") + 1]).toBe(SECRET);
    expect(spawnArgs).toContain("--owner-agent-id");
    expect(spawnArgs[spawnArgs.indexOf("--owner-agent-id") + 1]).toBe("cagt_published_001");
  });

  it("owner token derivation matches kiwi-catalog (fixed vector)", async () => {
    // 与 kiwi-catalog api/auth.py owner_token() 一致：
    // HMAC-SHA256(secret, "kiwi-catalog-owner:{merchant_id}")
    const expected = createHmac("sha256", SECRET)
      .update(`kiwi-catalog-owner:${MERCHANT_ID}`)
      .digest("hex");
    let registerBody = "";
    const fetchImpl = (async (_url: string, init?: Parameters<typeof fetch>[1]) => {
      registerBody = String(init?.body ?? "");
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = (() => ({
      status: 0,
      stdout: JSON.stringify(listingReport()),
      stderr: "",
    })) as unknown as typeof import("node:child_process").spawnSync;

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
    // 一商家一 agent 约束下二次 register 会 409——编排应先查询复用（rev1.1 §4.5）
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
    let spawnArgs: string[] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      spawnArgs = args;
      return { status: 0, stdout: JSON.stringify(listingReport()), stderr: "" };
    }) as unknown as typeof import("node:child_process").spawnSync;

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
    expect(registerCalled).toBe(false); // 查询命中 → 不注册
    expect(spawnArgs[spawnArgs.indexOf("--owner-agent-id") + 1]).toBe("cagt_existing_001");
  });

  it("agent registration failure short-circuits (listings skipped)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: "catalog register failed: boom" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    let spawned = false;
    const spawnImpl = (() => {
      spawned = true;
      return { status: 0, stdout: "{}", stderr: "" };
    }) as unknown as typeof import("node:child_process").spawnSync;

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
    expect(spawned).toBe(false);
    expect(report.steps.listings.skipped_reason).toContain("agent 注册失败");
  });

  it("listings failure (non-zero exit) fails closed with detail", async () => {
    const fetchImpl = (async () => registerResponse()) as typeof fetch;
    const spawnImpl = (() => ({
      status: 2,
      stdout: JSON.stringify(
        listingReport({ errors: ["SKU-9: kiwi-catalog returned HTTP 400"] }),
      ),
      stderr: "",
    })) as unknown as typeof import("node:child_process").spawnSync;

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

  it("listings non-zero exit without report adds exit detail", async () => {
    const fetchImpl = (async () => registerResponse()) as typeof fetch;
    const spawnImpl = (() => ({
      status: 127,
      stdout: "",
      stderr: "shopping: command not found",
    })) as unknown as typeof import("node:child_process").spawnSync;

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.steps.listings.errors?.[0]).toContain("shopping-cli exited 127");
  });
});
