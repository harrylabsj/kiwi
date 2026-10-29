/**
 * D：成交入口一致性。显式 handoff_destination 与「平台+商品ID」冲突时，
 * 以结构化字段为准并告警——买家的 handoff 链接绝不能指向另一件商品。
 */
import { describe, expect, it } from "vitest";

import { resolveHandoffDestination } from "../src/a2a/node.js";

describe("resolveHandoffDestination", () => {
  it("显式链接与平台字段一致时保留显式链接", () => {
    expect(
      resolveHandoffDestination({
        handoff_destination: "https://item.jd.com/100253036806.html",
        trade_platform: "jd",
        platform_product_id: "100253036806",
      }),
    ).toBe("https://item.jd.com/100253036806.html");
  });

  it("冲突时按结构化字段生成链接（不把买家导向另一件商品）", () => {
    expect(
      resolveHandoffDestination({
        handoff_destination: "https://item.jd.com/100012043978.html",
        trade_platform: "jd",
        platform_product_id: "100253036806",
      }),
    ).toBe("https://item.jd.com/100253036806.html");
  });

  it("平台都不同（京东链接 + 淘宝字段）时同样以结构化字段为准", () => {
    expect(
      resolveHandoffDestination({
        handoff_destination: "https://item.jd.com/100012043978.html",
        trade_platform: "taobao",
        platform_product_id: "100253036806",
      }),
    ).toBe("https://item.taobao.com/item.htm?id=100253036806");
  });

  it("没有平台字段时保留显式链接（旧行为）", () => {
    expect(
      resolveHandoffDestination({
        handoff_destination: "https://merchant.example/checkout/vq-101",
      }),
    ).toBe("https://merchant.example/checkout/vq-101");
  });

  it("无法识别的链接不做猜测性拒绝，保留原值", () => {
    expect(
      resolveHandoffDestination({
        handoff_destination: "chat-session-42",
        trade_platform: "jd",
        platform_product_id: "100253036806",
      }),
    ).toBe("chat-session-42");
    expect(
      resolveHandoffDestination({
        handoff_destination: "https://merchant.example/checkout/vq-101",
        trade_platform: "jd",
        platform_product_id: "100253036806",
      }),
    ).toBe("https://merchant.example/checkout/vq-101");
  });

  it("两者都没有时不提供成交入口", () => {
    expect(resolveHandoffDestination({})).toBeUndefined();
  });
});
