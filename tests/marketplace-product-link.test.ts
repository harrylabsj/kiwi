import { describe, expect, it } from "vitest";
import {
  buildMarketplaceProductLink,
  parseMarketplaceProductFields,
} from "../src/handoff/marketplace-product-link.js";
import { DEFAULT_TRADE_PLATFORM_RULES } from "../src/handoff/trade-platform-rules.js";

describe("platform product links — fixed public product routes", () => {
  it.each([
    ["京东", "https://item.jd.com/90071992547409931234567890.html"],
    ["JD", "https://item.jd.com/90071992547409931234567890.html"],
    ["淘宝", "https://item.taobao.com/item.htm?id=90071992547409931234567890"],
    ["TAOBAO", "https://item.taobao.com/item.htm?id=90071992547409931234567890"],
    ["天猫", "https://detail.tmall.com/item.htm?id=90071992547409931234567890"],
    ["TMALL", "https://detail.tmall.com/item.htm?id=90071992547409931234567890"],
  ])("%s keeps the entire decimal string", (platform, url) => {
    expect(buildMarketplaceProductLink(platform, "90071992547409931234567890")).toBe(url);
  });
  it("old records with no pair remain unchanged", () => {
    expect(parseMarketplaceProductFields({})).toEqual({});
    expect(buildMarketplaceProductLink("", "")).toBeUndefined();
    expect(buildMarketplaceProductLink(undefined, undefined)).toBeUndefined();
  });
  it.each([
    "0",
    "001",
    "-1",
    "1.2",
    "1e20",
    "123?x=1",
    "123/456",
    "https://item.jd.com/1.html",
    "=123",
    "１２３",
    "١٢٣",
    "123 ",
    " 123",
  ])("rejects malformed ID %s", (id) => {
    expect(() => buildMarketplaceProductLink("jd", id)).toThrow();
  });
  it.each([123, 9007199254740992, null, {}, true])("never converts non-string ID %s", (id) => {
    expect(() => buildMarketplaceProductLink("jd", id)).toThrow();
  });
  it.each(["amazon", "https://item.jd.com", "constructor", "__proto__"])(
    "rejects unsupported platform %s",
    (platform) => {
      expect(() => buildMarketplaceProductLink(platform, "123")).toThrow();
    },
  );
  it("requires both fields together", () => {
    expect(() => buildMarketplaceProductLink("jd", undefined)).toThrow();
    expect(() => buildMarketplaceProductLink(undefined, "123")).toThrow();
  });

  it.each([
    ["京东", "https://item.jd.com/123.html", "jd", "123"],
    ["淘宝", "https://item.taobao.com/item.htm?id=456", "taobao", "456"],
    ["天猫", "https://detail.tmall.com/item.htm?id=789", "tmall", "789"],
    ["Walmart", "https://www.walmart.com/ip/10223889834188", "walmart", "10223889834188"],
    ["沃尔玛", "https://www.walmart.com/ip/10223889834188?utm_source=x#reviews", "walmart", "10223889834188"],
  ])("full product URL %s → (%s, %s)", (platform, url, expectedPlatform, expectedId) => {
    const rules = [
      ...DEFAULT_TRADE_PLATFORM_RULES,
      {
        id: "walmart",
        label: "沃尔玛",
        domain: "www.walmart.com",
        url_template: "https://www.walmart.com/ip/{id}",
        sort_order: 3,
      },
    ];
    expect(parseMarketplaceProductFields({ trade_platform: platform, platform_product_url: url }, rules))
      .toEqual({ trade_platform: expectedPlatform, platform_product_id: expectedId });
  });

  it.each([
    "https://www.walmart.com/ip/10223889834188/",
    "https://www.walmart.com/ip/Some-Product-Slug/10223889834188",
    "https://www.walmart.com/ip/Some-Product-Slug/10223889834188?athbdg=L1100",
  ])("accepts real-world slug/trailing-slash product URL %s", (url) => {
    const rules = [
      ...DEFAULT_TRADE_PLATFORM_RULES,
      {
        id: "walmart",
        label: "沃尔玛",
        domain: "www.walmart.com",
        url_template: "https://www.walmart.com/ip/{id}",
        sort_order: 3,
      },
    ];
    expect(
      parseMarketplaceProductFields({ trade_platform: "沃尔玛", platform_product_url: url }, rules),
    ).toEqual({ trade_platform: "walmart", platform_product_id: "10223889834188" });
  });

  it("accepts extra query parameters on path-style platform links", () => {
    expect(
      parseMarketplaceProductFields({
        trade_platform: "jd",
        platform_product_url: "https://item.jd.com/123.html?spm=abc",
      }),
    ).toEqual({ trade_platform: "jd", platform_product_id: "123" });
  });

  it("requires platform whenever an ID or URL is provided", () => {
    expect(() => parseMarketplaceProductFields({ platform_product_url: "https://item.jd.com/123.html" })).toThrow(
      /交易平台/,
    );
    expect(() => parseMarketplaceProductFields({ platform_product_id: "123" })).toThrow(/交易平台/);
  });

  it("requires at least one of ID or URL when platform is provided", () => {
    expect(() => parseMarketplaceProductFields({ trade_platform: "jd" })).toThrow(/商品ID或商品链接/);
  });

  it("rejects mismatched ID and URL", () => {
    expect(() =>
      parseMarketplaceProductFields({
        trade_platform: "jd",
        platform_product_id: "123",
        platform_product_url: "https://item.jd.com/456.html",
      }),
    ).toThrow(/不一致/);
  });

  it.each([
    "http://item.jd.com/123.html",
    "https://evil.example.com/123.html",
    "https://item.jd.com/not-a-number.html",
    "https://item.jd.com/123.html/extra",
    "https://user:pass@item.jd.com/123.html",
    "https://item.jd.com:8443/123.html",
    "not-a-url",
  ])("rejects invalid product URL %s", (url) => {
    expect(() =>
      parseMarketplaceProductFields({ trade_platform: "jd", platform_product_url: url }),
    ).toThrow();
  });
});
