/**
 * 跨仓库 UCP round-trip 验收演练（审查 P1-03 回归）。
 *
 * 真实链路四段（不做 mock 替代）：
 *   1. Kiwi 发布：真实 A2AServer（ucp: true）监听 127.0.0.1 回环端口，
 *      经 HTTP GET /.well-known/ucp 取回发布产物（含 Cache-Control 头）；
 *   2. Kiwi 自校验：同一份文档过 validateUcpProfile——不得抛
 *      profile_malformed，且无任何被拒条目；
 *   3. kiwi-catalog 消费：同一份文档经子进程交给 catalog 的真实
 *      UcpProfileParser（canonical 适配器）+ TrustEvaluator._knp_claims +
 *      evaluate_commerce_capabilities。要求：解析通过、
 *      com.harrylabsj.kiwi.shopping.negotiation 被识别且 version/spec/schema
 *      非空、KNP claim 带齐 version + spec + schema、commerce capability
 *      交集评估通过。catalog 侧代码只读调用（.venv/bin/python 跑 /tmp 下的
 *      一次性脚本），不改 kiwi-catalog 任何文件；.venv 缺失时显式 skip；
 *   4. Kiwi 消费者：同一份文档（validate 后的 canonical profile）经
 *      computeCapabilityIntersection 与声明同 capability 的 consumer 求交，
 *      交集必须非空。
 *
 * 若第 3 段失败，说明两侧 canonical 模型仍存在真实契约分歧——按任务约束
 * 不在本测试里打补丁，失败信息直接带出 catalog 侧的精确错误。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { A2AServer, WELL_KNOWN_UCP_PATH } from "../src/a2a/server/index.js";
import { validateUcpProfile } from "../src/discovery/ucp/validate.js";
import { computeCapabilityIntersection } from "../src/discovery/ucp/intersect.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import type { UcpProfile } from "../src/discovery/ucp/types.js";

const KNP_CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
const KNP_SERVICE = "com.harrylabsj.kiwi.shopping";

const KIWI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PYTHON = path.resolve(KIWI_ROOT, "../kiwi-catalog/.venv/bin/python");

/** catalog 侧一次性脚本（写到 OS tempdir，不进任何仓库）。只读调用 catalog 真实代码。 */
const CATALOG_PROBE = `
import json, sys, traceback

def main():
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        profile = json.load(fh)
    out = {"parse_ok": False, "error": None, "capabilities": [], "services": [],
           "knp_claims": [], "commerce_evidence": None}
    try:
        from kiwi_catalog.discovery.trust import TrustPolicy
        from kiwi_catalog.discovery.ucp import UcpProfileParser
        from kiwi_catalog.discovery.agent_card import AgentCardResult
        from kiwi_catalog.discovery.verifier import TrustEvaluator

        policy = TrustPolicy.from_config(allowed_knp_versions=["1.0"])
        result = UcpProfileParser(policy).parse(
            profile, source_url="https://kiwi.test/.well-known/ucp"
        )
        out["parse_ok"] = True
        out["specification_version"] = result.specification_version
        out["capabilities"] = list(result.capabilities)
        out["services"] = result.public.get("services")

        evaluator = TrustEvaluator(policy)
        out["knp_claims"] = evaluator._knp_claims(result)

        card = AgentCardResult(
            source_url="https://kiwi.test/.well-known/agent-card.json",
            canonical_domain="kiwi.test",
            name="Test Kiwi Merchant",
            version="1.0.0",
            public={"url": "https://kiwi.test/"},
        )
        evidence = evaluator.evaluate_commerce_capabilities(card, result, "kiwi.test")
        out["commerce_evidence"] = {
            "result": evidence.result,
            "reason": evidence.reason,
            "details": evidence.details,
        }
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
        out["traceback"] = traceback.format_exc()
    print(json.dumps(out))

main()
`;

interface CatalogVerdict {
  parse_ok: boolean;
  error: string | null;
  traceback?: string;
  specification_version?: string;
  capabilities: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>> | null;
  knp_claims: Array<Record<string, unknown>>;
  commerce_evidence: { result: string; reason: string; details: Record<string, unknown> } | null;
}

let httpServer: http.Server;
let scratchDir: string;
let publishedBody: unknown;
let cacheControl: string;

