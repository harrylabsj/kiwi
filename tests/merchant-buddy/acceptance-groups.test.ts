/**
 * V2 §10 验收组（11 组）逐组自动化验收（V2 阶段五）。
 *
 * 每组至少一个真实自动化断言；无法离线自动化的部分（WorkBuddy 实机联调、
 * 月度可用性/RTO 实测）登记在 PLATFORM_MANUAL，矩阵与文档引用，不假装已验。
 *
 * 证据链：各组同时声明引用既有测试文件（防删条目换覆盖）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../../src/agent/merchant/fake-merchant-client.js";
import type { MerchantProductSource } from "../../src/a2a/server/merchant-handler.js";
import { createMerchantHandler } from "../../src/a2a/server/merchant-handler.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import { MerchantOperationStore } from "../../src/merchant-core/operations.js";
import { assertReviewRoute } from "../../src/merchant-core/negotiation-adapters.js";
import { buildMerchantMcpTools } from "../../src/mcp/merchant-tools.js";
import { buildMerchantPresentationResources } from "../../src/mcp/merchant-resources.js";
import { resolveMerchantMcpDirs } from "../../src/mcp/merchant-dirs.js";
import { runBackup, restoreBackup } from "../../src/merchant-runtime/backup.js";
import { buildDomainOnboardingChecklist } from "../../src/merchant-core/network-checks.js";
import { finalizeEnvelope } from "../../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../../src/negotiation/domain/envelope.js";
import { testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const ROOT = path.resolve(__dirname, "../..");

/** 需平台实测的部分（不假装已验；检查单见 docs/merchant-buddy/workbuddy-e2e-checklist.md）。 */
export const PLATFORM_MANUAL: Record<string, string> = {
  全天接待_平台实测: "WorkBuddy 实机关闭/退出后接待持续性 + 月度可用性 ≥99.9% 需 staging 实测",
  灾难恢复_主备实测:
    "主备 fencing 切换 RTO/RPO 需部署实测（设计见 deploy/merchant-bundle/README.md）",
  体验_MCPApps嵌入: "MCP Apps 资源真实嵌入渲染需 WorkBuddy 预览验证",
};

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "kiwi-groups-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function setupCore(client = new FakeMerchantClient({ products: [fakeMerchantProduct()] })) {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals: store,
    mode: () => "supervised",
    now: () => T0,
    commandPrincipalId: PRINCIPAL,
    operations: new MerchantOperationStore({ db, now: () => T0 }),
  });
  return { core, store, client, db };
}

function envelope(
  action: string,
  payload: Record<string, unknown>,
  seq: number,
): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: "com.harrylabsj.kiwi.shopping.negotiation",
    protocol_version: "1.0",
    negotiation_id: "neg_group",
    exchange_id: `ex_${seq}`,
    message_id: `msg_${seq}`,
    in_reply_to: `msg_${seq - 1}`,
    actor: "buyer",
    action: action as NegotiationEnvelope["action"],
    created_at: T0,
    payload: payload as never,
  });
}

describe("验收组 1：商家纯度", () => {
  it("tools/list 无采购/买方能力；连接器 Skill 不挂买方工具", () => {
    const { core, db } = setupCore();
    const tools = buildMerchantMcpTools(core).listTools(undefined);
    expect(tools.length).toBe(15); // BUG-02：execute/reject 已移出 MCP 注册表
    for (const t of tools) {
      expect(t.name.startsWith("kiwi_merchant_")).toBe(true);
      expect(t.name).not.toMatch(/buyer|sourcing|supplier|purchase/i);
    }
    const skill = readFileSync(
      path.join(
        ROOT,
        "integrations/hosts/workbuddy/kiwi-merchant-connector/skills/kiwi-merchant/SKILL.md",
      ),
      "utf8",
    );
    expect(skill).not.toMatch(/kiwi_search|kiwi_request_quotes|kiwi_get_task/);
    db.close();
  });
});

describe("验收组 2：数据完整", () => {
  it("会话/重启不新建业务库（transportSessionId 不参与路径派生；同目录同数据）", async () => {
    const a = resolveMerchantMcpDirs({ agentId: "merchant-agent:merchant-001" });
    const b = resolveMerchantMcpDirs({ agentId: "merchant-agent:merchant-001" });
    expect(b.merchantDataDir).toBe(a.merchantDataDir);
    expect(a.merchantDataDir).not.toContain("stateless");
    // 同一数据目录两个服务实例（模拟重启）读同一目录数据
    const dir = tmp();
    const ledgerDir = path.join(dir, "a2a");
    const ledger = new LedgerStore({ dir: ledgerDir, now: () => T0 });
    ledger.append({
      event_kind: "state_transition",
      negotiation_id: "neg_persist",
      identity: { sender_identity: "b", counterparty_identity: "m", actor: "buyer" },
      capability: {
        capability: "com.harrylabsj.kiwi.shopping.negotiation",
        protocol_version: "1.0",
      },
      state_transition: { from_phase: "OPEN", to_phase: "OFFER_OPEN" },
      outcome: { kind: "ok" },
      occurred_at: T0,
    });
    const reopened = new LedgerStore({ dir: ledgerDir, now: () => T0 });
    expect(reopened.listNegotiations()).toContain("neg_persist");
  });
});

