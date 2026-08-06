/**
 * Agent Card 模型测试（基线 §26 / 不变量 24）：
 *  - §26 完整示例作为正例；
 *  - 结构 fail-closed：缺字段 / 空 supportedInterfaces / 缺 protocolVersion /
 *    非 http(s) url / 扩展 required 非布尔 / skill 缺 id；
 *  - forward-compat：未知顶层字段与未知 protocolBinding 不拒绝；
 *  - Kiwi negotiation extension URI 识别（§8.2）；
 *  - secret 扫描拒绝：bearer / api key / password / 私钥 / 高熵 token /
 *    merchant cost-floor 数据 / principal 私有状态。
 */
import { describe, expect, it } from "vitest";
import {
  AgentCardError,
  findNegotiationExtensions,
  isNegotiationExtensionUri,
  parseAgentCard,
  scanAgentCardSecrets,
  validateAgentCard,
} from "../src/discovery/agent-card/index.js";

/** §26 完整示例（含 Kiwi negotiation extension 声明）。 */
function validCard(): Record<string, unknown> {
  return {
    name: "Example Merchant Agent",
    description: "Merchant commerce negotiation agent",
    provider: { organization: "Example Merchant" },
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: "https://merchant.example/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    securitySchemes: { bearer: { type: "bearerScheme" } },
    security: [{ scheme: "bearer", credential: "merchant-cred" }],
    capabilities: {
      extendedAgentCard: true,
      extensions: [{ uri: "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0", required: false }],
    },
    skills: [
      {
        id: "commerce-negotiation",
        name: "Commerce Negotiation",
        description: "Pre-transaction inquiry, RFQ, offer and negotiation",
      },
    ],
  };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof AgentCardError ? e.code : "non-agent-card-error";
  }
}

