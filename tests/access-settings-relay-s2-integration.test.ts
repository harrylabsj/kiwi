/**
 * 合并态边界回归：商家后台接入方式（access-settings）与 S2 买家终态门
 * 同时存在时，二者必须保持正交。
 *
 * 事实边界：
 *  - `merchant-access-mode.json` 只是商家本实例的**非凭据**读取偏好；买家侧
 *    不读取该文件。买家只看 Catalog 公开记录（新目录的显式 `buyer_access`
 *    投影，或旧目录的 `runtime_access`）与目录回查结果。
 *  - 首次绑定在 `no_share_code` 下不把已暂存分享码随 bind 提交（由
 *    connect-service.test.ts 覆盖）。本文件覆盖其两种可观察结果：
 *      1. 目录仍留有旧 active 分享码：S2 终态门必须 fail-closed、零带码直连；
 *      2. 目录明确 404（没有 active 分享码）：允许标准无码直连。
 *  - 本地文件本身不能让买家按本地偏好绕过中继；只有经授权同步到目录的
 *    显式 `buyer_access` 才影响路由。本文件构造的旧记录没有该投影，因此
 *    仍钉住“本地文件不直接进入买家路径”。
 *
 * 这里直接构造真实 `buildBuyerService`，只替换两个目录网络源，确保覆盖的是
 * 组合层真实顺序，而不是 fetcher 的孤立单元行为。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relaySources = vi.hoisted(() => ({
  openGet: vi.fn(),
  accessGet: vi.fn(),
}));

vi.mock("../src/discovery/catalog-source/open-inquiry.js", () => ({
  OpenInquirySource: class {
    async get(agentId: string, merchantId: string) {
      return await relaySources.openGet(agentId, merchantId);
    }
  },
}));

vi.mock("../src/discovery/catalog-source/merchant-access.js", () => ({
  MerchantAccessSource: class {
    async get(agentId: string, options: { runtimeOrigin?: string }) {
      return await relaySources.accessGet(agentId, options);
    }
  },
}));

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { ProtocolTaskContext } from "../src/buyer-core/protocol-recovery.js";
import type { MerchantRecord, QuoteCandidateInput } from "../src/buyer-core/service.js";
import {
  accessModePath,
  readAccessMode,
  writeAccessMode,
  type MerchantAccessMode,
} from "../src/cloud/access/access-mode.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const CATALOG = "https://catalog.kiwi.harrylabsj.com";
const INTENT = {
  intent_id: "intent-access-settings-relay-s2",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 1, unit: "台" } }],
  constraints: { currency: "CNY", deadline: "2027-12-31T18:00:00Z" },
};
const CONTEXT: ProtocolTaskContext = {
  taskId: "task-access-settings-relay-s2",
  createdAt: new Date().toISOString(),
  intentBindingDigest: contentDigest(INTENT),
};
const SHARE_CONFIG = {
  catalog_agent_id: "cagt_merged_wb",
  runtime_origin: "https://acme.app.workbuddy.host",
  secret_value: "SYNTHETIC-MERGED-CODE",
  provider: "workbuddy",
  access_mode: "share_parameter",
  parameter_name: "sharecode",
  config_version: 1,
  adapter_version: "workbuddy-share-v1",
  auth_mode: "signature",
  validated_at: "2026-11-11T00:00:00Z",
  updated_at: "2026-11-11T00:00:00Z",
};
const WB_MERCHANT: MerchantRecord = {
  merchant_id: "merchant-merged-wb",
  name: "合并态 WorkBuddy 商家",
  verified: true,
  capabilities: [],
  catalog_agent_id: "cagt_merged_wb",
  agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
};

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "access-settings-relay-s2-"));
  dirs.push(dir);
  return dir;
}

function buildService(dir: string) {
  return buildBuyerService({
    dbPath: ":memory:",
    protocolStateDir: dir,
    principal: "buyer:access-settings-relay-s2",
    buyerAgentId: "buyer-agent:access-settings-relay-s2",
    sessionId: "access-settings-relay-s2",
    policy: { ...DEFAULT_DELEGATION_POLICY, principal: "buyer:access-settings-relay-s2" },
    catalogUrl: CATALOG,
    catalogSessionToken: "synthetic-buyer-session",
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 3000,
  });
}

function requestQuotes(
  service: ReturnType<typeof buildBuyerService>,
  merchants: MerchantRecord[],
): Promise<QuoteCandidateInput[]> {
  const fetcher = (service as unknown as {
    quoteFetcher: {
      requestQuotes(
        intent: Record<string, unknown>,
        merchants: MerchantRecord[],
        context?: ProtocolTaskContext,
      ): Promise<QuoteCandidateInput[]>;
    };
  }).quoteFetcher;
  return fetcher.requestQuotes(INTENT, merchants, CONTEXT);
}

function merchantAccess(service: ReturnType<typeof buildBuyerService>) {
  return (service as unknown as {
    quoteFetcher: {
      merchantAccess: {
        forMerchant(
          merchant: MerchantRecord,
        ): Promise<{ direct?: true; sendUrlFor(url: string): string } | null>;
      };
    };
  }).quoteFetcher.merchantAccess;
}

beforeEach(() => {
  relaySources.openGet.mockReset();
  relaySources.accessGet.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("后台接入方式与 S2 买家终态门同时存在", () => {
  it.each(["auto", "share_code", "no_share_code"] satisfies MerchantAccessMode[])(
    "本地 %s：目录仍有 active 分享码且中继 404 时，任何模式都不带码直连",
    async (mode) => {
      const dir = makeDir();
      writeAccessMode(dir, mode);
      const modeFileBefore = readFileSync(accessModePath(dir), "utf8");
      relaySources.openGet.mockResolvedValue(null);
      relaySources.accessGet.mockResolvedValue(SHARE_CONFIG);
      const network = vi.fn(() => {
        throw new Error("merchant settings must not turn an active share code into direct access");
      });
      vi.stubGlobal("fetch", network);

      const results = await requestQuotes(buildService(dir), [WB_MERCHANT]);

      // 本地偏好存在，但买家仍按目录 active 码走终态门：零网络、不取码直连。
      expect(relaySources.accessGet).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
      expect(results[0]?.status).toBe("failed");
      expect(results[0]?.failure?.classification).toBe("access_unavailable");
      // 买家路径不写、不删商家模式文件。
      expect(readFileSync(accessModePath(dir), "utf8")).toBe(modeFileBefore);
    },
  );

  it("本地 no_share_code + 目录明确 404：已加白/无码商家仍可无码直连", async () => {
    const dir = makeDir();
    writeAccessMode(dir, "no_share_code");
    const modeFileBefore = readFileSync(accessModePath(dir), "utf8");
    relaySources.openGet.mockResolvedValue(null);
    relaySources.accessGet.mockResolvedValue(null);
    const network = vi.fn(() => {
      throw new Error("only the transport marker is inspected here");
    });
    vi.stubGlobal("fetch", network);

    const access = await merchantAccess(buildService(dir)).forMerchant(WB_MERCHANT);

    // 目录明确 404 是正向“无 active 码”信号；本地 no_share_code 既不阻碍，
    // 也不会把它改成带码/中继。买家侧没有发起网络请求，只拿到无码 transport。
    expect(access?.direct).toBe(true);
    expect(access?.sendUrlFor("https://acme.app.workbuddy.host/a2a"))
      .toBe("https://acme.app.workbuddy.host/a2a");
    expect(network).not.toHaveBeenCalled();
    expect(readFileSync(accessModePath(dir), "utf8")).toBe(modeFileBefore);
    expect(readAccessMode(dir)).toEqual({ mode: "no_share_code", persisted: true, invalid: false });
  });

  it("本地 no_share_code 不会让声明 runtime_access 的商家跳过中继回查", async () => {
    const dir = makeDir();
    writeAccessMode(dir, "no_share_code");
    relaySources.openGet.mockResolvedValue(null);
    relaySources.accessGet.mockResolvedValue(SHARE_CONFIG);
    const network = vi.fn(() => {
      throw new Error("declared runtime_access must fail closed without a relay route");
    });
    vi.stubGlobal("fetch", network);

    const results = await requestQuotes(buildService(dir), [{
      ...WB_MERCHANT,
      runtime_access: {
        provider: "workbuddy",
        access_mode: "share_parameter",
        parameter_name: "sharecode",
        config_version: 1,
        adapter_version: "workbuddy-share-v1",
        auth_mode: "signature",
      },
    }]);

    // 声明了 runtime_access：中继 404 后不再向目录取码（S2 不变量）。
    expect(relaySources.accessGet).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
  });
});