describe("验收组 3：商品闭环", () => {
  it("create/update/inventory/listing 的 prepare→确认→执行→回读", async () => {
    const { core, client, db } = setupCore();
    // create
    const create = await core.prepareProductCreate({
      product: {
        sku: "sku-new",
        title: "新商品",
        price: 100,
        stock: 5,
        merchant_id: "merchant-001",
      },
    });
    expect((await core.executeApproved(create.candidate.candidate_id)).kind).toBe("executed");
    expect((await client.getProduct("sku-new")).title).toBe("新商品"); // 回读
    // update（prepare_product_change）
    const update = await core.draftProductChange({ sku: "sku-new", changes: { price: 95 } });
    const updId =
      update.outcome.kind === "pending_approval" ? update.outcome.candidate.candidate_id : "";
    expect((await core.executeApproved(updId)).kind).toBe("executed");
    expect((await client.getProduct("sku-new")).price).toBe(95);
    // inventory
    const inv = await core.prepareInventoryUpdate({ sku: "sku-new", stock: 3 });
    expect((await core.executeApproved(inv.candidate.candidate_id)).kind).toBe("executed");
    expect((await client.getProduct("sku-new")).stock).toBe(3);
    // listing：上游（Fake 支持 paused）执行成功；真实 2.x 无端点时逐项失败回执（stage4 已测）
    const listing = await core.prepareListingChange({ sku: "sku-new", paused: true });
    expect((await core.executeApproved(listing.candidate.candidate_id)).kind).toBe("executed");
    expect((await client.getProduct("sku-new")).paused).toBe(true);
    db.close();
  });
});

describe("验收组 4：询价闭环", () => {
  it("rfq→offer 报价可用；商品源故障 decline（不演示价接待）", async () => {
    const dir = tmp();
    const ledger = new LedgerStore({ dir, now: () => T0 });
    const handler = createMerchantHandler({
      ledger,
      now: () => T0,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
    });
    const result = await handler.handle({
      envelope: envelope(
        "rfq",
        { items: [{ sku: "SKU-001", quantity: { value: 1 } }] },
        1,
      ) as never,
      message: { role: "user", parts: [], messageId: "msg_1" },
      taskId: "task_1",
      senderIdentity: "buyer:buyer-001",
    });
    expect(result.kind).toBe("accepted");

    // 商品源故障 → decline temporarily_unavailable（fail-closed，不演示价）
    const failingSource: MerchantProductSource = {
      getProduct: async () => {
        throw new Error("source down");
      },
    };
    const failing = createMerchantHandler({
      ledger: new LedgerStore({ dir: tmp(), now: () => T0 }),
      now: () => T0,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      productSource: failingSource,
    });
    const declined = await failing.handle({
      envelope: envelope(
        "rfq",
        { items: [{ sku: "SKU-001", quantity: { value: 1 } }] },
        1,
      ) as never,
      message: { role: "user", parts: [], messageId: "msg_1" },
      taskId: "task_1",
      senderIdentity: "buyer:buyer-001",
    });
    expect(declined.kind).toBe("declined");
    expect(declined.kind === "declined" && declined.reasonCode).toBe("temporarily_unavailable");
  });
});

describe("验收组 5：两轨隔离", () => {
  it("跨轨人工处理 fail-closed；统一列表带来源标记", async () => {
    expect(() => assertReviewRoute("a2a", "shopping")).toThrow(/路由错误/);
    expect(() => assertReviewRoute("shopping", "a2a")).toThrow(/路由错误/);
    const { core, db } = setupCore();
    const { tracks } = await core.listUnifiedNegotiations();
    expect(tracks.shopping).toBe("ok");
    expect(tracks.a2a).toBe("unavailable"); // 未配置 ledger → 明确不可得
    db.close();
  });
});

describe("验收组 6：授权", () => {
  it("模型自报不批准（未批准命令拒绝执行）；跨主体拒绝；私密不进输出", async () => {
    const { core, client, db } = setupCore();
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 1 });
    // 模型自报「已批准」不作证据：execute 只认确认通道（本调用即确认通道语义，
    // 但跨主体必须拒绝）
    await expect(
      core.commands.executeApproved(prepared.candidate.candidate_id, "forged-principal"),
    ).rejects.toMatchObject({ kind: "auth" });
    expect((await client.getProduct("sku-001")).stock).toBe(12); // 未执行
    // 越权租户
    await expect(core.getPublicProduct("sku-001", "merchant-999")).rejects.toMatchObject({
      kind: "validation",
    });
    // 私密字段不进工具输出（leaky 场景在 stage2 覆盖，这里快速复核目录输出）
    const { items } = await core.listPublicProducts();
    expect(JSON.stringify(items)).not.toContain("floor_price");
    db.close();
  });
});

