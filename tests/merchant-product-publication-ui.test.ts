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
        attributes: { trade_platform: "jd", status: "active", listed: true, capacity: "450 mL", features: "杯身 <手绘> & 双层", internal_note: "private-note" },
        commercial_hints: { moq: 2, lead_time_hint: "3-5天", supports_customization: true },
        handoff_destination_types: ["commerce"],
        owner_agent_id: "private-owner", merchant_id: "private-merchant",
      },
    },
    {
      sku: "SKU-2", category: "玻璃杯", status: "ready",
      listing: {
        title: "耐热玻璃杯", source_product_ref: "SKU-2", category: "玻璃杯",
        summary: "", attributes: {},
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
  saveFailsOnce?: boolean;
  saveStatus?: string;
  saveConflictOnce?: boolean;
  platforms?: Array<{ id: string; label: string }>;
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
  let saveCalls = 0;
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
    if (path.startsWith("/merchant/api/v1/products/edit-state?")) {
      return Response.json({ base_digest: "sha256:edit-base", platforms: options.platforms ?? [{ id: "custom", label: "配置的平台" }], table: {
        schema_version: "0.1.2", runtime_owner_id: "runtime-owner", source: "merchant_upload", generated_at: "2026-11-27T00:00:00Z",
        products: [{ sku: "SKU-1", title: "原名称", price: 19.7, currency: "CNY", unit: "件", stock: 5, updated_at: "2026-11-27T00:00:00Z", valid_until: "2099-01-01T00:00:00Z", status: "active", public_details: { overview: "原简介", capacity: "450 mL" } }],
      } });
    }
    if (path === "/merchant/api/v1/products/import-drafts" && init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ draft_id: "edit-1", digest: "sha256:edit-1" });
    }
    if (path === "/merchant/api/v1/products/import-drafts/edit-1/commit") {
      saveCalls += 1;
      posts.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (options.saveConflictOnce && saveCalls === 1) return Response.json({ code: "precondition_changed", message: "资料已变化" }, { status: 409 });
      if (options.saveFailsOnce && saveCalls === 1) return Response.json({ message: "网络中断" }, { status: 503 });
      return Response.json({ status: options.saveStatus ?? "succeeded", operation_id: "saved-1" });
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
    expect(html).toContain('"public_details":');
    expect(html).toContain("商品介绍和规格仅保存在商家工作台，不随网关发布");
    expect(html).not.toContain("整表替换");
    // 只有一个商品表：不再出现上下重复的列表。
    expect((html.match(/id="pub-rows"/g) ?? []).length).toBe(1);
    expect(html).not.toContain("publication-selection");
    expect(html).not.toContain("用英文竖线分隔");
  });

  it("显示Kiwi网关发布状态，并能用全选勾选当前商品", async () => {
    const rows = [row("SKU-1", false, ""), row("SKU-2", false, "")];
    const { context } = await mount({
      rows,
      published: [{ sku: "SKU-1", listing_id: "lst_1", publication_state: "ACTIVE" }],
    });
    const html = (await runInContext("views.products()", context)) as string;
    expect(html).toContain("已发布到Kiwi网关 1 件，未发布 1 件。");
    expect(html).toContain("已发布");
    expect(html).toContain("未发布");
    await runInContext("togglePublicationPicks({ checked: true })", context);
    expect(rows[0]!.box.checked).toBe(true);
    expect(rows[1]!.box.checked).toBe(true);
    await runInContext("togglePublicationPicks({ checked: false })", context);
    expect(rows[0]!.box.checked).toBe(false);
    expect(rows[1]!.box.checked).toBe(false);
  });

  it("预览只展示五项网关业务字段，并标注草稿到期", async () => {
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
    expect(html).not.toContain('href="https://shop.example/p?a=1&amp;b=2"');
    expect(html).not.toContain("javascript:");
    // Listing 上架即永久；只有草稿 expires_at 是本次预览的到期时间。
    expect(html).not.toContain("新鲜期");
    expect(html).not.toContain("2027-01-31T00:00:00+00:00");
    expect(html).toContain("商品上架后长期有效");
    expect(html).toContain("2030-12-31T00:00:00Z（草稿到期时间）");
    expect(html).toContain('<th>商品名称</th><th>类目</th><th>交易平台</th><th>状态</th><th>上架（是／否）</th>');
    expect(html).toContain('jd'); expect(html).toContain('在售'); expect(html).toContain('是');
    for (const value of ['手工拉坯','杯身','450 mL','private-note','陶社','3-5天']) expect(html).not.toContain(value);
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
    expect(html).toContain("商品与Kiwi网关发布（101）");
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


async function startProductEdit(mounted: Awaited<ReturnType<typeof mount>>) {
  const { context, elements } = mounted;
  await runInContext("current = 'products'; views.products()", context);
  await runInContext("editProduct(0)", context);
  const state = runInContext("productEdit", context) as { table: { products: Array<Record<string, unknown>> } };
  const record = state.table.products[0]!;
  const fields = runInContext("productFields", context) as Array<[string, string, string]>;
  for (const [key, , type] of fields) {
    elements[`product-edit-${key}`] ??= el();
    elements[`product-edit-${key}`]!.value = type === "boolean" ? "" : String(record[key] ?? "");
  }
  elements["product-detail-overview"] ??= el(); elements["product-detail-overview"]!.value = "原简介";
  elements["product-detail-capacity"] ??= el(); elements["product-detail-capacity"]!.value = "450 mL";
  return state;
}

describe("商品直接编辑与发布", () => {
  it("未填字段保持显示；库存区分未知与0；规格完整展示并转义", async () => {
    const { context } = await mount();
    const html = runInContext(`renderProducts([
      {sku:'A',title:'<商品>',stock:null,public_details:{}},
      {sku:'B',title:'其他',stock:0,price_unit:'件',public_details:{overview:'<简介>'}}
    ],{canPublish:true,known:true,published:{}})`, context) as string;
    expect(html).toContain('<th>库存</th>'); expect(html).toContain('待填写（库存未知）');
    expect(html).toContain('无库存（0）'); expect(html).toContain('未填写');
    expect(html).toContain('商品简介'); expect(html).toContain('供货说明'); expect(html).toContain('更新时间');
    expect(html).toContain('&lt;简介&gt;'); expect(html).toContain('修改</button>');
    expect(html).toContain('发布到Kiwi网关');
  });
  it("修改打开所有业务字段，平台为配置下拉；取消不发写请求", async () => {
    const m = await mount(); await startProductEdit(m);
    const html = m.elements['view']!.innerHTML;
    expect(html).toContain('<select id="product-edit-trade_platform"');
    expect(html).toContain('<option value="custom">配置的平台</option>');
    expect(html).not.toContain('<input type="platform"');
    expect(html).toContain('id="product-detail-overview"');
    expect(html).toContain('id="product-edit-stock" required');
    await runInContext('cancelProductEdit()', m.context);
    expect(m.posts).toEqual([]); expect(runInContext('productEdit',m.context)).toBeNull();
  });
  it("任一必填项为空阻止保存，0价格与0库存有效；保存不自动发布", async () => {
    const m = await mount(); await startProductEdit(m);
    for (const key of ['title','price','stock']) {
      const value = m.elements['product-edit-'+key]!.value;
      m.elements['product-edit-'+key]!.value = '';
      await runInContext('saveProduct()',m.context);
      expect(m.posts).toEqual([]);
      expect(m.elements['product-edit-message']!.textContent).toContain('不能为空');
      m.elements['product-edit-'+key]!.value = value;
    }
    m.elements['product-edit-stock']!.value='0'; m.elements['product-edit-price']!.value='0';
    await runInContext('saveProduct()',m.context);
    expect(m.posts).toHaveLength(2);
    const body=m.posts[0]!.body;
    expect(body['base_digest']).toBe('sha256:edit-base');
    expect(body['table']).toMatchObject({products:[{sku:'SKU-1',stock:0,price:0,public_details:{overview:'原简介',capacity:'450 mL'}}]});
    expect(m.posts.every(p=>!p.path.includes('publication'))).toBe(true);
    expect(m.elements['view']!.innerHTML).toContain('修改待发布');
  });
  it("保存网络错误沿用原草稿和幂等键重试，不重新创建变更", async () => {
    const m=await mount({saveFailsOnce:true}); await startProductEdit(m);
    await runInContext('saveProduct()',m.context);
    expect(runInContext('productEdit !== null',m.context)).toBe(true);
    expect(m.elements['product-edit-message']!.textContent).toContain('重试原保存');
    await runInContext('saveProduct()',m.context);
    expect(m.posts).toHaveLength(3);
    expect(m.posts[1]).toEqual(m.posts[2]);
    expect(runInContext('productEdit',m.context)).toBeNull();
  });
  it("保存冲突时阻止再次写入，可取消并重读最新商品", async () => {
    const m = await mount({ saveConflictOnce: true }); await startProductEdit(m);
    await runInContext('saveProduct()', m.context);
    expect(m.elements['product-edit-message']!.textContent).toContain('请取消后重新修改');
    expect(m.elements['view']!.innerHTML).toContain('id="product-edit-save" onclick="saveProduct()" disabled');
    expect(m.elements['view']!.innerHTML).not.toContain('onclick="cancelProductEdit()" disabled');
    await runInContext('saveProduct()', m.context);
    expect(m.posts).toHaveLength(2);
    await runInContext('cancelProductEdit()', m.context);
    expect(runInContext('productEdit',m.context)).toBeNull();
  });
  it("平台配置为空时不插入默认平台；停用原平台不可重新选择", async () => {
    const m = await mount({ platforms: [] }); await startProductEdit(m);
    const html = runInContext("productEdit.table.products[0].trade_platform = 'retired'; renderProductEditor()",m.context) as string;
    expect(html).toContain('selected disabled>retired（已停用，请重新选择）');
    expect(html).not.toContain('value="jd"');
    expect(html).not.toContain('value="custom"');
  });
  it("保存回执未知时保留编辑状态，阻止发布", async () => {
    const m=await mount({saveStatus:'unknown'}); await startProductEdit(m);
    await runInContext('saveProduct()',m.context);
    await runInContext('publishProducts()',m.context);
    expect(runInContext('productEdit !== null',m.context)).toBe(true);
    expect(m.posts.every(p=>!p.path.includes('publication'))).toBe(true);
  });
  it("点击发布创建草稿并确认公开；编辑中禁止发布", async () => {
    const m=await mount({rows:[row('SKU-1',true,'工具')]});
    await runInContext('publishProducts()',m.context);
    expect(m.posts).toHaveLength(2);
    expect(m.posts[1]!.body).toMatchObject({confirm_publication:true,expected_digest:DRAFT.digest});
    const n=await mount();await startProductEdit(n);
    await runInContext('publishProducts()',n.context); expect(n.posts).toEqual([]);
  });
});
