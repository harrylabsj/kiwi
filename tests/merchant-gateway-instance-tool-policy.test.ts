/**
 * 共享网关实例工具代理默认关闭：只有显式 KIWI_GATEWAY_INSTANCE_TOOLS=1 才启用。
 */
import { describe, expect, it } from "vitest";

import {
  GATEWAY_INSTANCE_TOOLS_ENV,
  gatewayInstanceToolsEnabled,
} from "../src/merchant-gateway/instance-tool-policy.js";

describe("gateway instance tool policy", () => {
  it("默认关闭，未设置/空值/其他值都不启用", () => {
    expect(gatewayInstanceToolsEnabled({})).toBe(false);
    expect(gatewayInstanceToolsEnabled({ [GATEWAY_INSTANCE_TOOLS_ENV]: "" })).toBe(false);
    expect(gatewayInstanceToolsEnabled({ [GATEWAY_INSTANCE_TOOLS_ENV]: "0" })).toBe(false);
    expect(gatewayInstanceToolsEnabled({ [GATEWAY_INSTANCE_TOOLS_ENV]: "true" })).toBe(false);
  });

  it("只有显式 1 才启用历史代理", () => {
    expect(gatewayInstanceToolsEnabled({ [GATEWAY_INSTANCE_TOOLS_ENV]: "1" })).toBe(true);
    expect(gatewayInstanceToolsEnabled({ [GATEWAY_INSTANCE_TOOLS_ENV]: " 1 " })).toBe(true);
  });
});
