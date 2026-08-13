/**
 * K-L22 回归：出站 public_message 脱敏私有底价。
 *
 * 商家模型磋商需要底价可见（已知设计权衡），但 prompt-inject 可能把底价写进
 * 公开消息——出站前把完整数字 token 替换为占位符，避免误伤子串。
 */
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/config/profile.js";
import { redactPrivateFloor } from "../src/agent/negotiation-chat.js";

function merchantProfile(floor: number | undefined): AgentProfile {
  return {
    role: "merchant",
    agent_id: "merchant:test",
    owner_id: "merchant:test",
    protocol_version: "shopping.negotiation/0.1",
    runtime_version: "0.6.0",
    commerce: { base_url: "http://127.0.0.1:8765", token_env: "SHOPPING_MERCHANT_TOKEN" },
    model: { provider: "fake", model: "fake", api_key_env: "DEEPSEEK_API_KEY" },
    merchant_policy: {
      ...(floor !== undefined ? { min_unit_price_private: floor } : {}),
      auto_negotiate: false,
      human_review_on: [],
    },
  } as unknown as AgentProfile;
}

describe("redactPrivateFloor（K-L22 出站脱敏）", () => {
  it("独立数字 token 被替换为占位符", () => {
    const profile = merchantProfile(8900);
    expect(redactPrivateFloor("底价是 8900 元", profile)).toBe("底价是 [私密阈值] 元");
    expect(redactPrivateFloor("最低 8900，别再低了", profile)).toBe("最低 [私密阈值]，别再低了");
  });

  it("不含底价的文本不变", () => {
    const profile = merchantProfile(8900);
    expect(redactPrivateFloor("我们接受 9000，包邮", profile)).toBe("我们接受 9000，包邮");
  });

  it("子串不误伤（floor 89 不替换 8900 里的 89）", () => {
    const profile = merchantProfile(89);
    expect(redactPrivateFloor("价格 8900", profile)).toBe("价格 8900");
  });

  it("未配置底价时原样返回", () => {
    expect(redactPrivateFloor("底价是 8900 元", merchantProfile(undefined))).toBe(
      "底价是 8900 元",
    );
  });
});
