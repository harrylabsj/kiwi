/**
 * Merchant UCP Profile 测试（战略 v2.5 §7.1 Protocol Publishing / §7.8 UCP-ready）。
 *
 * 验证 UCP Profile 生成满足 §8.3 命名不变量（reverse-domain 反转即 authority，
 * spec/schema origin 与 authority 一致）+ KNP capability 声明。
 */
import { describe, expect, it } from "vitest";
import { buildMerchantUcpProfile, reverseDomain, UCP_VERSION } from "../src/merchant/ucp-profile.js";

describe("Merchant UCP Profile（§7.1 / §8.3）", () => {
  it("生成合法 profile：catalog service + KNP capability", () => {
    const profile = buildMerchantUcpProfile({
      domain: "xihu-digital.example.com",
      merchantId: "merchant-hz-xihu",
      catalogEndpoint: "http://127.0.0.1:8765/search/products",
    });
    expect(profile.ucp.version).toBe(UCP_VERSION);
    const catalog = profile.ucp.services?.["com.example.xihu-digital.catalog"];
    expect(catalog).toHaveLength(1);
    expect(catalog?.[0]?.endpoint).toBe("http://127.0.0.1:8765/search/products");
    const knp = profile.ucp.capabilities?.["com.harrylabsj.kiwi.shopping.negotiation"];
    expect(knp).toHaveLength(1);
    expect(knp?.[0]?.version).toBe("1.0");
    expect(profile.merchant_id).toBe("merchant-hz-xihu");
  });

  it("§8.3 命名不变量：spec/schema origin 与 authority host 一致", () => {
    const profile = buildMerchantUcpProfile({
      domain: "sz-nanshan-office.example.com",
      merchantId: "merchant-sz-nanshan",
      catalogEndpoint: "http://127.0.0.1:8765/search/products",
    });
    const service = profile.ucp.services?.[`${reverseDomain("sz-nanshan-office.example.com")}.catalog`]?.[0];
    expect(service).toBeDefined();
    const origin = (spec: string): string => new URL(spec).origin;
    expect(origin(service?.spec ?? "")).toBe("https://sz-nanshan-office.example.com");
    expect(origin(service?.schema ?? "")).toBe("https://sz-nanshan-office.example.com");
    // KNP capability 属 Kiwi 命名空间：authority = kiwi.harrylabsj.com
    const knp = profile.ucp.capabilities?.["com.harrylabsj.kiwi.shopping.negotiation"]?.[0];
    expect(origin(knp?.schema ?? "")).toBe("https://kiwi.harrylabsj.com");
  });

  it("reverseDomain 反转 host label", () => {
    expect(reverseDomain("xihu-digital.example.com")).toBe("com.example.xihu-digital");
    expect(reverseDomain("kiwi.harrylabsj.com")).toBe("com.harrylabsj.kiwi");
  });
});
