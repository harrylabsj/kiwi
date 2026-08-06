/**
 * HTTP Message Signatures（RFC 9421）—— 出站签名器 + 入站验签核心。
 *
 * 覆盖组件默认集：@method @target-uri @authority content-digest。
 *   - @method / @target-uri / @authority 是派生组件（请求语义）；
 *   - content-digest（RFC 9530）把请求体绑定进签名 —— 篡改任一 covered
 *     component 都会导致验签失败，这是 §31「digest ≠ authentication」的落点：
 *     envelope digest 只证完整性，HTTP Message Signature 证明「由持有该 key 的
 *     身份发出」。
 *
 * 支持算法：Ed25519（RFC 9421 alg="ed25519"）与 ES256（P-256 + SHA-256，
 * alg="ecdsa-p256-sha256"，原始 r||s 编码 = node:dns ieee-p1363）。零新增依赖。
 */

import {
  createHash,
  sign as nodeSign,
  verify as nodeVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import type { A2AOutboundRequest } from "../../a2a/client/types.js";
import {
  buildSignatureBase,
  formatSignatureInput,
  headerValue,
  parseSignatureHeader,
  parseSignatureInput,
  type ParsedSignatureInput,
  type SignatureParams,
} from "./signature-base.js";
import {
  ed25519PrivateKeyFromSeed,
  privateKeyObject,
  publicKeyObject,
  type KeyProfile,
  type KeyResolver,
  type SignatureAlgorithm,
} from "./keys.js";
import type { NonceStore } from "./nonce.js";

/** RFC 9421 alg 名（Signature-Input 的 alg 参数）。 */
export const RFC9421_ALG_NAMES: Record<SignatureAlgorithm, string> = {
  ed25519: "ed25519",
  es256: "ecdsa-p256-sha256",
};

/** 默认覆盖组件：把方法、目标、authority、请求体全部绑定进签名。 */
export const DEFAULT_COVERED_COMPONENTS: readonly string[] = [
  "@method",
  "@target-uri",
  "@authority",
  "content-digest",
];

// ---------------------------------------------------------------------------
// content-digest（RFC 9530）
// ---------------------------------------------------------------------------

/** 计算请求体的 content-digest 头值：`sha-256=:<base64>:`。 */
export function contentDigestHeader(body: Buffer): string {
  const digest = createHash("sha256").update(body).digest();
  return `sha-256=:${digest.toString("base64")}:`;
}

/** 从 content-digest 头提取 sha-256 的 base64 摘要值。 */
function sha256DigestFromHeader(header: string): string | undefined {
  for (const part of header.split(/\s+/)) {
    const m = /^sha-256=:([^:]*):$/.exec(part);
    if (m !== null) return m[1];
  }
  return undefined;
}

/** 重算请求体 digest 并与头声明比较（内容完整性，§31）。 */
export function verifyContentDigest(body: Buffer, header: string): boolean {
  const presented = sha256DigestFromHeader(header);
  if (presented === undefined) return false;
  const expected = contentDigestHeader(body);
  const m = /^sha-256=:([^:]*):$/.exec(expected);
  if (m === null) return false;
  return presented === m[1];
}

// ---------------------------------------------------------------------------
// 签名/验签字节操作
// ---------------------------------------------------------------------------

function signBytes(algorithm: SignatureAlgorithm, data: Buffer, key: KeyObject): Buffer {
  switch (algorithm) {
    case "ed25519":
      return nodeSign(null, data, key);
    case "es256":
      return nodeSign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
  }
}

function verifyBytes(
  algorithm: SignatureAlgorithm,
  data: Buffer,
  key: KeyObject,
  signature: Buffer,
): boolean {
  switch (algorithm) {
    case "ed25519":
      return nodeVerify(null, data, key, signature);
    case "es256":
      return nodeVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  }
}

// ---------------------------------------------------------------------------
// 出站签名器（实现 a2a/client 的 A2AOutboundSigner 形状）
// ---------------------------------------------------------------------------

export interface HttpMessageSignerOptions {
  keyid: string;
  algorithm: SignatureAlgorithm;
  /** 私钥：PEM PKCS8，或 JWK，或（Ed25519 专用）32 字节 raw seed。 */
  privateKey: string | JsonWebKey | Buffer;
  /** 覆盖组件；默认 DEFAULT_COVERED_COMPONENTS。 */
  coveredComponents?: readonly string[];
  /** created 覆盖（unix 秒）；默认 now()。 */
  created?: number;
  /** expires（unix 秒，可选）。 */
  expires?: number;
  /** nonce 值（可选；T3 强制由策略决定，签名器侧可自行注入）。 */
  nonce?: string;
  /** 时钟（unix 秒）；默认 Date.now()/1000。 */
  now?: () => number;
}

/** 出站 HTTP Message Signature 签名器。 */
export class HttpMessageSigner {
  readonly keyid: string;
  readonly algorithm: SignatureAlgorithm;
  private readonly privateKey: KeyObject;
  private readonly coveredComponents: readonly string[];
  private readonly created: number | undefined;
  private readonly expires: number | undefined;
  private readonly nonce: string | undefined;
  private readonly now: () => number;

  constructor(options: HttpMessageSignerOptions) {
    this.keyid = options.keyid;
    this.algorithm = options.algorithm;
    this.coveredComponents = options.coveredComponents ?? DEFAULT_COVERED_COMPONENTS;
    this.created = options.created;
    this.expires = options.expires;
    this.nonce = options.nonce;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.privateKey = importPrivateKey(options.algorithm, options.privateKey);
  }

  /** 为一次出站请求计算签名头（content-digest / signature-input / signature）。 */
  sign(input: A2AOutboundRequest): Record<string, string> {
    const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, "utf8");
    const contentDigest = contentDigestHeader(body);
    const headers: Record<string, string> = { ...input.headers, "content-digest": contentDigest };

    const created = this.created ?? this.now();
    const params: SignatureParams = {
      created,
      keyid: this.keyid,
      algorithm: RFC9421_ALG_NAMES[this.algorithm],
    };
    if (this.expires !== undefined) params.expires = this.expires;
    if (this.nonce !== undefined) params.nonce = this.nonce;

    const components = [...this.coveredComponents];
    const targetUri = new URL(input.url).href;
    const authority = new URL(input.url).host;
    const base = buildSignatureBase({
      method: input.method,
      targetUri,
      authority,
      headers,
      components,
      params,
    });

    const signature = signBytes(this.algorithm, Buffer.from(base, "utf8"), this.privateKey);
    return {
      "content-digest": contentDigest,
      "signature-input": formatSignatureInput("sig1", components, params),
      "signature": `sig1=:${signature.toString("base64")}:`,
    };
  }
}

