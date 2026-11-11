import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRADE_PLATFORM_RULES,
  buildTradePlatformUrl,
  normalizeTradePlatformRules,
  resolveTradePlatform,
  type TradePlatformRule,
} from "../src/handoff/trade-platform-rules.js";
import { buildMarketplaceProductLink } from "../src/handoff/marketplace-product-link.js";

const PINDUODUO: TradePlatformRule = {
  id: "pinduoduo",
  label: "拼多多",
  domain: "yangkeduo.com",
  url_template: "https://mobile.yangkeduo.com/goods.html?goods_id={id}",
  sort_order: 40,
};

describe("operator trade platform rules", () => {
  it("ships jd/taobao/tmall defaults", () => {
    expect(DEFAULT_TRADE_PLATFORM_RULES.map((rule) => rule.id)).toEqual([
      "jd",
      "taobao",
      "tmall",
    ]);
  });

  it("resolves ids, labels and legacy aliases", () => {
    const rules = [...DEFAULT_TRADE_PLATFORM_RULES, PINDUODUO];
    expect(resolveTradePlatform("jd", rules)?.id).toBe("jd");
    expect(resolveTradePlatform("京东", rules)?.id).toBe("jd");
    expect(resolveTradePlatform("jingdong", rules)?.id).toBe("jd");
    expect(resolveTradePlatform("拼多多", rules)?.id).toBe("pinduoduo");
    expect(resolveTradePlatform("unknown", rules)).toBeUndefined();
  });

  it("builds links only from the configured template and trusted domain", () => {
    expect(buildTradePlatformUrl(PINDUODUO, "123456")).toBe(
      "https://mobile.yangkeduo.com/goods.html?goods_id=123456",
    );
    expect(buildTradePlatformUrl(PINDUODUO, "0")).toBeUndefined();
    expect(buildTradePlatformUrl(PINDUODUO, "1e20")).toBeUndefined();

    const offDomain = { ...PINDUODUO, url_template: "https://evil.example/{id}" };
    expect(buildTradePlatformUrl(offDomain, "123")).toBeUndefined();
    const insecure = { ...PINDUODUO, url_template: "http://yangkeduo.com/{id}" };
    expect(buildTradePlatformUrl(insecure, "123")).toBeUndefined();
  });

  it("normalizes fetched rules and falls back to defaults", () => {
    expect(normalizeTradePlatformRules(undefined).map((rule) => rule.id)).toEqual([
      "jd",
      "taobao",
      "tmall",
    ]);
    const normalized = normalizeTradePlatformRules([
      { ...PINDUODUO, id: " pinduoduo " },
      { id: "", label: "ignored", domain: "x.example", url_template: "https://x.example/{id}" },
      { id: "broken", label: "no placeholder", domain: "x.example", url_template: "https://x.example/" },
    ]);
    expect(normalized.map((rule) => rule.id)).toEqual(["pinduoduo"]);
  });

  it("generates custom-platform links through the shared link builder", () => {
    const rules = [...DEFAULT_TRADE_PLATFORM_RULES, PINDUODUO];
    expect(buildMarketplaceProductLink("拼多多", "987654", rules)).toBe(
      "https://mobile.yangkeduo.com/goods.html?goods_id=987654",
    );
    expect(() => buildMarketplaceProductLink("未知平台", "987654", rules)).toThrow();
  });
});
