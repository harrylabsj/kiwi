/**
 * trust/identity — WP5 身份层（HTTP Message Signatures + Agent Card JWS +
 * TrustPolicy + 身份绑定）。
 *
 * 入口：HttpMessageSignatureVerifier 接入 a2a/server 的 AuthVerifier 接缝；
 * HttpMessageSigner 接入 a2a/client 的出站签名挂点。
 */

export {
  HttpMessageSignatureVerifier,
  parseClaimedIdentityHeader,
  CARD_JWS_HEADER,
  CLAIMED_IDENTITY_HEADER,
} from "./auth-verifier.js";
export type {
  CardJwsVerificationResult,
  HttpMessageSignatureVerifierOptions,
} from "./auth-verifier.js";

export { bindIdentity } from "./identity-binding.js";
export type { ClaimedIdentity, IdentityBindingResult, VerifiedPrincipal } from "./identity-binding.js";

export { JwsError, jwsKid, verifyAgentCardJws, verifyCompactJws } from "./jws.js";
export type { AgentCardJwsResult, JwsErrorCode, VerifiedJws } from "./jws.js";

export {
  ed25519PrivateKeyFromSeed,
  privateKeyObject,
  publicKeyJwkFromRaw,
  publicKeyObject,
  resolveFromJwks,
  resolveFromSigningKeys,
} from "./keys.js";
export type { KeyProfile, KeyResolver, SignatureAlgorithm, SigningKey } from "./keys.js";

export {
  contentDigestHeader,
  DEFAULT_COVERED_COMPONENTS,
  HttpMessageSigner,
  RFC9421_ALG_NAMES,
  verifyContentDigest,
  verifyHttpMessageSignature,
} from "./message-signature.js";
export type {
  HttpMessageSignerOptions,
  HttpSignatureVerifyResult,
  VerifyHttpSignatureInput,
} from "./message-signature.js";

export { InMemoryNonceStore } from "./nonce.js";
export type { NonceStore } from "./nonce.js";

export {
  buildSignatureBase,
  formatSignatureInput,
  headerValue,
  parseSignatureHeader,
  parseSignatureInput,
  serializeParams,
} from "./signature-base.js";
export type {
  CoveredComponent,
  ParsedSignatureInput,
  SignatureBaseError,
  SignatureBaseInput,
  SignatureParams,
} from "./signature-base.js";

export {
  DEFAULT_TRUST_POLICY,
  evaluatePolicy,
  isTrustLevel,
  TRUST_LEVELS,
  trustLevelRank,
} from "./trust-policy.js";
export type { PolicyEvaluationInput, PolicyEvaluationResult, TrustLevel, TrustPolicy } from "./trust-policy.js";
