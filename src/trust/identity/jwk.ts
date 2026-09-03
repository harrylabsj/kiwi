/**
 * JWK（RFC 7517）结构类型。
 *
 * @types/node ≥26 不再从 `node:crypto` 顶层导出 `JsonWebKey`，改为
 * `crypto.webcrypto` 命名空间下的 `webcrypto.JsonWebKey`。此处集中 re-export，
 * 并补 RFC 7517 的 `kid`（W3C JsonWebKey 未含，JWKS 接缝按 kid 匹配需要它）。
 */
import type { webcrypto } from "node:crypto";

export type JsonWebKey = webcrypto.JsonWebKey & { kid?: string };
