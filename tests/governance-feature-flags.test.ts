/**
 * TOP1-3 M1（D-M0-09）：功能开关严格解析。
 * 默认全关、customer_delivery 固定关闭、非法值/未知字段启动失败。
 */
import { describe, expect, it } from "vitest";

import {
  assertFeatureEnabled,
  GOVERNANCE_FLAGS_DEFAULT,
  GOVERNANCE_FLAG_ENV_NAMES,
  loadGovernanceFeatureFlagsFromEnv,
  parseGovernanceFeatureFlags,
} from "../src/merchant-core/context-governance/feature-flags.js";
import { ContextGovernanceError } from "../src/merchant-core/context-governance/types.js";

describe("功能开关（设计 §20.1 / 收尾决议 §1.2）", () => {
  it("缺省与空配置都是全关", () => {
    expect(parseGovernanceFeatureFlags(undefined)).toEqual(GOVERNANCE_FLAGS_DEFAULT);
    expect(parseGovernanceFeatureFlags({})).toEqual(GOVERNANCE_FLAGS_DEFAULT);
    expect(loadGovernanceFeatureFlagsFromEnv({})).toEqual(GOVERNANCE_FLAGS_DEFAULT);
  });

  it("显式开启 learning / memory / jobs；customer_delivery 固定 false", () => {
    const flags = parseGovernanceFeatureFlags({
      learning_enabled: true,
      memory_enabled: true,
      jobs_enabled: true,
    });
    expect(flags.learning_enabled).toBe(true);
    expect(flags.memory_enabled).toBe(true);
    expect(flags.jobs_enabled).toBe(true);
    expect(flags.customer_delivery_enabled).toBe(false);
  });

  it("试图启用 customer_delivery 直接失败（P0 固定关闭，无试开路径）", () => {
    expect(() => parseGovernanceFeatureFlags({ customer_delivery_enabled: true })).toThrowError(
      ContextGovernanceError,
    );
    expect(() =>
      loadGovernanceFeatureFlagsFromEnv({ KIWI_GOVERNANCE_CUSTOMER_DELIVERY_ENABLED: "true" }),
    ).toThrowError(ContextGovernanceError);
  });

  it("严格 schema：未知字段与非布尔值拒绝", () => {
    expect(() => parseGovernanceFeatureFlags({ delivery_enabled: true })).toThrowError(
      ContextGovernanceError,
    );
    expect(() => parseGovernanceFeatureFlags({ learning_enabled: "true" })).toThrowError(
      ContextGovernanceError,
    );
    expect(() => parseGovernanceFeatureFlags({ learning_enabled: 1 })).toThrowError(
      ContextGovernanceError,
    );
  });

  it("环境变量：只接受 true/false 字面量；非法值启动失败", () => {
    const on = loadGovernanceFeatureFlagsFromEnv({
      [GOVERNANCE_FLAG_ENV_NAMES.jobs_enabled]: "true",
      [GOVERNANCE_FLAG_ENV_NAMES.learning_enabled]: "false",
    });
    expect(on.jobs_enabled).toBe(true);
    expect(on.learning_enabled).toBe(false);
    expect(on.memory_enabled).toBe(false);

    expect(() =>
      loadGovernanceFeatureFlagsFromEnv({ [GOVERNANCE_FLAG_ENV_NAMES.jobs_enabled]: "yes" }),
    ).toThrowError(ContextGovernanceError);
    expect(() =>
      loadGovernanceFeatureFlagsFromEnv({ [GOVERNANCE_FLAG_ENV_NAMES.jobs_enabled]: "1" }),
    ).toThrowError(ContextGovernanceError);
  });

  it("assertFeatureEnabled：关闭时 unsupported_capability，启用时放行", () => {
    const off = parseGovernanceFeatureFlags(undefined);
    expect(() => assertFeatureEnabled(off, "memory_enabled")).toThrowError(ContextGovernanceError);
    const on = parseGovernanceFeatureFlags({ memory_enabled: true });
    expect(() => assertFeatureEnabled(on, "memory_enabled")).not.toThrow();
  });

  it("解析结果是冻结对象，运行期不可篡改", () => {
    const flags = parseGovernanceFeatureFlags({ learning_enabled: true });
    expect(() => {
      (flags as { learning_enabled: boolean }).learning_enabled = false;
    }).toThrow();
    expect(flags.learning_enabled).toBe(true);
  });
});
