/**
 * 商品发布体验回归：勾选已导入/已有商品 + 填分类 → 表格预览 → 确认 → 表格结果。
 *
 * 断言页面脚本真实行为（VM 执行全部 <script>）：
 *  - 不再手输 "SKU | 分类"，不再原样展示 JSON；
 *  - 预览/结果表格化，数量准确，链接严格转义且拒绝非 http(s)；
 *  - 预览展示实际链接、fresh_until 与其余公开字段，并区分草稿到期/商品新鲜期；
 *  - 预览后锁定选择；选择变化使旧确认失效；失败不丢旧草稿引用；
 *  - 商品超过 100 件时跟随 next_cursor，全部可选且计数准确；
 *  - checkPublication 保留 pending 原草稿续办。
 */
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";

type El = {
  value: string;
  innerHTML: string;
  textContent: string;
  className: string;
  style: { display: string };
  disabled: boolean;
  setAttribute: () => void;
  removeAttribute: () => void;
  addEventListener: () => void;
  querySelectorAll: () => never[];
  classList: { add: () => void; remove: () => void };
};
function el(): El {
  return {
    value: "", innerHTML: "", textContent: "", className: "", style: { display: "" }, disabled: false,
    setAttribute: () => {}, removeAttribute: () => {}, addEventListener: () => {},
    querySelectorAll: () => [], classList: { add: () => {}, remove: () => {} },
  };
}
type Control = { checked: boolean; value: string; disabled?: boolean };
type Row = {
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => Control | null;
  box: Control;
  input: Control;
};
function row(sku: string, checked: boolean, category: string): Row {
  const box: Control = { checked, value: "", disabled: false };
  const input: Control = { checked: false, value: category, disabled: false };
  return {
    box,
    input,
    getAttribute: (name: string) => (name === "data-sku" ? sku : null),
    querySelector: (selector: string) =>
      selector.includes("pub-pick") ? box : selector.includes("pub-category") ? input : null,
  };
}

function pageScript(): string {
  const html = renderMerchantManagementPage({ productAuthority: "file", catalogConnection: true });
  // 页面有两个 <script>（视图与命令实现分片），必须全部执行才能共享全局函数。
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)]
    .map((match) => match[1] ?? "")
    .join("\n");
}

const DRAFT = {
  draft_id: "flp_test_0123456789ab",
  digest: "sha256:preview-digest",
  expires_at: "2030-12-31T00:00:00Z",
  items: [
    {
      sku: "SKU-1", category: "陶瓷杯", status: "ready",
      listing: {
        title: "手工陶瓷杯", source_product_ref: "SKU-1", category: "陶瓷杯",
        handoff_destination_ref: "https://shop.example/p?a=1&b=2",
        fresh_until: "2027-01-31T00:00:00+00:00",
        summary: "手工拉坯", brand: "陶社", regions: ["华东"], tags: ["陶瓷", "手作"],
        commercial_hints: { moq: 2, lead_time_hint: "3-5天", supports_customization: true },
        handoff_destination_types: ["commerce"],
        owner_agent_id: "private-owner", merchant_id: "private-merchant",
      },
    },
    {
      sku: "SKU-2", category: "玻璃杯", status: "ready",
      listing: {
        title: "耐热玻璃杯", source_product_ref: "SKU-2", category: "玻璃杯",
        handoff_destination_ref: "javascript:alert(1)",
      },
    },
  ],
};
const RECEIPT = {
  draft_id: DRAFT.draft_id,
  digest: DRAFT.digest,
  status: "succeeded",
  succeeded: 2, failed: 0, pending: 0,
  results: [
    { sku: "SKU-1", status: "succeeded", listing_id: "lst_1" },
    { sku: "SKU-2", status: "succeeded", listing_id: "lst_2" },
  ],
};

type MountOptions = {
  rows?: Row[];
  productPages?: Array<{ items: Array<Record<string, unknown>>; next_cursor?: string | null }>;
  commitFailsOnCall?: number;
  receipts?: Array<Record<string, unknown>>;
  published?: Array<{ sku: string; listing_id?: string; publication_state: string }>;
};

