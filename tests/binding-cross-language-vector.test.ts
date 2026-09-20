/**
 * 跨语言锁（SIG-03 要求）：kiwi(TS) 与 kiwi-catalog(Python) 对同一 JWK 必须得到
 * 同一 `key_thumbprint`，并对同一 payload/签名身份产出**逐字节相同**的 compact JWS。
 *
 * 向量文件：`contracts/vectors/binding-thumbprint.json`（由 Python 侧生成，两侧共同校验）。
 * Ed25519 签名是确定性的——因此"字节相同"这条断言同时锁住了
 * header 形状、base64url 编码与签名算法。
 *
 * Python 侧的对应用例在 `kiwi-catalog/tests/test_binding_vectors.py`。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { jwkThumbprint } from "../src/trust/binding/thumbprint.js";
import { signCompactJws, verifyCompactJws } from "../src/trust/identity/jws.js";
import { privateKeyObject } from "../src/trust/identity/keys.js";
import type { JsonWebKey } from "../src/trust/identity/jwk.js";

const VECTOR_PATH = path.resolve(__dirname, "..", "contracts", "vectors", "binding-thumbprint.json");

interface BindingVector {
  kid: string;
  public_jwk: JsonWebKey;
  private_key_pem: string;
  payload_string: string;
  expected_thumbprint: string;
  expected_jws: string;
  canonical_jwk_json: string;
}

const vector = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as BindingVector;

describe("跨语言绑定向量（TS ↔ Python）", () => {
  it("同一公钥 JWK → 同一 key_thumbprint", () => {
    expect(jwkThumbprint(vector.public_jwk)).toBe(vector.expected_thumbprint);
  });

  it("用向量里的私钥重签同一 payload → **逐字节相同**的 compact JWS", () => {
    const identity = {
      keyid: vector.kid,
      algorithm: "ed25519" as const,
      privateKey: privateKeyObject(vector.private_key_pem),
    };
    const jws = signCompactJws(vector.payload_string, identity, {
      extraHeader: { typ: "kiwi-runtime-binding-claims" },
    });
    expect(jws).toBe(vector.expected_jws);
  });

  it("用向量公钥可验 Python 侧产出的 JWS（篡改即失败）", () => {
    const publicKey = createPublicKey(vector.private_key_pem);
    const verified = verifyCompactJws(vector.expected_jws, publicKey);
    expect(verified.payload.toString("utf8")).toBe(vector.payload_string);
    const [header, , signature] = vector.expected_jws.split(".");
    const tampered = `${header}.${Buffer.from('{"tampered":true}', "utf8").toString("base64url")}.${signature}`;
    expect(() => verifyCompactJws(tampered, publicKey)).toThrow();
  });
});
