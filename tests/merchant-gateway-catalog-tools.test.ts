/**
 * 商家连接器第 0 版目录工具（`kiwi_catalog_*`）与凭据保管测试。
 *
 * 覆盖：
 * - 凭据保管 AES-GCM 往返；换密钥/过期/删除后取不到（fail-closed）；
 * - 工具按 scope 收敛；写工具在 catalog:read 下既不可见也不可调用；
 * - 草稿写入使用该商家的目录凭据、merchant_id 只来自绑定（不看入参）；
 * - request_publish **不发布**：只保存草稿并返回门户确认入口；
 * - 无凭据/凭据失效时明确报「需要重新连接」，不返回过期数据。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { GatewayCredentialVault } from "../src/merchant-gateway/credential-vault.js";
import { buildCatalogTools } from "../src/merchant-gateway/catalog-tools.js";
import type {
  MerchantPublicationClient,
  MerchantPublicationView,
  PublicationDraftInput,
} from "../src/merchant-gateway/catalog-publications.js";

const MERCHANT_ID = "mkt_acme_1";
const CREDENTIAL = "cmt_merchant-credential";
const NOW = "2026-09-17T10:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

function vault(secret: string, now: string = NOW): GatewayCredentialVault {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return new GatewayCredentialVault({ db, secret, now: () => now });
}

function publicationView(
  overrides: Partial<MerchantPublicationView> = {},
): MerchantPublicationView {
  return {
    publication_id: "mpub_1",
    merchant_id: MERCHANT_ID,
    merchant_display_name: "Acme 商贸",
    title: "明前龙井",
    category: "",
    summary: "",
    shop_platform: "",
    shop_url: "",
    faq: [],
    source_kind: "merchant_declared",
    status: "draft",
    version: 1,
    published_at: "",
    expires_at: "",
    updated_at: NOW,
    inquiry_available: false,
    ...overrides,
  };
}

interface RecordedCall {
  method: "saveDraft" | "getPublication" | "withdraw" | "fetchStats";
  token: string;
  input?: PublicationDraftInput | string;
}

function fakeClient(calls: RecordedCall[], options: { fail?: boolean } = {}) {
  return {
    saveDraft: async (token: string, input: PublicationDraftInput) => {
      calls.push({ method: "saveDraft", token, input });
      if (options.fail === true) throw new Error("目录暂不可用");
      const result: {
        publication: MerchantPublicationView;
        created: boolean;
        idempotent: boolean;
      } = {
        publication: publicationView({ title: input.title }),
        created: true,
        idempotent: false,
      };
      return result;
    },
    getPublication: async (token: string, publicationId: string) => {
      calls.push({ method: "getPublication", token, input: publicationId });
      return publicationView({
        publication_id: publicationId,
        status: "published",
        category: "茶",
        summary: "明前采摘",
        shop_url: "https://acme.example/shop",
        faq: [{ question: "保修多久？", answer: "一年" }],
      });
    },
    withdraw: async (token: string, publicationId: string) => {
      calls.push({ method: "withdraw", token, input: publicationId });
      return publicationView({ publication_id: publicationId, status: "withdrawn" });
    },
    fetchStats: async (token: string) => {
      calls.push({ method: "fetchStats", token });
      if (options.fail === true) throw new Error("目录暂不可用");
      return {
        followersTotal: 42,
        viewsTotal: 120,
        publications: [
          {
            publicationId: "mpub_1",
            title: "明前龙井",
            status: "published",
            viewCount: 100,
            publishedAt: NOW,
          },
        ],
      };
    },
  } as unknown as MerchantPublicationClient;
}

function tools(calls: RecordedCall[], options: { withCredential?: boolean; fail?: boolean } = {}) {
  const store = vault("test-secret");
  if (options.withCredential !== false) {
    store.put(MERCHANT_ID, CREDENTIAL, "2099-01-01T00:00:00.000Z");
  }
  return {
    bundle: buildCatalogTools(MERCHANT_ID, {
      client: fakeClient(calls, options),
      credentials: store,
      portalBaseUrl: "https://catalog.kiwi.example/",
    }),
    store,
  };
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("GatewayCredentialVault", () => {
  it("加密往返：写入后可取回明文与到期时间", () => {
    const store = vault("deployment-secret");
    store.put(MERCHANT_ID, CREDENTIAL, "2099-01-01T00:00:00.000Z");
    expect(store.get(MERCHANT_ID)).toEqual({
      token: CREDENTIAL,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  it("换密钥后取不到（fail-closed，不返回噪音）", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const first = new GatewayCredentialVault({ db, secret: "key-one", now: () => NOW });
    first.put(MERCHANT_ID, CREDENTIAL, "2099-01-01T00:00:00.000Z");
    const second = new GatewayCredentialVault({ db, secret: "key-two", now: () => NOW });
    expect(second.get(MERCHANT_ID)).toBeUndefined();
  });

  it("过期与删除后取不到", () => {
    const store = vault("deployment-secret", "2030-01-01T00:00:00.000Z");
    store.put(MERCHANT_ID, CREDENTIAL, "2029-01-01T00:00:00.000Z");
    expect(store.get(MERCHANT_ID)).toBeUndefined();
    store.put(MERCHANT_ID, CREDENTIAL, "2031-01-01T00:00:00.000Z");
    expect(store.get(MERCHANT_ID)).toBeDefined();
    store.delete(MERCHANT_ID);
    expect(store.get(MERCHANT_ID)).toBeUndefined();
  });

  it("缺少密钥时构造失败（不退回明文存储）", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    expect(() => new GatewayCredentialVault({ db, secret: "  " })).toThrow(/credential secret/);
  });
});

describe("目录工具（kiwi_catalog_*）", () => {
  it("按 scope 收敛工具列表", async () => {
    const { bundle } = tools([]);
    const readOnly = (await bundle.listTools(["catalog:read"])).map((t) => t.name);
    expect(readOnly).toContain("kiwi_catalog_get_merchant_profile");
    expect(readOnly).not.toContain("kiwi_catalog_save_publication_draft");
    const full = (await bundle.listTools(["catalog:read", "catalog:write"])).map((t) => t.name);
    expect(full).toContain("kiwi_catalog_save_publication_draft");
    expect(full).toContain("kiwi_catalog_request_publish");
    expect(full).toContain("kiwi_catalog_withdraw_publication");
    expect(await bundle.listTools(undefined)).toHaveLength(full.length);
  });

  it("scope 不足时写工具被拒绝（不只靠 tools/list 过滤）", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls);
    const result = await bundle.call(
      "kiwi_catalog_save_publication_draft",
      { merchant_display_name: "Acme 商贸", title: "明前龙井" },
      ["catalog:read"],
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("scope 不足");
    expect(calls).toHaveLength(0);
  });

  it("保存草稿使用该商家的目录凭据，merchant_id 不看入参", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls);
    const result = await bundle.call(
      "kiwi_catalog_save_publication_draft",
      {
        merchant_display_name: "Acme 商贸",
        title: "明前龙井",
        faq: [{ question: "保修多久？", answer: "一年" }],
      },
      ["catalog:read", "catalog:write"],
    );
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe(CREDENTIAL);
    expect(calls[0]?.input).toMatchObject({ merchantDisplayName: "Acme 商贸", title: "明前龙井" });
    const payload = JSON.parse(text(result)) as { publication_id: string; confirm_url: string };
    expect(payload.publication_id).toBe("mpub_1");
    expect(payload.confirm_url).toBe("https://catalog.kiwi.example/portal/publications");
  });

  it("request_publish 只保存草稿并给出确认入口（不发布）", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls);
    const result = await bundle.call(
      "kiwi_catalog_request_publish",
      { merchant_display_name: "Acme 商贸", title: "明前龙井" },
      ["catalog:write"],
    );
    expect(calls[0]?.method).toBe("saveDraft");
    const payload = JSON.parse(text(result)) as {
      status: string;
      note: string;
      confirm_url: string;
    };
    expect(payload.status).toBe("draft");
    expect(payload.note).toContain("尚未发布");
    expect(payload.confirm_url).toContain("/portal/publications");
  });

  it("缺少必填字段时不调用目录", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls);
    const result = await bundle.call(
      "kiwi_catalog_save_publication_draft",
      { merchant_display_name: "", title: "" },
      ["catalog:write"],
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("无凭据时明确要求重新连接", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls, { withCredential: false });
    const result = await bundle.call(
      "kiwi_catalog_get_publication",
      { publication_id: "mpub_1" },
      ["catalog:read"],
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("重新连接");
    expect(calls).toHaveLength(0);
  });

  it("撤回与状态查询透传 publication_id 与凭据", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls);
    await bundle.call("kiwi_catalog_withdraw_publication", { publication_id: "mpub_9" }, [
      "catalog:write",
    ]);
    await bundle.call("kiwi_catalog_get_publication", { publication_id: "mpub_9" }, [
      "catalog:read",
    ]);
    expect(calls.map((c) => [c.method, c.input])).toEqual([
      ["withdraw", "mpub_9"],
      ["getPublication", "mpub_9"],
    ]);
    expect(calls.every((c) => c.token === CREDENTIAL)).toBe(true);
  });

  it("读单条资料带回**可编辑内容**：改写文案前能拿到原文，不必凭记忆重写", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls);
    const result = await bundle.call("kiwi_catalog_get_publication", { publication_id: "mpub_1" }, [
      "catalog:read",
    ]);
    const payload = JSON.parse(text(result)) as {
      status: string;
      content: {
        merchant_display_name: string;
        title: string;
        category: string;
        summary: string;
        shop_url: string;
        faq: Array<{ question: string; answer: string }>;
      };
    };
    expect(payload.status).toBe("published");
    expect(payload.content).toEqual({
      merchant_display_name: "Acme 商贸",
      title: "明前龙井",
      category: "茶",
      summary: "明前采摘",
      shop_platform: "",
      shop_url: "https://acme.example/shop",
      faq: [{ question: "保修多久？", answer: "一年" }],
    });
  });

  it("经营汇总：用该商家的目录凭据读匿名聚合，含关注数与各资料浏览量", async () => {
    const calls: RecordedCall[] = [];
    const { bundle } = tools(calls);
    const result = await bundle.call("kiwi_catalog_get_merchant_stats", {}, ["catalog:read"]);
    expect(calls.map((c) => c.method)).toEqual(["fetchStats"]);
    // 凭据取自会话绑定的 merchant_id，不看入参。
    expect(calls[0]?.token).toBe(CREDENTIAL);
    const payload = JSON.parse(text(result)) as {
      followers_total: number;
      views_total: number;
      publications: Array<{ publication_id: string; view_count: number }>;
    };
    expect(payload.followers_total).toBe(42);
    expect(payload.views_total).toBe(120);
    expect(payload.publications).toEqual([
      expect.objectContaining({ publication_id: "mpub_1", view_count: 100 }),
    ]);
    // 隐私：只回聚合数字，明示没有名单与群发通道，避免模型向商家承诺触达能力。
    expect(text(result)).toContain("匿名");
    expect(text(result)).not.toContain("@");
  });

  it("经营汇总需要 catalog:read；scope 不足时拒绝", async () => {
    const { bundle } = tools([]);
    const result = await bundle.call("kiwi_catalog_get_merchant_stats", {}, ["catalog:write"]);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("catalog:read");
  });

  it("目录故障时返回可解释错误而不是抛异常", async () => {
    const { bundle } = tools([], { fail: true });
    const result = await bundle.call(
      "kiwi_catalog_save_publication_draft",
      { merchant_display_name: "Acme 商贸", title: "明前龙井" },
      ["catalog:write"],
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("目录操作失败");
  });
});