beforeAll(async () => {
  scratchDir = mkdtempSync(path.join(tmpdir(), "kiwi-ucp-roundtrip-"));
  const ledger = new LedgerStore({ dir: scratchDir });
  const idempotency = new IdempotencyStore({ dir: scratchDir });
  // 真实发布路径：A2AServer(ucp: true) → buildUcpProfile → buildKiwiVendorProfile。
  // UCP 规范要求 a2a endpoint 为 https → 逻辑 baseUrl 用 https；
  // HTTP server 实际监听回环端口，profile 经真实 HTTP 取回。
  const server = new A2AServer({
    card: () => ({
      name: "Test Kiwi Merchant",
      description: "A2A test merchant agent",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: "https://kiwi.test",
    }),
    ledger,
    idempotency,
    ucp: true,
  });
  httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}${WELL_KNOWN_UCP_PATH}`);
  expect(res.status).toBe(200);
  cacheControl = res.headers.get("cache-control") ?? "";
  publishedBody = await res.json();
});

afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("UCP round-trip：Kiwi 发布 → Kiwi 校验 → kiwi-catalog 消费 → Kiwi 消费者", () => {
  it("第 1 段：真实 server 发布 canonical UCP profile（HTTP 200 + Cache-Control）", () => {
    // UCP 规范强制：Cache-Control 含 public 且 max-age>=60。
    expect(cacheControl.toLowerCase()).toContain("public");
    const maxAge = /max-age\s*=\s*(\d+)/i.exec(cacheControl)?.[1];
    expect(Number(maxAge)).toBeGreaterThanOrEqual(60);

    // canonical 模型：顶层 ucp:{version, services, capabilities}（审查 P1-03）。
    const body = publishedBody as Record<string, unknown>;
    const ucp = body.ucp as Record<string, unknown>;
    expect(ucp.version).toBe("2026-04-08");
    const services = ucp.services as Record<string, unknown[]>;
    expect(services[KNP_SERVICE]).toHaveLength(1);
    const capabilities = ucp.capabilities as Record<string, unknown[]>;
    const cap = (capabilities[KNP_CAPABILITY] as Record<string, unknown>[])[0]!;
    expect(cap.version).toBe("1.0");
    expect(String(cap.spec)).toContain("https://");
    expect(String(cap.schema)).toContain("https://");
  });

  it("第 2 段：同一份文档过 Kiwi validateUcpProfile——无 profile_malformed、无被拒条目", () => {
    let validation: ReturnType<typeof validateUcpProfile>;
    // profile_malformed 会抛 UcpError——这里不允许抛（P1-03 的原始症状）。
    expect(() => {
      validation = validateUcpProfile(publishedBody);
    }).not.toThrow();
    validation = validateUcpProfile(publishedBody);
    expect(validation.rejected).toEqual([]);
    expect(validation.profile.ucp.capabilities?.[KNP_CAPABILITY]).toHaveLength(1);
    expect(validation.profile.ucp.services?.[KNP_SERVICE]).toHaveLength(1);
  });

  it("第 3 段：kiwi-catalog 真实 parser/verifier 接受该文档，KNP capability 元数据齐备", (ctx) => {
    if (!existsSync(CATALOG_PYTHON)) {
      ctx.skip(`kiwi-catalog .venv missing at ${CATALOG_PYTHON} — catalog leg not executed`);
    }

    const profilePath = path.join(scratchDir, "ucp-profile.json");
    const probePath = path.join(scratchDir, "catalog_probe.py");
    writeFileSync(profilePath, JSON.stringify(publishedBody));
    writeFileSync(probePath, CATALOG_PROBE);

    const stdout = execFileSync(CATALOG_PYTHON, [probePath, profilePath], {
      encoding: "utf-8",
      timeout: 60_000,
    });
    const verdict = JSON.parse(stdout) as CatalogVerdict;

    // catalog 解析必须接受（canonical 适配器）。失败时把 catalog 的精确错误带出来。
    expect(verdict.error, verdict.traceback ?? verdict.error ?? "").toBeNull();
    expect(verdict.parse_ok).toBe(true);
    expect(verdict.specification_version).toBe("2026-04-08");

    // KNP capability 被识别（extract_ucp_capabilities 产出行），且元数据非空。
    const knpRow = verdict.capabilities.find(
      (c) => `${c.namespace}.${c.capability_id}` === KNP_CAPABILITY,
    );
    expect(knpRow, JSON.stringify(verdict.capabilities)).toBeDefined();

    // 每-capability 的 version/spec/schema 必须落到 service specifications 上。
    const knpService = (verdict.services ?? []).find((s) => s.id === KNP_SERVICE);
    expect(knpService, JSON.stringify(verdict.services)).toBeDefined();
    const specs = (knpService?.specifications ?? []) as Array<Record<string, unknown>>;
    const knpSpec = specs.find((sp) => sp.id === KNP_CAPABILITY);
    expect(knpSpec, JSON.stringify(specs)).toBeDefined();
    expect(String(knpSpec?.version ?? "")).not.toBe("");
    expect(String(knpSpec?.specUrl ?? "")).not.toBe("");
    expect(String(knpSpec?.schemaUrl ?? "")).not.toBe("");

    // KNP claim builder：claim 非空，且 version + has_spec + has_schema 齐备。
    expect(verdict.knp_claims.length).toBeGreaterThan(0);
    for (const claim of verdict.knp_claims) {
      expect(String(claim.version ?? ""), JSON.stringify(claim)).not.toBe("");
      expect(claim.has_spec, JSON.stringify(claim)).toBe(true);
      expect(claim.has_schema, JSON.stringify(claim)).toBe(true);
    }

    // commerce capability 交集评估必须 passed（capability intersection 非空的
    // catalog 侧证据：KNP claim 通过治理 + 存在 commerce capability）。
    expect(
      verdict.commerce_evidence?.result,
      verdict.commerce_evidence?.reason ?? "no commerce evidence",
    ).toBe("passed");
  });

  it("第 4 段：Kiwi 消费者类型/路径可消费，capability 交集非空", () => {
    const { profile } = validateUcpProfile(publishedBody);
    // 消费者（platform 侧）声明同名同版本 KNP capability。
    const consumer: UcpProfile = {
      ucp: {
        version: "2026-04-08",
        capabilities: {
          [KNP_CAPABILITY]: [
            {
              version: "1.0",
              spec: "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0",
              schema: "https://kiwi.harrylabsj.com/schemas/negotiation/1.0/schema.json",
            },
          ],
        },
      },
    };
    const result = computeCapabilityIntersection(profile, consumer, "2026-04-08");
    expect(result.compatible).toBe(true);
    expect(result.active.has(KNP_CAPABILITY)).toBe(true);
    expect(result.active.get(KNP_CAPABILITY)?.version).toBe("1.0");
  });
});
