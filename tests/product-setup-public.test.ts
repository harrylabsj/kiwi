/**
 * `kiwi merchant setup-public` 测试（产品层 D3 —— 公网 A2A 暴露引导）。
 *
 * 覆盖：
 * - validatePublicDomain：归一化 + 非法输入 fail-closed（scheme/path/port/无点等）；
 * - buildCaddyfile：反代配置生成、非法端口回退 9000；
 * - checkDomainDns：ok / mismatch / unresolved / skipped（mock lookup 注入）；
 * - detectPublicIp：返回 IP / 非 IP / 失败降级 null（mock fetch 注入）；
 * - runMerchantSetupPublic：编排 + 写 Caddyfile + instructions + --check（全注入）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  SetupPublicError,
  buildCaddyfile,
  checkDomainDns,
  detectPublicIp,
  runMerchantSetupPublic,
  validatePublicDomain,
} from "../src/product-setup-public.js";

describe("validatePublicDomain", () => {
  it("归一化并返回小写域名", () => {
    expect(validatePublicDomain(" Merchant.Example.COM ")).toBe("merchant.example.com");
  });

  it("非法输入 fail-closed（scheme/path/port/userinfo/无点/空格）", () => {
    const cases: Array<[string, string]> = [
      ["", "domain_required"],
      ["https://merchant.example.com", "domain_scheme"],
      ["merchant.example.com/x", "domain_path"],
      ["merchant.example.com:8443", "domain_invalid"],
      ["merchant@example.com", "domain_invalid"],
      ["merchant", "domain_tld"],
      ["merchant example.com", "domain_invalid"],
    ];
    for (const [input, code] of cases) {
      let err: SetupPublicError | null = null;
      try {
        validatePublicDomain(input);
      } catch (e) {
        err = e as SetupPublicError;
      }
      expect(err, input).not.toBeNull();
      expect(err!.code, input).toBe(code);
    }
  });
});

describe("buildCaddyfile", () => {
  it("生成反代配置（域名 + 端口）", () => {
    const out = buildCaddyfile("merchant.example.com", 9000);
    expect(out).toContain("merchant.example.com {");
    expect(out).toContain("reverse_proxy 127.0.0.1:9000");
  });

  it("非法端口回退 9000", () => {
    expect(buildCaddyfile("a.example.com", 0)).toContain("reverse_proxy 127.0.0.1:9000");
  });
});

describe("checkDomainDns", () => {
  it("解析一致 → ok", async () => {
    const r = await checkDomainDns("m.example.com", "1.2.3.4", async () => "1.2.3.4");
    expect(r.status).toBe("ok");
    expect(r.resolved).toBe("1.2.3.4");
  });

  it("解析不一致 → mismatch", async () => {
    const r = await checkDomainDns("m.example.com", "1.2.3.4", async () => "5.6.7.8");
    expect(r.status).toBe("mismatch");
  });

  it("解析失败 → unresolved", async () => {
    const r = await checkDomainDns("m.example.com", "1.2.3.4", async () => null);
    expect(r.status).toBe("unresolved");
  });

  it("无期望 IP → skipped", async () => {
    const r = await checkDomainDns("m.example.com", null, async () => "1.2.3.4");
    expect(r.status).toBe("skipped");
  });
});

describe("detectPublicIp", () => {
  it("返回 IP", async () => {
    const fetchImpl = vi.fn(async () => new Response("1.2.3.4", { status: 200 })) as typeof fetch;
    expect(await detectPublicIp(fetchImpl)).toBe("1.2.3.4");
  });

  it("非 IP 响应 → null", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-an-ip", { status: 200 })) as typeof fetch;
    expect(await detectPublicIp(fetchImpl)).toBeNull();
  });

  it("请求失败 → null（降级不 crash）", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("net down");
    }) as typeof fetch;
    expect(await detectPublicIp(fetchImpl)).toBeNull();
  });
});

describe("runMerchantSetupPublic", () => {
  it("编排：检测 IP → DNS → 写 Caddyfile → 输出指引 → --check", async () => {
    const written: Array<string> = [];
    const report = await runMerchantSetupPublic({
      domain: "merchant.example.com",
      port: 9000,
      caddyfilePath: "/tmp/Caddyfile.kiwi",
      merchantAgentId: "mkt_test",
      profilePath: "/tmp/merchant.yaml",
      publicIpOverride: "1.2.3.4",
      lookupImpl: async () => "1.2.3.4",
      writeFileImpl: async (p, c) => {
        written.push(`${p}::${c}`);
      },
      fetchImpl: (async () => new Response("", { status: 200 })) as typeof fetch,
      checkNow: true,
    });

    expect(report.publicIp).toBe("1.2.3.4");
    expect(report.dns.status).toBe("ok");
    expect(report.caddyfile).toContain("reverse_proxy 127.0.0.1:9000");
    expect(report.check?.httpStatus).toBe(200);
    expect(written[0]).toContain("/tmp/Caddyfile.kiwi");
    const guide = report.instructions.join("\n");
    expect(guide).toContain("KIWI_A2A_PUBLIC_URL=https://merchant.example.com");
    expect(guide).toContain("--profile /tmp/merchant.yaml");
    expect(guide).toContain("curl -sI https://merchant.example.com/.well-known/agent-card.json");
  });

  it("未检测到公网 IP 且 checkNow 失败时降级（DNS skipped、check 记录失败）", async () => {
    const report = await runMerchantSetupPublic({
      domain: "merchant.example.com",
      port: 9000,
      caddyfilePath: "Caddyfile.kiwi",
      merchantAgentId: "mkt_test",
      publicIpOverride: null,
      lookupImpl: async () => "1.2.3.4",
      writeFileImpl: async () => {},
      fetchImpl: (async () => {
        throw new Error("unreachable");
      }) as typeof fetch,
      checkNow: true,
    });
    expect(report.publicIp).toBeNull();
    expect(report.dns.status).toBe("skipped");
    expect(report.check?.httpStatus).toBeNull();
    expect(report.caddyfilePath).toBe("Caddyfile.kiwi");
  });
});