function importPrivateKey(algorithm: SignatureAlgorithm, input: string | JsonWebKey | Buffer): KeyObject {
  if (Buffer.isBuffer(input)) {
    if (algorithm !== "ed25519") {
      throw new Error("raw private key bytes are only supported for ed25519 (provide JWK/PEM for es256)");
    }
    return ed25519PrivateKeyFromSeed(input);
  }
  return privateKeyObject(input);
}

// ---------------------------------------------------------------------------
// 入站验签核心
// ---------------------------------------------------------------------------

export interface VerifyHttpSignatureInput {
  method: string;
  /** 绝对 target URI（或 origin-form 请求目标）。 */
  targetUri: string;
  /** @authority 值（Host 头）。 */
  authority: string;
  /** 请求头（小写名）。 */
  headers: Record<string, string | string[] | undefined>;
  /** 请求体字节（用于 content-digest 重算）。 */
  body: Buffer;
  resolver: KeyResolver;
  nonceStore?: NonceStore;
  /** 时钟（unix 秒）；默认 Date.now()/1000。 */
  now?: () => number;
  maxClockSkewSeconds?: number;
  maxSignatureAgeSeconds?: number;
}

export type HttpSignatureVerifyResult =
  | {
      ok: true;
      keyid: string;
      algorithm: SignatureAlgorithm;
      params: SignatureParams;
      profile?: KeyProfile;
    }
  | { ok: false; code: "authentication_required" | "authorization_failed" | "replay_detected"; reason: string };

/**
 * 验签：解析 Signature-Input / Signature，逐项验证（keyid → 公钥、时间窗口、
 * nonce、signature base、content-digest 完整性）。任一 signature 验证通过即成功；
 * 全部失败返回第一个错误（fail-closed，§4.6）。
 */
