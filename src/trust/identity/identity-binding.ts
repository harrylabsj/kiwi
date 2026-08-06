/**
 * 身份绑定（基线 §27 Identity Trust / §36-19 / UCP Identity Binding 思想）。
 *
 * 验签通过的身份 MUST 绑定到：
 *   - 协议幂等主键的 sender 侧（子规范 §20.1 (sender_identity, message_id)）；
 *   - Ledger identity snapshot（基线 §22 identity snapshot）。
 *
 * 冲突检测：请求宣称的 profile（identity / organization / role）与密钥绑定的
 * profile 不一致 → identity_rejected（§18 词表 / §32 error model）。fail-closed：
 * 任何宣称字段与已绑定档案冲突都拒绝，绝不静默采用宣称值。
 */

import type { LedgerIdentitySnapshot } from "../../negotiation/ledger/index.js";
import type { TrustLevel } from "./trust-policy.js";

/** 验签通过的身份主体。 */
export interface VerifiedPrincipal {
  /** 规范身份：优先密钥档案 profile.identity，否则 keyid。 */
  identity: string;
  keyid: string;
  trustLevel: TrustLevel;
  profile?: { identity?: string; organization?: string; role?: "buyer" | "merchant" };
}

/** 请求宣称的身份（来自请求头/卡片 JWS 等；untrusted）。 */
export interface ClaimedIdentity {
  identity?: string;
  organization?: string;
  role?: "buyer" | "merchant";
}

export type IdentityBindingResult =
  | { ok: true; senderIdentity: string; snapshot: LedgerIdentitySnapshot }
  | { ok: false; protocolCode: "identity_rejected"; reason: string };

/**
 * 把验证过的身份绑定到幂等主键与 Ledger 快照，并做宣称档案冲突检测。
 * claimed 缺省时不冲突（未宣称即不比较）；宣称字段必须与档案一致。
 */
export function bindIdentity(input: {
  verified: VerifiedPrincipal;
  claimed?: ClaimedIdentity;
}): IdentityBindingResult {
  const senderIdentity = input.verified.identity;
  const profile = input.verified.profile;
  const claimed = input.claimed;

  if (claimed !== undefined) {
    if (
      claimed.identity !== undefined &&
      profile?.identity !== undefined &&
      claimed.identity !== profile.identity
    ) {
      return {
        ok: false,
        protocolCode: "identity_rejected",
        reason: `claimed identity "${claimed.identity}" conflicts with key "${input.verified.keyid}" profile identity "${profile.identity}"`,
      };
    }
    if (
      claimed.organization !== undefined &&
      profile?.organization !== undefined &&
      claimed.organization !== profile.organization
    ) {
      return {
        ok: false,
        protocolCode: "identity_rejected",
        reason: `claimed organization "${claimed.organization}" conflicts with key "${input.verified.keyid}" profile`,
      };
    }
    if (
      claimed.role !== undefined &&
      profile?.role !== undefined &&
      claimed.role !== profile.role
    ) {
      return {
        ok: false,
        protocolCode: "identity_rejected",
        reason: `claimed role "${claimed.role}" conflicts with key "${input.verified.keyid}" profile role "${profile.role}"`,
      };
    }
  }

  return {
    ok: true,
    senderIdentity,
    snapshot: { sender_identity: senderIdentity, counterparty_identity: senderIdentity },
  };
}
