/**
 * A2A 陌生调用者准入策略：认证模式与匿名政策分离。
 * open 保持兼容；verified 拒绝基础匿名但允许签名/公开询价会话；
 * closed 连公开询价会话也拒绝；非法配置 fail-closed。
 */
import { describe, expect, it } from "vitest";

import {
  AdmissionPolicyVerifier,
  parseA2aAdmissionPolicy,
  type A2aAdmissionPolicy,
} from "../src/a2a/admission.js";
import { OPEN_INQUIRY_IDENTITY_PREFIX } from "../src/a2a/open-inquiry-identity.js";
import type { AuthResult, AuthVerifier } from "../src/a2a/server/types.js";

function verifierReturning(result: AuthResult): AuthVerifier {
  return {
    name: "fixture",
    verify: async () => result,
  };
}

const anonymous: AuthResult = {
  authenticated: true,
  identity: "anonymous",
  identityVerified: false,
  trustLevel: "T0",
};
const signed: AuthResult = {
  authenticated: true,
  identity: "buyer:known",
  identityVerified: true,
  trustLevel: "T2",
};
const openInquiry: AuthResult = {
  authenticated: true,
  identity: `${OPEN_INQUIRY_IDENTITY_PREFIX}abc`,
  identityVerified: true,
  trustLevel: "T0",
};

async function verdict(policy: A2aAdmissionPolicy, result: AuthResult): Promise<AuthResult> {
  return new AdmissionPolicyVerifier(verifierReturning(result), policy).verify({
    remoteAddress: "127.0.0.1",
    method: "POST",
    url: "/a2a",
    headers: {},
    authorizationHeader: "",
  });
}

describe("A2A admission policy", () => {
  it("open：匿名、签名、公开询价会话都放行（保持现有行为）", async () => {
    for (const result of [anonymous, signed, openInquiry]) {
      await expect(verdict("open", result)).resolves.toMatchObject({ authenticated: true });
    }
  });

  it("verified：拒绝基础匿名；签名身份与公开询价会话放行", async () => {
    await expect(verdict("verified", anonymous)).resolves.toMatchObject({
      authenticated: false,
      protocolCode: "authorization_failed",
    });
    await expect(verdict("verified", signed)).resolves.toMatchObject({ authenticated: true });
    await expect(verdict("verified", openInquiry)).resolves.toMatchObject({
      authenticated: true,
    });
  });

  it("closed：只允许已验证身份；匿名与公开询价会话都拒绝", async () => {
    await expect(verdict("closed", anonymous)).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(verdict("closed", openInquiry)).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(verdict("closed", signed)).resolves.toMatchObject({ authenticated: true });
  });

  it("认证失败原样返回；非法策略值 fail-closed", async () => {
    const failed: AuthResult = { authenticated: false, protocolCode: "replay_detected" };
    await expect(verdict("closed", failed)).resolves.toMatchObject({
      authenticated: false,
      protocolCode: "replay_detected",
    });
    expect(parseA2aAdmissionPolicy(undefined)).toBe("open");
    expect(parseA2aAdmissionPolicy("verified")).toBe("verified");
    expect(() => parseA2aAdmissionPolicy("nope")).toThrow(/A2A 准入策略非法/);
  });
});
