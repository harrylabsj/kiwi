import { describe, expect, it } from "vitest";
import {
  buildMarketplaceProductLink,
  parseMarketplaceProductFields,
} from "../src/handoff/marketplace-product-link.js";

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
});