describe("Agent Card 合法输入（§26）", () => {
  it("accepts the §26 example card", () => {
    const card = validateAgentCard(validCard());
    expect(card.name).toBe("Example Merchant Agent");
    expect(card.supportedInterfaces).toHaveLength(1);
    expect(card.supportedInterfaces[0]).toMatchObject({
      url: "https://merchant.example/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    });
    expect(card.capabilities?.extensions?.[0]?.uri).toBe(
      "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0",
    );
  });

  it("keeps unknown top-level fields (extendedAgentCard forward-compat)", () => {
    const card = validCard();
    card.customVendorField = { anything: [1, 2, 3] };
    expect(validateAgentCard(card).name).toBe("Example Merchant Agent");
  });

  it("accepts a security requirement using the credentials (plural) spelling", () => {
    const card = validCard();
    (card.security as Record<string, unknown>[])[0] = {
      scheme: "bearer",
      credentials: "merchant-cred",
    };
    expect(validateAgentCard(card).security?.[0]?.credentials).toBe("merchant-cred");
  });

  it("accepts an unknown protocolBinding without rejecting it", () => {
    const card = validCard();
    (card.supportedInterfaces as Record<string, unknown>[]).push({
      url: "https://merchant.example/a2a-custom",
      protocolBinding: "https://vendor.example/bindings/custom/1.0",
      protocolVersion: "1.0",
    });
    const parsed = validateAgentCard(card);
    expect(parsed.supportedInterfaces).toHaveLength(2);
  });

  it("accepts loopback http interface URLs at card level (SSRF is client-side)", () => {
    const card = validCard();
    (card.supportedInterfaces as Record<string, unknown>[])[0] = {
      url: "http://127.0.0.1:8765/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    };
    expect(validateAgentCard(card).supportedInterfaces[0]?.url).toBe("http://127.0.0.1:8765/a2a");
  });
});

describe("Agent Card 畸形输入（fail-closed）", () => {
  it("rejects a missing name", () => {
    const card = validCard();
    delete card.name;
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects an empty description", () => {
    const card = validCard();
    card.description = "";
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects a missing provider.organization", () => {
    const card = validCard();
    (card.provider as Record<string, unknown>).organization = undefined;
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects an empty supportedInterfaces array", () => {
    const card = validCard();
    card.supportedInterfaces = [];
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects a supportedInterfaces entry missing protocolVersion", () => {
    const card = validCard();
    const iface = (card.supportedInterfaces as Record<string, unknown>[])[0];
    delete (iface as Record<string, unknown>).protocolVersion;
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects a non-http(s) interface url", () => {
    const card = validCard();
    (card.supportedInterfaces as Record<string, unknown>[])[0] = {
      url: "ftp://merchant.example/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    };
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects an interface url with embedded userinfo", () => {
    const card = validCard();
    (card.supportedInterfaces as Record<string, unknown>[])[0] = {
      url: "https://user:pass@merchant.example/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    };
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects an extension entry without a boolean required", () => {
    const card = validCard();
    (card.capabilities as Record<string, unknown>).extensions = [
      { uri: "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0", required: "yes" },
    ];
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });

  it("rejects a skill entry missing id", () => {
    const card = validCard();
    (card.skills as Record<string, unknown>[])[0] = { name: "No Id" };
    expect(errorCode(() => validateAgentCard(card))).toBe("schema_invalid");
  });
});

describe("Kiwi negotiation extension URI（§8.2）", () => {
  it("recognizes the canonical https form on any authority", () => {
    expect(isNegotiationExtensionUri("https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0")).toBe(
      true,
    );
    expect(
      isNegotiationExtensionUri("https://merchant.example/a2a/extensions/negotiation/1.0"),
    ).toBe(true);
  });

  it("rejects non-matching paths, schemes and userinfo", () => {
    expect(isNegotiationExtensionUri("http://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0")).toBe(
      true,
    );
    expect(isNegotiationExtensionUri("https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0/")).toBe(
      false,
    );
    expect(isNegotiationExtensionUri("https://kiwi.harrylabsj.com/a2a/extensions/other/1.0")).toBe(false);
    expect(isNegotiationExtensionUri("https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.1")).toBe(
      false,
    );
    expect(isNegotiationExtensionUri("ftp://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0")).toBe(
      false,
    );
    expect(
      isNegotiationExtensionUri("https://user:pass@kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0"),
    ).toBe(false);
    expect(isNegotiationExtensionUri("not a url")).toBe(false);
  });

  it("finds negotiation extensions across capabilities and top level", () => {
    const card = validateAgentCard(validCard());
    expect(findNegotiationExtensions(card)).toEqual([
      "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0",
    ]);
    const noExt = validateAgentCard(validCard());
    delete (noExt as { capabilities?: unknown }).capabilities;
    expect(findNegotiationExtensions(noExt)).toEqual([]);
  });
});

describe("Agent Card secret 扫描（不变量 24）", () => {
  it("passes a clean card (security references are not secrets)", () => {
    const result = scanAgentCardSecrets(validCard());
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("rejects a bearer-style token in prose", () => {
    const card = validCard();
    card.description = "Call us with Bearer sk-live-abcdefghijklmnop";
    expect(scanAgentCardSecrets(card).ok).toBe(false);
    expect(scanAgentCardSecrets(card).findings[0]?.kind).toBe("api_key");
  });

  it("rejects an api_key field with a static value", () => {
    const card = validCard();
    card.api_key = "1234567890abcdef";
    const result = scanAgentCardSecrets(card);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.kind).toBe("api_key");
  });

  it("rejects a password field", () => {
    const card = validCard();
    card.password = "hunter2";
    const result = scanAgentCardSecrets(card);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.kind).toBe("password");
  });

  it("rejects an embedded private key block", () => {
    const card = validCard();
    card.description =
      "key: -----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
    const result = scanAgentCardSecrets(card);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.kind).toBe("private_key");
  });

  it("rejects a high-entropy token-shaped value", () => {
    const card = validCard();
    card.customSecret = "aB3xY9zQ2wE5rT7uI0oP1lK9mN4bV6cX8";
    const result = scanAgentCardSecrets(card);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.kind).toBe("high_entropy_token");
  });

  it("rejects merchant cost/floor data anywhere in the card", () => {
    const card = validCard();
    card.cost = 100;
    const result = scanAgentCardSecrets(card);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.kind).toBe("merchant_private_data");
    expect(result.findings[0]?.path).toBe("/cost");
  });

  it("rejects nested floor_price inside an extension object", () => {
    const card = validCard();
    (card.capabilities as Record<string, unknown>).extensions = [
      { uri: "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0", required: false },
      { uri: "https://vendor.example/ext", required: true, floor_price: 99 },
    ];
    const result = scanAgentCardSecrets(card);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.kind === "merchant_private_data")).toBe(true);
  });

  it("rejects principal private state keys", () => {
    const card = validCard();
    card.private_memory = "do not disclose";
    const result = scanAgentCardSecrets(card);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.kind).toBe("principal_private_state");
  });

  it("does not flag env-style references as secrets", () => {
    const card = validCard();
    card.api_key = "env:SHOPPING_AGENT_TOKEN";
    card.password = "${DB_PASSWORD}";
    expect(scanAgentCardSecrets(card).ok).toBe(true);
  });

  it("parseAgentCard rejects a card carrying a secret", () => {
    const card = validCard();
    card.authorization = "Bearer abc123def456ghi789";
    expect(errorCode(() => parseAgentCard(card))).toBe("secret_found");
  });
});
