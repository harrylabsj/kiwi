/**
 * V2 阶段三写闭环验收测试（merchant-core commands/executor）：
 * - 展示≠执行：prepare 只产候选与预览，不改业务状态；
 * - 无真实确认无法扩大权限：未批准/跨主体批准拒绝；
 * - 重复提交只执行一次（幂等）；
 * - 前置版本变更 → stale/superseded；过期 → expired，拒绝旧授权；
 * - 重启恢复：pending 命令重启后经注册表重建钩子，再校验再执行；
 * - F08 listing 语义：能力缺失 fail-closed「不可得」；
 * - F14 两轨：A2A 人审不报 shopping 通道；shopping 轨走 resolver；
 * - F17 策略热更新：执行器写入覆盖层即生效；硬策略（私有底价）执行器强制。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { MerchantCoreService, type MerchantCoreServiceDeps } from "../src/merchant-core/service.js";
import { MerchantPolicyRuntime } from "../src/merchant-core/policy-runtime.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function setupCore(
  options: Partial<MerchantCoreServiceDeps> & { clock?: { value: string } } = {},
): {
  core: MerchantCoreService;
  store: WriteApprovalCandidateStore;
  client: FakeMerchantClient;
  db: DatabaseSync;
} {
  const clock = options.clock ?? { value: T0 };
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new WriteApprovalCandidateStore({
    db,
    principalId: PRINCIPAL,
    now: () => clock.value,
  });
  const client = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
  const { clock: _clock, ...rest } = options;
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals: store,
    mode: () => "supervised",
    now: () => clock.value,
    commandPrincipalId: PRINCIPAL,
    ...rest,
  });
  return { core, store, client, db };
}

describe("写闭环：prepare → 确认 → 执行", () => {
  it("展示≠执行：prepare 只产候选与预览，不改业务状态", async () => {
    const { core, client, db } = setupCore();
    const spy = vi.spyOn(client, "updateProduct");
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 5 });
    expect(prepared.outcome.kind).toBe("pending_approval");
    expect(prepared.preview.arguments).toMatchObject({ sku: "sku-001", stock: 5 });
    expect(prepared.preview.before).toMatchObject({ sku: "sku-001" });
    expect(spy).not.toHaveBeenCalled();
    expect((await client.getProduct("sku-001")).stock).toBe(12); // 业务状态未变
    db.close();
  });

  it("execute_approved：批准后真正执行；重复执行幂等拒绝", async () => {
    const { core, client, db } = setupCore();
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 5 });
    const id = prepared.candidate.candidate_id;
    const spy = vi.spyOn(client, "updateProduct");

    const first = await core.executeApproved(id);
    expect(first.kind).toBe("executed");
    expect((await client.getProduct("sku-001")).stock).toBe(5);
    expect(spy).toHaveBeenCalledTimes(1);

    // 幂等：重放同一 command_id 不二次执行
    const replay = await core.executeApproved(id);
    expect(replay.kind).toBe("not_approvable");
    expect(spy).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("前置版本变更（对象已改）→ 旧授权 stale/superseded，绝不执行", async () => {
    const { core, client, store, db } = setupCore();
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 5 });
    // 执行前库存被别人改了（前置版本不再匹配）
    await client.updateProduct("sku-001", { stock: 99 });
    const outcome = await core.executeApproved(prepared.candidate.candidate_id);
    expect(outcome.kind).toBe("stale");
    expect(store.get(prepared.candidate.candidate_id)?.status).toBe("superseded");
    expect((await client.getProduct("sku-001")).stock).toBe(99); // 未被覆盖
    db.close();
  });

  it("过期候选拒绝旧授权（expired）", async () => {
    const clock = { value: T0 };
    const { core, db } = setupCore({ clock });
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 5 });
    clock.value = new Date(Date.parse(T0) + 16 * 60 * 1000).toISOString(); // 越过 15 分钟窗口
    await expect(core.executeApproved(prepared.candidate.candidate_id)).rejects.toMatchObject({
      kind: "validation",
    });
    db.close();
  });

  it("跨主体批准拒绝（授权主体一致性校验）", async () => {
    const { core, db } = setupCore();
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 5 });
    await expect(
      core.commands.executeApproved(prepared.candidate.candidate_id, "someone-else"),
    ).rejects.toMatchObject({ kind: "auth" });
    db.close();
  });

  it("重启恢复：pending 命令经注册表重建钩子，再校验再执行", async () => {
    const clock = { value: T0 };
    const { core, store, client, db } = setupCore({ clock });
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 7 });
    // 模拟重启：新 core 实例（同一 store/client）
    const restarted = new MerchantCoreService({
      profile: testProfile(),
      merchantClient: client,
      approvals: store,
      mode: () => "supervised",
      now: () => clock.value,
      commandPrincipalId: PRINCIPAL,
    });
    const recovered = restarted.recoverPendingCommands();
    expect(recovered.recovered).toBe(1);
    const outcome = await restarted.executeApproved(prepared.candidate.candidate_id);
    expect(outcome.kind).toBe("executed");
    expect((await client.getProduct("sku-001")).stock).toBe(7);
    // V1 draft 候选（tool=draft_product_change）同机制恢复
    void core;
    db.close();
  });

  it("硬策略强制：低于私有底价的价格变更在执行层被拒（不透出底价）", async () => {
    const { core, client, store, db } = setupCore();
    // testProfile min_unit_price_private = 80
    const prepared = await core.commands.prepare({
      tool: "draft_product_change",
      arguments: { sku: "sku-001", changes: { price: 50 }, reason: "" },
    });
    const outcome = await core.executeApproved(prepared.candidate.candidate_id);
    expect(outcome.kind).toBe("stale"); // 执行抛错 → superseded
    expect(outcome.kind === "stale" && outcome.reason).toContain("硬策略");
    expect(store.get(prepared.candidate.candidate_id)?.status).toBe("superseded");
    expect((await client.getProduct("sku-001")).price).toBe(99); // 未写入
    db.close();
  });

  it("BUG-07：硬策略按运行中生效策略校验（运行中把底价从 80 提到 90 后，85 元被拒）", async () => {
    // testProfile min_unit_price_private = 80（base）；运行中策略可覆盖。
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-policy-floor-"));
    dirs.push(dir);
    const policyRuntime = new MerchantPolicyRuntime({
      basePolicy: { min_unit_price_private: 80 },
      file: path.join(dir, "policy-overrides.json"),
      now: () => T0,
    });
    const { core, client, db } = setupCore({
      applyPolicyOverride: (patch) => policyRuntime.apply(patch),
      currentPolicy: () => policyRuntime.current().policy,
    });
    // base 底价 80：85 元合法，执行通过。
    const p1 = await core.commands.prepare({
      tool: "draft_product_change",
      arguments: { sku: "sku-001", changes: { price: 85 }, reason: "" },
    });
    expect((await core.executeApproved(p1.candidate.candidate_id)).kind).toBe("executed");
    // 运行中策略把底价提到 90 → 同样 85 元，执行层拒绝（证明读的是运行中策略，
    // 不是启动 profile 的 80）。
    policyRuntime.apply({ min_unit_price_private: 90 });
    const p2 = await core.commands.prepare({
      tool: "draft_product_change",
      arguments: { sku: "sku-001", changes: { price: 85 }, reason: "" },
    });
    const outcome = await core.executeApproved(p2.candidate.candidate_id);
    expect(outcome.kind).toBe("stale");
    expect(outcome.kind === "stale" && outcome.reason).toContain("硬策略");
    expect((await client.getProduct("sku-001")).price).toBe(85); // 未写入
    db.close();
  });
});

describe("写面覆盖（F08/F14/F17）", () => {
  it("F08 listing：能力缺失 fail-closed「不可得」（不库存写零）", async () => {
    const { core, db } = setupCore({ capabilities: { listing_pause: false } });
    await expect(core.prepareListingChange({ sku: "sku-001", paused: true })).rejects.toMatchObject(
      { kind: "unavailable" },
    );
    db.close();
  });

  it("F14 两轨：A2A 人审报「不可得」（绝不跨轨）；shopping 轨走 resolver 闭环", async () => {
    const resolve = vi.fn(async () => ({ ok: true }));
    const { core, db } = setupCore({ resolveShoppingReview: resolve });
    await expect(
      core.prepareReviewResolve({ source_protocol: "a2a", source_id: "neg_1", resolution: "ok" }),
    ).rejects.toMatchObject({ kind: "unavailable" });

    const prepared = await core.prepareReviewResolve({
      source_protocol: "shopping",
      source_id: "conv-1",
      resolution: "已人工回复",
    });
    expect(prepared.outcome.kind).toBe("pending_approval");
    const outcome = await core.executeApproved(prepared.candidate.candidate_id);
    expect(outcome.kind).toBe("executed");
    expect(resolve).toHaveBeenCalledWith({ conversation_id: "conv-1", resolution: "已人工回复" });
    db.close();
  });

  it("F17 策略热更新：执行器经运行时校验+原子写完整生效策略（BUG-07）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-policy-"));
    dirs.push(dir);
    const policyRuntime = new MerchantPolicyRuntime({
      basePolicy: undefined,
      file: path.join(dir, "policy-overrides.json"),
      now: () => T0,
    });
    const { core, db } = setupCore({
      applyPolicyOverride: (patch) => policyRuntime.apply(patch),
      currentPolicy: () => policyRuntime.current().policy,
    });
    const prepared = await core.preparePolicyChange({ patch: { max_auto_discount_percent: 10 } });
    const outcome = await core.executeApproved(prepared.candidate.candidate_id);
    expect(outcome.kind).toBe("executed");
    const saved = JSON.parse(readFileSync(path.join(dir, "policy-overrides.json"), "utf8"));
    // BUG-07：文件是**完整生效策略**（含 version/updated_at），不是裸 patch。
    expect(saved.policy).toEqual({ max_auto_discount_percent: 10 });
    expect(saved.version).toBe(1);
    // 运行中策略立即生效（同进程执行器经 currentPolicy 读取）。
    expect(policyRuntime.current().policy).toEqual({ max_auto_discount_percent: 10 });
    expect(policyRuntime.current().version).toBe(1);
    db.close();
  });
});

describe("配套商家确认页面（src/merchant-admin/ 最小骨架）", () => {
  it("待批准页列出命令（预览=参数+前置版本+有效期）；空态明确", async () => {
    const { renderPendingPage } = await import("../src/merchant-admin/pending-page.js");
    const { core, db } = setupCore();
    expect(renderPendingPage("测试商家", [])).toContain("当前没有待批准命令");
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 5 });
    const html = renderPendingPage("测试商家", core.listPendingCommands());
    expect(html).toContain(prepared.candidate.candidate_id);
    expect(html).toContain("kiwi_merchant_prepare_inventory_update");
    expect(html).toContain("批准并执行");
    expect(html).toContain("拒绝");
    expect(html).toContain("测试商家");
    db.close();
  });

  it("merchantAdminSurface 桥接 core 的确认通道", async () => {
    const { merchantAdminSurface } = await import("../src/merchant-admin/pending-page.js");
    const { core, client, db } = setupCore();
    const admin = merchantAdminSurface(core);
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 3 });
    expect(admin.listPending()).toHaveLength(1);
    await admin.executeApproved(prepared.candidate.candidate_id, PRINCIPAL);
    expect((await client.getProduct("sku-001")).stock).toBe(3);
    const prepared2 = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 9 });
    await admin.rejectCandidate(prepared2.candidate.candidate_id, PRINCIPAL);
    expect((await client.getProduct("sku-001")).stock).toBe(3);
    db.close();
  });
});
