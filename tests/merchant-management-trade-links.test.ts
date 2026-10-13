import { describe, expect, it } from "vitest";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectFileProductRecord } from "../src/cloud/bootstrap.js";
import { createFileProductSource } from "../src/cloud/product-source.js";
import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";

async function productView(items: Record<string, unknown>[]) {
  const page = renderMerchantManagementPage({ productAuthority: "file", catalogConnection: true });
  const script = /<script>([\s\S]*?)<\/script>/i.exec(page)?.[1];
  if (script === undefined) throw new Error("management script missing");
  const context = vm.createContext({ URL, document: { querySelectorAll: () => [] }, fetch: () => new Promise(() => {}) });
  vm.runInContext(script, context);
  context.call = () => Promise.resolve({ items });
  return await vm.runInContext("views.products()", context) as string;
}

describe("merchant file-product marketplace links", () => {
  it.each([
    ["jd", "京东", "100301440825", "https://item.jd.com/100301440825.html"],
    ["taobao", "淘宝", "900719925474099312345", "https://item.taobao.com/item.htm?id=900719925474099312345"],
    ["tmall", "天猫", "123456789", "https://detail.tmall.com/item.htm?id=123456789"],
  ])("renders %s platform, unrounded ID and complete safe product-page link", async (platform, label, id, url) => {
    const html = await productView([{sku:"T-1",title:"<b>sample</b>",currency:"CNY",price:1,price_unit:"piece",status:"active",trade_platform:platform,platform_product_id:id,platform_product_url:url}]);
    expect(html).toContain("<th>交易平台</th><th>平台商品ID</th><th>平台商品页链接</th>");
    expect(html).toContain(`<td>${label}</td><td>${id}</td>`);
    expect(html).toContain(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    expect(html).toContain("&lt;b&gt;sample&lt;/b&gt;");
    expect(html).toContain("交易链接仅为平台商品页");
    expect(html).not.toContain("已付款");
  });

  it("omits unsafe URLs and escapes href attributes and all product text", async () => {
    const unsafe = ["javascript:alert(1)","http://item.jd.com/1.html","https://item.jd.com.evil.example/1.html","https://user:password@item.jd.com/1.html"];
    for (const url of unsafe) {
      const html = await productView([{sku:"unsafe",title:'"><img src=x onerror=alert(1)>',platform_product_url:url}]);
      expect(html).not.toContain(`<a href="${url}`);
      expect(html).not.toContain("<img src=x");
    }
    const html = await productView([{sku:"safe",platform_product_url:'https://item.jd.com/1.html?x="&y=<tag>',platform_product_id:'"<tag>'}]);
    expect(html).toContain('href="https://item.jd.com/1.html?x=&quot;&amp;y=&lt;tag&gt;"');
    expect(html).toContain("&quot;&lt;tag&gt;");
  });
});


it("actual file authority → bootstrap management API projection → working page retains full link", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiwi-ui-trade-projection-"));
  try {
    const file = path.join(dir, "products.json");
    fs.writeFileSync(file, JSON.stringify({schema_version:"0.1.2",runtime_owner_id:"ui-owner",source:"merchant_upload",generated_at:"2026-10-12T00:00:00Z",products:[{
      sku:"T-1",title:"Projection sample",currency:"CNY",unit:"piece",price:1,updated_at:"2026-10-12T00:00:00Z",valid_until:"2099-01-01T00:00:00Z",status:"active",trade_platform:"京东",platform_product_id:"100301440825",supply_note:"PRIVATE-NOTE-NOT-FOR-PROJECTION",
    }]}), {mode:0o600});
    const record = createFileProductSource({file,merchantId:"ui-owner"}).list()[0]!;
    const item = projectFileProductRecord(record, Date.parse("2026-10-12T00:00:00Z"));
    expect(item).toMatchObject({trade_platform:"jd",platform_product_id:"100301440825",platform_product_url:"https://item.jd.com/100301440825.html"});
    expect(JSON.stringify(item)).not.toContain("PRIVATE-NOTE");
    const html = await productView([item as unknown as Record<string,unknown>]);
    expect(html).toContain('href="https://item.jd.com/100301440825.html"');
    expect(html).toContain("京东");
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});