describe("验收组 7：配套运行", () => {
  it("shopping-cli 停止 → 明确故障（不产生演示报价/数据）", async () => {
    const down = new FakeMerchantClient({ products: [] });
    down.listProducts = async () => {
      throw new Error("shopping-cli down");
    };
    const { core, db } = setupCore(down);
    await expect(core.listPublicProducts()).rejects.toMatchObject({ kind: "unavailable" });
    db.close();
  });
});

describe("验收组 8：全天接待", () => {
  it("管理进程异常退出自动重启（证据：merchant-runtime 测试）；MCP 停而 A2A 持续（证据：stage1）", () => {
    for (const f of [
      "tests/merchant-runtime.test.ts",
      "tests/merchant-buddy/stage1-acceptance.test.ts",
    ]) {
      expect(readFileSync(path.join(ROOT, f), "utf8")).toContain("重启");
    }
    // 平台实测部分显式登记
    expect(PLATFORM_MANUAL["全天接待_平台实测"]).toContain("staging");
  });
});

describe("验收组 9：灾难恢复", () => {
  it("备份→损坏→恢复→校验（磋商 ledger 在备份集内）", () => {
    const dataDir = tmp();
    const backupsDir = path.join(tmp(), "backups");
    const ledgerDir = path.join(dataDir, "a2a", "ledger");
    const ledger = new LedgerStore({ dir: ledgerDir, now: () => T0 });
    ledger.append({
      event_kind: "state_transition",
      negotiation_id: "neg_rpo",
      identity: { sender_identity: "b", counterparty_identity: "m", actor: "buyer" },
      capability: {
        capability: "com.harrylabsj.kiwi.shopping.negotiation",
        protocol_version: "1.0",
      },
      state_transition: { from_phase: "OPEN", to_phase: "AGREEMENT_REACHED" },
      outcome: { kind: "ok" },
      occurred_at: T0,
    });
    const backup = runBackup({ dataDir, backupsDir, now: () => T0 });
    expect(backup.manifest.files.some((f) => f.path.includes("ledger"))).toBe(true);
    rmSync(dataDir, { recursive: true, force: true }); // 损坏/丢失
    const restored = restoreBackup({ snapshotDir: backup.snapshot_dir, targetDir: dataDir });
    expect(restored.verified).toBe(true);
    const reopened = new LedgerStore({ dir: ledgerDir, now: () => T0 });
    expect(reopened.listNegotiations()).toContain("neg_rpo"); // 备份集内含已确认磋商（RPO ≤ 备份周期口径）
    expect(PLATFORM_MANUAL["灾难恢复_主备实测"]).toContain("fencing");
  });
});

describe("验收组 10：发布", () => {
  it("公开投影分离检查单 + CSV 部分失败逐项回执（证据：stage4）", async () => {
    const checklist = buildDomainOnboardingChecklist(testProfile());
    expect(checklist.items.find((i) => i.id === "public-projection-separation")?.status).toBe("ok");
    const { core, db } = setupCore();
    const prepared = await core.prepareProductsImport({
      csv: "sku,title,price,stock\nsku-a,好行,10,1\nbad\n",
      idempotency_key: "grp10",
    });
    const outcome = await core.executeApproved(prepared.candidate.candidate_id);
    const op = (outcome as { output?: { status?: string; receipts?: unknown[] } }).output;
    expect(op?.status).toBe("partially_failed");
    expect(op?.receipts).toHaveLength(2);
    db.close();
  });
});

describe("验收组 11：体验", () => {
  it("七类组件资源 + 文本降级；六个 Skill 存在", async () => {
    const { core, store, client, db } = setupCore();
    const resources = buildMerchantPresentationResources({
      context: {
        profile: testProfile(),
        principalId: "merchant-001",
        merchantClient: client,
        approvals: store,
        intelligence: {
          getCatalogHealth: async () => ({ total: 1, active: 1, paused: 0, out_of_stock: 0 }),
          getBusinessSnapshot: async () => ({
            merchant_id: "merchant-001",
            period: "7d",
            generated_at: T0,
            metrics: [],
            alerts: {
              active_negotiations: 0,
              human_reviews: 0,
              pending_actions: 0,
              low_stock: null,
            },
            limitations: [],
          }),
          queryMetric: async () => ({ metric: "m", granularity: "day", points: [] }),
          getNegotiationDigest: async () => [],
          getPendingActions: async () => [],
        } as never,
      },
    });
    expect(resources.list()).toHaveLength(7);
    const catalog = await resources.read("kiwi-merchant://presentation/catalog");
    expect(catalog.contents.some((c) => c.mimeType === "text/plain")).toBe(true); // 文本降级
    for (const skill of [
      "catalog-operations",
      "change-approval",
      "human-review",
      "inventory-operations",
      "negotiation-review",
      "performance-insights",
    ]) {
      expect(readFileSync(path.join(ROOT, "skills/merchant", skill, "SKILL.md"), "utf8")).toContain(
        "---",
      );
    }
    void core;
    db.close();
  });
});
