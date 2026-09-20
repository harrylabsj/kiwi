/**
 * M3 云端契约（v0.1.2）的 JSON Schema 校验测试。
 *
 * 价值在于**两侧锁同一份字节**：`contracts/runtime-binding/0.1.2/claims.schema.json`
 * 是从交接包逐字节并入契约锁的权威副本；本测试既校验真实产出（`buildBindingClaims`
 * + 实际请求/响应形状）合规，也校验 schema 自身没被改坏（内联副本一致、反面样例被拒）。
 *
 * Python 侧对应用例在 `kiwi-catalog/tests/test_m3_contract_schemas.py`。
 */
import { describe, expect, it } from "vitest";

import {
  loadCloudContractSchema,
  validateCloudContract,
  validateRuntimeBindingClaims,
  validateRuntimeBindingDocument,
} from "../src/contracts/cloud-contracts.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";

const CLAIMS = buildBindingClaims({
  bindingId: "binding_demo",
  bindingVersion: 1,
  merchantId: "merchant_demo",
  agentId: "agent_demo",
  workloadRef: "workload_demo",
  runtimeOrigin: "https://merchant-demo.example",
  a2aEndpoint: "https://merchant-demo.example/a2a",
  cardUrl: "https://catalog.example/v1/agents/cagt_demo/agent-card.json",
  keyId: "key_demo",
  keyThumbprint: `sha256:${"0".repeat(64)}`,
  serviceEpoch: 1,
  issuedAt: "2026-09-20T07:00:00Z",
  ttlSeconds: 900,
  issuer: "catalog_demo",
});

const DOCUMENT = {
  claims: CLAIMS,
  claims_jws:
    "eyJ0eXAiOiJraXdpLXJ1bnRpbWUtYmluZGluZy1jbGFpbXMiLCJhbGciOiJFZERTQSIsImtpZCI6ImtpZDEifQ.e30.c2ln",
  issuer_kid: "kid1",
  issuer_thumbprint: `sha256:${"a".repeat(64)}`,
  governance: { publication_state: "ACTIVE" },
  card_revision: 4,
  card_etag: '"etag-1"',
};

const BINDING_REQUEST = {
  binding: {
    runtime_origin: "https://merchant-demo.example",
    a2a_endpoint: "https://merchant-demo.example/a2a",
    key_jwk: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
    key_id: "key_demo",
    generation: 1,
    service_epoch: 7,
  },
  admin_token: "admin-token-m3",
};

const PUBLICATION_REQUEST = {
  publication: {
    schema_version: "0.1.2",
    agent_id: "cagt_demo",
    binding_id: "binding_demo",
    generation: 1,
    expected_revision: 0,
    wire_profile: "a2a-1.0",
    card_digest: `sha256:${"b".repeat(64)}`,
    agent_card: {
      name: "Demo Merchant",
      version: "1.0.0",
      url: "https://merchant-demo.example",
      supportedInterfaces: [
        {
          url: "https://merchant-demo.example/a2a",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
    },
  },
};

describe("M3 云端契约 schema", () => {
  it("真实 claims（buildBindingClaims 产出）合规", () => {
    expect(validateRuntimeBindingClaims(CLAIMS)).toEqual([]);
  });

  it("claims 的 17 个字段全部必填，多一个未知字段即拒", () => {
    const { binding_id: _omitted, ...missing } = CLAIMS;
    expect(validateRuntimeBindingClaims(missing).join(" ")).toContain("binding_id");
    expect(validateRuntimeBindingClaims({ ...CLAIMS, extra_field: 1 }).length).toBeGreaterThan(0);
  });

  it("claims 的格式约束是真的在生效（thumbprint / 时间窗 / scope）", () => {
    expect(
      validateRuntimeBindingClaims({ ...CLAIMS, key_thumbprint: "sha256:short" }).join(" "),
    ).toContain("key_thumbprint");
    expect(validateRuntimeBindingClaims({ ...CLAIMS, scope: "other" }).length).toBeGreaterThan(0);
    expect(validateRuntimeBindingClaims({ ...CLAIMS, card_url: "/v1/agents/x" }).length).toBeGreaterThan(0);
  });

  it("读响应信封合规；缺 claims_jws 或治理状态即拒", () => {
    expect(validateRuntimeBindingDocument(DOCUMENT)).toEqual([]);
    const { claims_jws: _jws, ...noJws } = DOCUMENT;
    expect(validateRuntimeBindingDocument(noJws).join(" ")).toContain("claims_jws");
    expect(
      validateRuntimeBindingDocument({ ...DOCUMENT, governance: {} }).length,
    ).toBeGreaterThan(0);
  });

  it("创建/轮换请求与名片发布请求的形状合规", () => {
    expect(validateCloudContract("runtime-binding-request", BINDING_REQUEST)).toEqual([]);
    expect(validateCloudContract("card-publication-request", PUBLICATION_REQUEST)).toEqual([]);
  });

  it("请求里的私网 / 非 https 目标在 schema 层就被挡（T035 的第一道）", () => {
    for (const endpoint of ["http://merchant.example/a2a", "not-a-url"]) {
      const bad = {
        ...BINDING_REQUEST,
        binding: { ...BINDING_REQUEST.binding, a2a_endpoint: endpoint },
      };
      expect(validateCloudContract("runtime-binding-request", bad).length).toBeGreaterThan(0);
    }
  });

  it("发布请求的 wire_profile 与 card_digest 是钉死的（不接受近似形状）", () => {
    const badProfile = {
      publication: { ...PUBLICATION_REQUEST.publication, wire_profile: "a2a-1.1" },
    };
    expect(validateCloudContract("card-publication-request", badProfile).length).toBeGreaterThan(0);
    const badDigest = {
      publication: { ...PUBLICATION_REQUEST.publication, card_digest: "md5:abc" },
    };
    expect(validateCloudContract("card-publication-request", badDigest).length).toBeGreaterThan(0);
  });

  it("document schema 里内联的 claims 与独立 claims schema 逐字段一致（不静默分叉）", () => {
    const document = loadCloudContractSchema("runtime-binding-document");
    const inlined = (document["properties"] as Record<string, unknown>)["claims"];
    const standalone = loadCloudContractSchema("runtime-binding-claims");
    const strip = (schema: Record<string, unknown>): Record<string, unknown> => {
      const copy = { ...schema };
      delete copy["$id"];
      delete copy["$schema"];
      return copy;
    };
    expect(inlined).toEqual(strip(standalone));
  });
});