async function mount(options: MountOptions = {}) {
  const elements: Record<string, El> = {};
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const paths: string[] = [];
  const rows = options.rows ?? [];
  const pages = options.productPages ?? [{ items: [
    { sku: "SKU-1", title: "陶瓷杯", status: "在售" },
    { sku: "SKU-2", title: "玻璃杯", status: "在售" },
  ], next_cursor: null }];
  let commitCalls = 0;
  const fetchImpl = async (path: string, init?: { method?: string; body?: string }) => {
    paths.push(path);
    if (path === "/merchant/api/session") {
      return Response.json({ csrf_token: "tok", role: "owner", merchant_id: "mkt_1" });
    }
    if (path.startsWith("/merchant/api/products?limit=100")) {
      const url = new URL("https://x" + path);
      const cursor = url.searchParams.get("cursor");
      const page = cursor === null ? pages[0] : pages.find((_, index) => String(index) === cursor);
      return Response.json(page ?? { items: [], next_cursor: null });
    }
    if (path === "/merchant/api/v1/products/publication-status") {
      return Response.json({ results: options.published ?? [] });
    }
    if (path === "/merchant/api/v1/products/publication-drafts" && init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json(DRAFT);
    }
    if (path.endsWith("/commit") && init?.method === "POST") {
      commitCalls += 1;
      posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (options.commitFailsOnCall !== undefined && commitCalls === options.commitFailsOnCall) {
        return Response.json({ message: "暂不可用" }, { status: 503 });
      }
      return Response.json(RECEIPT);
    }
    if (path.startsWith("/merchant/api/v1/products/publication-drafts/")) {
      return Response.json({ draft: DRAFT, found: true, receipts: options.receipts ?? RECEIPT.results });
    }
    return Response.json({});
  };
  const context = createContext({
    URL, Date, Math, Response, JSON, Promise, Array, String, Object, Error, setTimeout,
    document: {
      getElementById: (id: string) => (elements[id] ??= el()),
      querySelectorAll: (selector: string) =>
        selector === "#pub-rows tr" ? rows
          : selector === "#pub-rows input.pub-pick" ? rows.map((item) => item.box)
            : [],
    },
    fetch: fetchImpl,
  });
  await runInContext(pageScript(), context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { context, elements, posts, paths, rows };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("商品发布体验（勾选 + 分类 → 表格预览/结果）", () => {
  it("商品页用选择表替代手输 SKU，并说明导入按 SKU 追加", async () => {
    const { context } = await mount();
    const html = (await runInContext("views.products()", context)) as string;
    expect(html).toContain('id="pub-rows"');
    expect(html).toContain('data-sku="SKU-1"');
    expect(html).toContain('class="pub-pick"');
    expect(html).toContain('class="pub-category"');
    expect(html).toContain('id="pub-select-all"');
    expect(html).toContain("全选当前商品");
    expect(html).toContain("预览公开内容");
    expect(html).toContain("按 SKU 追加/更新");
    expect(html).toContain("文件里没有的商品会保留");
    expect(html).not.toContain("整表替换");
    // 只有一个商品表：不再出现上下重复的列表。
    expect((html.match(/id="pub-rows"/g) ?? []).length).toBe(1);
    expect(html).not.toContain("publication-selection");
    expect(html).not.toContain("用英文竖线分隔");
  });

  it("显示目录发布状态，并能用全选勾选当前商品", async () => {
    const rows = [row("SKU-1", false, ""), row("SKU-2", false, "")];
    const { context } = await mount({
      rows,
      published: [{ sku: "SKU-1", listing_id: "lst_1", publication_state: "ACTIVE" }],
    });
    const html = (await runInContext("views.products()", context)) as string;
    expect(html).toContain("已发布到目录 1 件，未发布 1 件。");
    expect(html).toContain("已发布");
    expect(html).toContain("未发布");
    await runInContext("togglePublicationPicks({ checked: true })", context);
    expect(rows[0]!.box.checked).toBe(true);
    expect(rows[1]!.box.checked).toBe(true);
    await runInContext("togglePublicationPicks({ checked: false })", context);
    expect(rows[0]!.box.checked).toBe(false);
    expect(rows[1]!.box.checked).toBe(false);
  });

  it("预览用表格展示实际链接、fresh_until 与其余公开字段，并区分草稿到期与新鲜期", async () => {
    const rows = [row("SKU-1", true, "陶瓷杯"), row("SKU-2", true, "玻璃杯")];
    const { context, elements, posts } = await mount({ rows });
    await runInContext("previewPublication()", context);
    await flush();

    expect(posts[0]?.body).toEqual({
      selections: [
        { sku: "SKU-1", category: "陶瓷杯" },
        { sku: "SKU-2", category: "玻璃杯" },
      ],
    });
    const html = elements["publication-result"]!.innerHTML;
    expect(html).toContain("将公开 2 件商品");
    expect(html).toContain("<table");
    expect(html).toContain("手工陶瓷杯");
    expect(html).toContain("陶瓷杯");
    expect(html).toContain('href="https://shop.example/p?a=1&amp;b=2"');
    expect(html).not.toContain("javascript:");
    // fresh_until 是商品新鲜期；草稿 expires_at 单独标注为草稿到期时间。
    expect(html).toContain("2027-01-31T00:00:00+00:00");
    expect(html).toContain("不是商品新鲜期");
    expect(html).toContain("2030-12-31T00:00:00Z（草稿到期时间）");
    // 其余公开字段（白名单）可见。
    expect(html).toContain("摘要：手工拉坯");
    expect(html).toContain("品牌：陶社");
    expect(html).toContain("起订量：2");
    expect(html).toContain("交期提示：3-5天");
    // 私有字段与 JSON 不出现。
    expect(html).not.toContain("private-owner");
    expect(html).not.toContain("private-merchant");
    expect(html).not.toContain("<pre>");
  });

  it("预览后锁定选择；选择被改动时作废旧确认且不再提交", async () => {
    const rows = [row("SKU-1", true, "陶瓷杯"), row("SKU-2", true, "玻璃杯")];
    const { context, elements, posts } = await mount({ rows });
    await runInContext("previewPublication()", context);
    await flush();
    expect(rows[0]!.box.disabled).toBe(true);
    expect(rows[0]!.input.disabled).toBe(true);
    expect(elements["publication-result"]!.innerHTML).toContain("重新选择（作废本次预览）");

    rows[0]!.input.value = "被改动的分类";
    await runInContext("commitPublication()", context);
    await flush();
    expect(posts.filter((p) => p.path.endsWith("/commit"))).toHaveLength(0);
    expect(elements["bar"]!.textContent).toContain("预览后选择或分类已变化");
    expect(await runInContext("publicationDraft", context)).toBe(null);
  });

  it("提交网络失败保留旧草稿引用，可用同一草稿重试", async () => {
    const rows = [row("SKU-1", true, "陶瓷杯"), row("SKU-2", true, "玻璃杯")];
    const { context, elements, posts } = await mount({ rows, commitFailsOnCall: 1 });
    await runInContext("previewPublication()", context);
    await flush();
    await runInContext("commitPublication()", context);
    await flush();
    expect(elements["bar"]!.textContent).toContain("请保留本页");
    expect(await runInContext("publicationDraft !== null", context)).toBe(true);

    await runInContext("commitPublication()", context);
    await flush();
    const commits = posts.filter((p) => p.path.endsWith("/commit"));
    expect(commits).toHaveLength(2);
    expect(commits[1]?.body).toEqual({ expected_digest: DRAFT.digest, confirm_publication: true });
  });

  it("确认发布后以表格回执呈现数量与逐项结果，不展示 JSON", async () => {
    const rows = [row("SKU-1", true, "陶瓷杯"), row("SKU-2", true, "玻璃杯")];
    const { context, elements, posts } = await mount({ rows });
    await runInContext("previewPublication()", context);
    await flush();
    await runInContext("commitPublication()", context);
    await flush();

    const commit = posts.find((p) => p.path.endsWith("/commit"));
    expect(commit?.body).toEqual({ expected_digest: DRAFT.digest, confirm_publication: true });
    const html = elements["publication-result"]!.innerHTML;
    expect(html).toContain("发布结果");
    expect(html).toContain("共 2 件：成功 2，失败 0，待确认 0");
    expect(html).toContain("<td>SKU-1</td>");
    expect(html).toContain("已确认");
    expect(html).not.toContain("<pre>");
  });

  it("checkPublication 对 pending 结果保留原草稿续办", async () => {
    const rows = [row("SKU-1", true, "陶瓷杯"), row("SKU-2", true, "玻璃杯")];
    const { context, elements } = await mount({
      rows,
      receipts: [
        { sku: "SKU-1", status: "pending" },
        { sku: "SKU-2", status: "succeeded", listing_id: "lst_2" },
      ],
    });
    await runInContext("previewPublication()", context);
    await flush();
    await runInContext("checkPublication()", context);
    await flush();
    const html = elements["publication-result"]!.innerHTML;
    expect(html).toContain("原草稿回执");
    expect(html).toContain("待确认");
    expect(html).toContain("按原草稿继续确认");
  });

  it("超过 100 件商品时跟随 next_cursor，全部可选且计数准确", async () => {
    const page1 = {
      items: Array.from({ length: 100 }, (_, index) => ({ sku: `S-${index}`, title: `商品${index}`, status: "在售" })),
      next_cursor: "1",
    };
    const page2 = {
      items: [{ sku: "S-100", title: "商品100", status: "在售" }],
      next_cursor: null,
    };
    const { context, paths } = await mount({ productPages: [page1, page2] });
    const html = (await runInContext("views.products()", context)) as string;
    expect(html).toContain("商品与目录发布（101）");
    expect(html).toContain('data-sku="S-0"');
    expect(html).toContain('data-sku="S-100"');
    expect(paths).toContain("/merchant/api/products?limit=100");
    expect(paths.some((p) => p.includes("cursor=1"))).toBe(true);
  });

  it("勾选后缺分类时明确提示且不发发布请求", async () => {
    const rows = [row("SKU-1", true, ""), row("SKU-2", false, "")];
    const { context, elements, posts } = await mount({ rows });
    await runInContext("previewPublication()", context);
    await flush();
    expect(elements["bar"]!.textContent).toContain("请为已勾选的商品填写分类：SKU-1");
    expect(posts).toHaveLength(0);
  });
});