export function verifyHttpMessageSignature(input: VerifyHttpSignatureInput): HttpSignatureVerifyResult {
  const now = (input.now ?? (() => Math.floor(Date.now() / 1000)))();
  const skew = input.maxClockSkewSeconds ?? 300;
  const maxAge = input.maxSignatureAgeSeconds ?? 900;

  const signatureInputHeader = headerValue(input.headers, "signature-input");
  if (signatureInputHeader === undefined) {
    return { ok: false, code: "authentication_required", reason: "missing signature-input header" };
  }
  const signatureHeader = headerValue(input.headers, "signature");
  if (signatureHeader === undefined) {
    return { ok: false, code: "authentication_required", reason: "missing signature header" };
  }

  let entries: ParsedSignatureInput[];
  try {
    entries = parseSignatureInput(signatureInputHeader);
  } catch (err) {
    return {
      ok: false,
      code: "authorization_failed",
      reason: `malformed signature-input: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (entries.length === 0) {
    return { ok: false, code: "authorization_failed", reason: "signature-input has no signatures" };
  }
  const signatureLabels = parseSignatureHeader(signatureHeader);

  let firstFailure: HttpSignatureVerifyResult | undefined;
  for (const entry of entries) {
    const signatureBytes = signatureLabels[entry.label];
    if (signatureBytes === undefined) continue;
    const result = verifyEntry(entry, signatureBytes, input, now, skew, maxAge);
    if (result.ok) return result;
    if (firstFailure === undefined) firstFailure = result;
  }
  return (
    firstFailure ?? {
      ok: false,
      code: "authorization_failed",
      reason: "signature header has no matching signature label",
    }
  );
}

function verifyEntry(
  entry: ParsedSignatureInput,
  signatureBytes: Buffer,
  input: VerifyHttpSignatureInput,
  now: number,
  skew: number,
  maxAge: number,
): HttpSignatureVerifyResult {
  const keyid = entry.params.keyid;
  if (keyid === undefined) {
    return { ok: false, code: "authorization_failed", reason: "signature has no keyid" };
  }
  const key = input.resolver(keyid);
  if (key === undefined) {
    return { ok: false, code: "authorization_failed", reason: `unknown keyid "${keyid}"` };
  }

  const requested = algorithmFromAlgParam(entry.params.algorithm);
  if (entry.params.algorithm !== undefined && requested === undefined) {
    return {
      ok: false,
      code: "authorization_failed",
      reason: `unsupported signature algorithm "${entry.params.algorithm}"`,
    };
  }
  if (requested !== undefined && requested !== key.algorithm) {
    return {
      ok: false,
      code: "authorization_failed",
      reason: `signature alg "${entry.params.algorithm}" does not match key ${keyid} algorithm`,
    };
  }
  const algorithm = requested ?? key.algorithm;

  // created/expires 窗口（RFC 9421 §3.1 / 防重放第一道防线）。
  if (entry.params.created !== undefined) {
    if (entry.params.created > now + skew) {
      return { ok: false, code: "authorization_failed", reason: "signature created in the future" };
    }
    if (entry.params.expires === undefined && now - entry.params.created > maxAge) {
      return { ok: false, code: "authorization_failed", reason: "signature is too old" };
    }
  }
  if (entry.params.expires !== undefined && entry.params.expires < now - skew) {
    return { ok: false, code: "authorization_failed", reason: "signature has expired" };
  }

  // nonce 防重放第二道防线。
  if (entry.params.nonce !== undefined && input.nonceStore !== undefined) {
    if (!input.nonceStore.checkAndSet(`${keyid}|${entry.params.nonce}`)) {
      return { ok: false, code: "replay_detected", reason: "signature nonce already used" };
    }
  }

  let base: string;
  try {
    base = buildSignatureBase({
      method: input.method,
      targetUri: input.targetUri,
      authority: input.authority,
      headers: input.headers,
      components: entry.components,
      params: entry.params,
    });
  } catch (err) {
    return {
      ok: false,
      code: "authorization_failed",
      reason: `covered component unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // content-digest 完整性：body 重算必须与头声明一致（篡改 body → 拒绝）。
  if (entry.components.includes("content-digest")) {
    const contentDigestHeaderValue = headerValue(input.headers, "content-digest");
    if (contentDigestHeaderValue === undefined) {
      return { ok: false, code: "authorization_failed", reason: "content-digest is covered but header is missing" };
    }
    if (!verifyContentDigest(input.body, contentDigestHeaderValue)) {
      return { ok: false, code: "authorization_failed", reason: "content-digest does not match request body" };
    }
  }

  const keyObject = publicKeyObject(key);
  if (!verifyBytes(algorithm, Buffer.from(base, "utf8"), keyObject, signatureBytes)) {
    return { ok: false, code: "authorization_failed", reason: "signature verification failed" };
  }

  return { ok: true, keyid, algorithm, params: entry.params, profile: key.profile };
}

/** 把 Signature-Input 的 alg 参数映射到内部算法名。 */
function algorithmFromAlgParam(alg: string | undefined): SignatureAlgorithm | undefined {
  switch (alg) {
    case undefined:
      return undefined;
    case "ed25519":
      return "ed25519";
    case "ecdsa-p256-sha256":
    case "es256":
      return "es256";
    default:
      return undefined;
  }
}
