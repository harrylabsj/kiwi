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

function projectionsReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    results: [
      { listing_type: "product", source_product_ref: "SKU-1", title: "Widget A", category: "widgets" },
      { listing_type: "product", source_product_ref: "SKU-2", title: "Widget B", category: "widgets" },
    ],
    ...overrides,
  };
}

/**
 * fetch mock：
 * - register/lookup 返回 agent；
 * - /v1/listings/publish 返回 ok（记录 body）；
 * - /v1/listings/{id}/withdraw 返回 ok（记录 URL）；
 * - /v1/agents/{id}/listings 自查返回 selfCheck（withdraw reconcile 用）。
 */
function publishFetch(
  options: {
    publishBody?: string[];
    publishError?: string;
    withdrawUrls?: string[];
    selfCheck?: Array<Record<string, unknown>>;
  } = {},
): typeof fetch {
  return (async (url: string, init?: Parameters<typeof fetch>[1]) => {
    const u = String(url);
    if (u.includes("/v1/listings/publish")) {
      if (options.publishError !== undefined) {
        return new Response(JSON.stringify({ ok: false, error: options.publishError }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (options.publishBody !== undefined) options.publishBody.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({ ok: true, listing: { listing_id: "lst_" + options.publishBody?.length } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/v1/listings/")) {
      // withdraw（publish 已在上面匹配）
      if (options.withdrawUrls !== undefined) options.withdrawUrls.push(u);
      return new Response(JSON.stringify({ ok: true, listing: { listing_id: "lst_w" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/v1/agents/")) {
      // publisher 自查端点（GET /v1/agents/{id}/listings）
      return new Response(JSON.stringify({ ok: true, results: options.selfCheck ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return registerResponse();
  }) as unknown as typeof fetch;
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
  it("reads projections then publishes each direct to catalog", async () => {
    const spawnArgs: string[] = [];
    const publishBodies: string[] = [];
    const fetchImpl = publishFetch({ publishBody: publishBodies });
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: JSON.stringify(projectionsReport()), stderr: "" }),
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
    expect(publishBodies.length).toBe(2);
    // 每条 publish body 带 owner 身份（merchant_id / owner_agent_id / owner_token）
    for (const body of publishBodies) {
      expect(body).toContain(`"merchant_id":"${MERCHANT_ID}"`);
      expect(body).toContain('"owner_agent_id":"cagt_published_001"');
      expect(body).toContain('"owner_token":');
    }

    const listingArgs = spawnArgs[0]?.split(" ") ?? [];
    expect(listingArgs).toContain("--db");
    expect(listingArgs[listingArgs.indexOf("--db") + 1]).toBe("/tmp/shop.sqlite");
    expect(listingArgs).toContain("listings");
    expect(listingArgs).toContain("projections");
    expect(listingArgs).not.toContain("list");
    expect(listingArgs).toContain("--merchant");
    expect(listingArgs[listingArgs.indexOf("--merchant") + 1]).toBe(MERCHANT_ID);
    expect(listingArgs).toContain("--format");
    expect(listingArgs[listingArgs.indexOf("--format") + 1]).toBe("json");
    expect(listingArgs).not.toContain("--owner-token-secret"); // 投影读取不携带凭据
  });

  it("owner token derivation matches kiwi-catalog (fixed vector)", async () => {
    const expected = createHmac("sha256", SECRET)
      .update(`kiwi-catalog-owner:${MERCHANT_ID}`)
      .digest("hex");
    let registerBody = "";
    const publishBodies: string[] = [];
    const fetchImpl = (async (url: string, init?: Parameters<typeof fetch>[1]) => {
      const u = String(url);
      if (u.includes("/v1/listings/publish")) {
        publishBodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true, listing: { listing_id: "lst_x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/agent-catalog/agents/register")) {
        registerBody = String(init?.body ?? "");
      }
      if (u.includes("/v1/agents/")) {
        // publisher 自查端点：返回空（无既有 listings）
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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
    // HMAC 派生 token 同样用于每条 publish body 与 withdraw reconcile
    expect(publishBodies.length).toBe(2);
    for (const body of publishBodies) {
      expect(body).toContain(`"owner_token":"${expected}"`);
    }
  });

  it("strips _provenance and skips empty-category projections", async () => {
    const publishBodies: string[] = [];
    const fetchImpl = publishFetch({ publishBody: publishBodies });
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(
        projectionsReport({
          results: [
            {
              listing_type: "product",
              source_product_ref: "SKU-1",
              title: "Widget A",
              category: "widgets",
              _provenance: { db: "shop.sqlite", table: "products" },
            },
            { listing_type: "product", source_product_ref: "SKU-2", title: "No Category", category: "" },
          ],
        }),
      ),
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

    expect(report.ok).toBe(true);
    expect(report.steps.listings.published).toBe(1);
    expect(report.steps.listings.skipped).toBe(1);
    expect(report.steps.listings.skipped_refs).toEqual(["SKU-2"]);
    expect(publishBodies.length).toBe(1);
    expect(publishBodies[0]).toContain('"source_product_ref":"SKU-1"');
    expect(publishBodies[0]).not.toContain("_provenance");
  });

  it("withdraws product listings missing from projections (DoD #5)", async () => {
    const withdrawUrls: string[] = [];
    const fetchImpl = publishFetch({
      withdrawUrls,
      selfCheck: [
        { listing_id: "lst_keep", listing_type: "product", source_product_ref: "SKU-1", publication_state: "ACTIVE" },
        { listing_id: "lst_gone", listing_type: "product", source_product_ref: "SKU-GONE", publication_state: "ACTIVE" },
        { listing_id: "lst_old", listing_type: "product", source_product_ref: "SKU-OLD", publication_state: "WITHDRAWN" },
        { listing_id: "lst_cap", listing_type: "capability", source_product_ref: "CAP-1", publication_state: "ACTIVE" },
      ],
    });
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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

    expect(report.ok).toBe(true);
    expect(report.steps.listings.withdrawn).toBe(1);
    expect(report.steps.listings.withdrawn_refs).toEqual(["SKU-GONE"]);
    // 只下架投影中消失且未 WITHDRAWN 的 product listing
    expect(withdrawUrls).toHaveLength(1);
    expect(withdrawUrls[0]).toContain("/v1/listings/lst_gone/withdraw");
    expect(withdrawUrls[0]).not.toContain("lst_keep");
    expect(withdrawUrls[0]).not.toContain("lst_old");
    expect(withdrawUrls[0]).not.toContain("lst_cap");
  });

  it("refuses reconcile when projection is empty but ACTIVE listings exist (P1-B)", async () => {
    // 审查 P1-B：空投影 + 既有 ACTIVE listing = 配置错误典型信号
    // （--shopping-cli-merchant 不匹配 / --shopping-cli-db 空库）。此前
    // reconcile 会全量下架且报告仍 ok:true——必须 fail-closed。
    const withdrawUrls: string[] = [];
    const fetchImpl = publishFetch({
      withdrawUrls,
      selfCheck: [
        { listing_id: "lst_1", listing_type: "product", source_product_ref: "SKU-1", publication_state: "ACTIVE" },
        { listing_id: "lst_2", listing_type: "product", source_product_ref: "SKU-2", publication_state: "ACTIVE" },
      ],
    });
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, results: [] }),
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
    expect(report.steps.listings.withdrawn).toBe(0);
    expect(withdrawUrls).toHaveLength(0); // 一条都不下架
    const errors = report.steps.listings.errors ?? [];
    expect(errors.some((e) => e.includes("拒绝 reconcile 下架"))).toBe(true);
  });

  it("allows reconcile when projection is empty and no listings exist (P1-B)", async () => {
    const withdrawUrls: string[] = [];
    const fetchImpl = publishFetch({
      withdrawUrls,
      selfCheck: [{ listing_id: "lst_cap", listing_type: "capability", source_product_ref: "CAP-1", publication_state: "ACTIVE" }],
    });
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, results: [] }),
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

    // 只有 capability listing（不在投影集合、本就不处理）→ 不误报
    expect(report.ok).toBe(true);
    expect(report.steps.listings.withdrawn).toBe(0);
    expect(withdrawUrls).toHaveLength(0);
  });

  it("explicit allowEmptyProjectionReconcile permits mass withdraw (P1-B)", async () => {
    const withdrawUrls: string[] = [];
    const fetchImpl = publishFetch({
      withdrawUrls,
      selfCheck: [
        { listing_id: "lst_1", listing_type: "product", source_product_ref: "SKU-1", publication_state: "ACTIVE" },
      ],
    });
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, results: [] }),
      stderr: "",
    }));

    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      allowEmptyProjectionReconcile: true,
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.steps.listings.withdrawn).toBe(1);
    expect(withdrawUrls).toHaveLength(1);
  });

  it("withdraw reconcile failure is reported (fail-closed)", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/v1/listings/publish")) {
        return new Response(JSON.stringify({ ok: true, listing: { listing_id: "lst_x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/agents/")) {
        return new Response(JSON.stringify({ ok: false, error: "self-check boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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
    expect(report.steps.listings.errors?.[0]).toContain("withdraw reconcile failed");
  });

  it("repeat publish is idempotent: reuses existing agent (lookup first)", async () => {
    let registerCalled = false;
    const spawnArgs: string[] = [];
    const publishBodies: string[] = [];
    const fetchImpl = (async (url: string, init?: Parameters<typeof fetch>[1]) => {
      const u = String(url);
      if (u.includes("/v1/agent-catalog/merchants/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            results: [{ catalog_agent_id: "cagt_existing_001" }],
            next_cursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/v1/listings/publish")) {
        publishBodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true, listing: { listing_id: "lst_y" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/agents/")) {
        // publisher 自查端点：返回空
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      registerCalled = true;
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: JSON.stringify(projectionsReport()), stderr: "" }),
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
    expect(publishBodies[0]).toContain('"owner_agent_id":"cagt_existing_001"');
  });

  it("双身份拆分：投影按 shopping-cli merchant 过滤，publish body 用 catalog 身份", async () => {
    // catalog 身份（profile.agent_id = mkt_<id>，随机 token 场景）与
    // shopping-cli merchant（seller-a）不同——--shopping-cli-merchant 只
    // 映射投影侧，不得覆盖 publish body / owner token / agent 查询身份。
    const spawnArgs: string[] = [];
    const publishBodies: string[] = [];
    const fetchImpl = publishFetch({ publishBody: publishBodies });
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: JSON.stringify(projectionsReport()), stderr: "" }),
      spawnArgs,
    );
    const catalogProfile: AgentProfile = { ...MERCHANT_PROFILE, agent_id: "mkt_seller-a_abc123" };

    const report = await merchantPublish({
      profile: catalogProfile,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerToken: "mkt_random_token",
      shoppingCliMerchant: "seller-a",
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl,
      spawnImpl,
    });

    expect(report.ok).toBe(true);
    // 投影过滤用 shopping-cli merchant
    const listingArgs = spawnArgs[0]?.split(" ") ?? [];
    expect(listingArgs[listingArgs.indexOf("--merchant") + 1]).toBe("seller-a");
    // publish body 用 catalog 身份（agent 注册/owner token 校验基准）
    expect(publishBodies.length).toBe(2);
    for (const body of publishBodies) {
      expect(body).toContain('"merchant_id":"mkt_seller-a_abc123"');
      expect(body).toContain('"owner_token":"mkt_random_token"');
      expect(body).not.toContain('"merchant_id":"seller-a"');
    }
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
      stdout: "",
      stderr: "shopping-cli: projections failed: boom",
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
    expect(report.steps.listings.errors?.[0]).toContain("projections failed");
  });

  it("catalog publish error fails closed with ref detail", async () => {
    const fetchImpl = publishFetch({ publishError: "SKU-9: kiwi-catalog returned HTTP 400" });
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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
    expect(report.steps.listings.errors?.length).toBe(2); // 两条投影都失败
  });

  it("incompatible shopping-cli version fails closed before registration (D3)", async () => {
    const fetchImpl = (async () => registerResponse()) as typeof fetch;
    const spawnArgs: string[] = [];
    const spawnImpl = compatSpawn(
      () => ({ status: 0, stdout: JSON.stringify(projectionsReport()), stderr: "" }),
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

// ── 审查 P1-10 / P1-11 / P2-04：publish 出站安全 ─────────────────────────────
describe("publish 出站安全（P1-10 / P1-11 / P2-04）", () => {
  it("agent_card_url 是绝对 HTTPS URL，不再拼接相对路径（P1-10）", async () => {
    let registerBody = "";
    const fetchImpl = (async (url: string, init?: Parameters<typeof fetch>[1]) => {
      const u = String(url);
      if (u.includes("/v1/listings/publish")) {
        return new Response(JSON.stringify({ ok: true, listing: { listing_id: "lst_x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/agent-catalog/agents/register")) {
        registerBody = String(init?.body ?? "");
      }
      if (u.includes("/v1/agents/")) {
        // publisher 自查端点
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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

    expect(report.ok).toBe(true);
    const parsed = JSON.parse(registerBody) as { agent_card_url?: string };
    // 缺省 domain = merchant-<safeAgentId(agent_id)>.local = merchant-merchant-acme.local
    // → 绝对 HTTPS well-known URL（此前是相对路径 `merchant-…local/.well-known/…`，无 scheme）。
    expect(parsed.agent_card_url).toBe("https://merchant-merchant-acme.local/.well-known/agent-card.json");
    expect(parsed.agent_card_url).toMatch(/^https:\/\/[^/]+\/.well-known\/agent-card\.json$/);
  });

  it("非法 catalog domain（含路径）→ fail-closed 短路（P1-10）", async () => {
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
      stderr: "",
    }));
    const report = await merchantPublish({
      profile: MERCHANT_PROFILE,
      catalogBaseUrl: "http://127.0.0.1:8600",
      ownerTokenSecret: SECRET,
      shoppingCliDb: "/tmp/shop.sqlite",
      catalogDomain: "merchant-acme.local/some/path",
      fetchImpl: publishFetch(),
      spawnImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.steps.agent.ok).toBe(false);
    expect(report.steps.listings.skipped_reason).toContain("agent 注册失败");
  });

  it("owner-token catalog 调用一律 redirect:manual，绝不跟随 3xx（P1-11）", async () => {
    const redirectFlags: Array<string | undefined> = [];
    const fetchImpl = (async (url: string, init?: Parameters<typeof fetch>[1]) => {
      redirectFlags.push((init as { redirect?: string } | undefined)?.redirect);
      const u = String(url);
      if (u.includes("/v1/listings/publish")) {
        return new Response(JSON.stringify({ ok: true, listing: { listing_id: "lst_x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/agents/")) {
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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

    expect(report.ok).toBe(true);
    expect(redirectFlags.length).toBeGreaterThan(0);
    for (const flag of redirectFlags) expect(flag).toBe("manual");
  });

  it("publish 3xx 重定向响应 → fail-closed（不发布、报错；P1-11）", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/v1/listings/publish")) {
        return new Response("", {
          status: 302,
          headers: { location: "https://evil.example/listings" },
        });
      }
      if (u.includes("/v1/agents/")) {
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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
    expect(report.steps.listings.published).toBe(0);
    const errors = report.steps.listings.errors ?? [];
    expect(errors.some((e) => e.includes("must not follow redirects"))).toBe(true);
  });

  it("publish HTTP 200 + ok:false 信封 → fail-closed（P2-04）", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/v1/listings/publish")) {
        // HTTP 200 但信封 ok:false：绝不能当成功（此前若只查 HTTP status 会误判）
        return new Response(JSON.stringify({ ok: false, error: "envelope rejected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/agents/")) {
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return registerResponse();
    }) as typeof fetch;
    const spawnImpl = compatSpawn(() => ({
      status: 0,
      stdout: JSON.stringify(projectionsReport()),
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
    expect(report.steps.listings.published).toBe(0);
    const errors = report.steps.listings.errors ?? [];
    expect(errors.some((e) => e.includes("envelope rejected"))).toBe(true);
  });
});
