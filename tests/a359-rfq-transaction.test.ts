import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import type { MerchantCatalogProduct } from "../src/agent/merchant/types.js";
import { MerchantOAuthStore } from "../src/auth/merchant-oauth.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { MerchantRfqService, type RfqCallContext } from "../src/merchant-core/rfq/service.js";
import { RfqRepository } from "../src/merchant-core/rfq/repository.js";
import { RfqArtifactStore, ensureArtifactRoot } from "../src/merchant-core/rfq/artifacts.js";
import { RfqReleaseCoordinator } from "../src/merchant-core/rfq/release-coordinator.js";
import { MerchantClientCommerceDataSource } from "../src/merchant-core/rfq/data-source-adapter.js";
import type { CommerceDataSource } from "../src/commerce/data-source.js";
import { testProfile } from "./helpers.js";
import { assembleMerchantRuntime } from "../src/mcp/merchant-runtime-assembly.js";
const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

const INQUIRY =
  "你好，我们需要手写陶瓷杯 10 个，含税，税率13%，运费10元，7天内发货，款到发货。收件人：张三";

function setup(
  options: {
    clock?: { value: string };
    mode?: "manual" | "supervised" | "autopilot";
    priceUnit?: "minor" | "yuan";
    products?: MerchantCatalogProduct[];
    dataSource?: CommerceDataSource;
  } = {},
) {
  const clock = options.clock ?? { value: T0 };
  const now = () => clock.value;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now });
  const confirmations = new MerchantOAuthStore({ db: new DatabaseSync(":memory:"), now });
  const client = new FakeMerchantClient({
    products: options.products ?? [fakeMerchantProduct()],
    now: T0,
  });
  const root = mkdtempSync(path.join(tmpdir(), "kiwi-rfq-"));
  dirs.push(root);
  ensureArtifactRoot(root);
  const dataSource =
    options.dataSource ??
    new MerchantClientCommerceDataSource({
      client,
      merchantId: MERCHANT,
      ...(options.priceUnit !== undefined ? { priceUnit: options.priceUnit } : {}),
      now,
    });
  const repo = new RfqRepository({ db, merchantId: MERCHANT, now });
  const artifacts = new RfqArtifactStore({ root, now });
  const coordinator = new RfqReleaseCoordinator({
    repo,
    artifacts,
    now,
    currentPolicy: () => ({ version: "policy-0-test", config: undefined }),
  });
  const service = new MerchantRfqService({
    repo,
    dataSource,
    artifacts,
    coordinator,
    now,
    confirmationMinter: (input) => `cfm-${input.caseId}-${input.lineId}-${input.sku}`,
    candidateStatus: (candidateId) => approvals.get(candidateId)?.status,
    policyVersion: () => "policy-0-test",
  });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals,
    mode: () => options.mode ?? "supervised",
    now,
    commandPrincipalId: PRINCIPAL,
    confirmations,
    rfq: { service, executors: coordinator.buildExecutors() },
  });
  const ctx: RfqCallContext = { principalId: PRINCIPAL, actor: PRINCIPAL, traceId: "t0" };
  const pendingCandidates = core.commands.localRfqPendingCandidates();
  return {
    clock,
    db,
    approvals,
    confirmations,
    client,
    service,
    core,
    ctx,
    pendingCandidates,
    repo,
    root,
  };
}

/** 标准流程：导入 → 修订条款 → 具名确认 → 刷新事实 → 计价。 */
async function pricedCase(s: { service: MerchantRfqService; ctx: RfqCallContext }) {
  const ingest = await s.service.ingest(s.ctx, {
    kind: "manual_text",
    content: INQUIRY,
    idempotencyKey: "ing-1",
    proposal: {
      entries: [
        { field_path: "lines.quantity", line_id: "L1", value: 10, quote: "10 个" },
        { field_path: "terms.tax_basis", value: "INCLUSIVE", quote: "含税" },
        { field_path: "terms.tax_rate_bps", value: 1300, quote: "13%" },
        { field_path: "terms.shipping_known", value: true, quote: "运费10元" },
        { field_path: "terms.shipping_minor", value: 1000, quote: "运费10元" },
        { field_path: "terms.delivery_date", value: "7天内发货", quote: "7天内发货" },
        { field_path: "terms.payment_terms", value: "款到发货", quote: "款到发货" },
        { field_path: "recipient_ref", value: "张三", quote: "收件人：张三" },
      ],
    },
  });
  const caseId = ingest.case_id;
  const kase = s.service.getCase(s.ctx, caseId);
  const confirmed = s.service.confirmLines(s.ctx, {
    caseId,
    expectedRevision: kase.revision,
    selections: [{ line_id: "L1", sku: "sku-001", quantity: 10, unit: "个" }],
  });
  expect(confirmed.stage).toBe("READY");
  const facts = await s.service.refreshFacts(s.ctx, {
    caseId,
    expectedRevision: confirmed.revision,
    idempotencyKey: "facts-1",
  });
  const quote = await s.service.price(s.ctx, {
    caseId,
    expectedRevision: confirmed.revision,
    snapshotId: facts.snapshot_id,
    idempotencyKey: "price-1",
  });
  return { ingest, caseId, confirmed, facts, quote };
}

it("2-10 refuses legacy async transaction work without starting it or rolling back unrelated prepared writes", async () => {
  const sourceRoot = process.env.A359_BASELINE_SOURCE ?? path.resolve("src");
  const { RfqRepository: Repository } = await import(
    path.join(sourceRoot, "merchant-core/rfq/repository.ts")
  );
  const db = new DatabaseSync(":memory:");
  const repo = new Repository({ db, merchantId: "m", now: () => T0 });
  db.exec("CREATE TABLE scratch(value TEXT)");
  const prepared = db.prepare("INSERT INTO scratch VALUES (?)");
  let called = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  try {
    const attempt = repo.runInTransactionAsync(async () => {
      called++;
      await barrier;
      throw new Error("legacy work started");
    });
    const settled = attempt.then(
      () => undefined,
      (error: unknown) => error,
    );
    prepared.run("unrelated");
    release();
    const error = await settled;
    expect({
      called,
      value: db.prepare("SELECT value FROM scratch").get()?.value,
      inTransaction: db.isTransaction,
    }).toEqual({ called: 0, value: "unrelated", inTransaction: false });
    expect(String(error)).toMatch(/unsupported/);
  } finally {
    release();
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
});
it("2-10 legacy prepare callback is refused before tombstone/artifact/BEGIN and never invoked", async () => {
  const s = setup({ priceUnit: "yuan" });
  const { caseId, quote } = await pricedCase(s);
  let called = 0;
  const beforeFiles = readdirSync(s.root, { recursive: true });
  try {
    await expect(
      s.service.prepareRelease(s.ctx, {
        caseId,
        quoteId: quote.quote_id,
        revision: quote.revision,
        idempotencyKey: "legacy",
        prepareCandidate: async () => {
          called++;
          throw new Error("must not start");
        },
      }),
    ).rejects.toThrow(/legacy callbacks/);
    expect(called).toBe(0);
    expect(readdirSync(s.root, { recursive: true })).toEqual(beforeFiles);
    expect(
      s.db.prepare("SELECT COUNT(*) n FROM rfq_idempotency WHERE idem_key='legacy'").get()?.n,
    ).toBe(0);
    expect(s.repo.listReleasesForQuote(quote.quote_id, quote.revision)).toHaveLength(0);
    expect(s.db.prepare("SELECT COUNT(*) n FROM rfq_artifacts").get()?.n).toBe(0);
    expect(s.db.isTransaction).toBe(false);
  } finally {
    s.db.close();
  }
});
it.each(["manual", "supervised", "autopilot"] as const)(
  "2-10 local registration stays pending in %s and binds uncommitted release preconditions",
  async (mode) => {
    const s = setup({ mode, priceUnit: "yuan" });
    const { caseId, quote } = await pricedCase(s);
    try {
      const r = await s.service.prepareRelease(s.ctx, {
        caseId,
        quoteId: quote.quote_id,
        revision: quote.revision,
        idempotencyKey: "sync",
        pendingCandidates: s.pendingCandidates,
      });
      const candidate = s.approvals.get(r.candidate_id)!;
      expect(candidate.status).toBe("pending_approval");
      expect(candidate.risk).toBe("release_quote");
      expect(candidate.tool).toBe("kiwi_merchant_prepare_quote_release");
      expect(candidate.arguments.release_id).toBe(r.release_id);
      expect(candidate.preconditions).toEqual(
        (
          s.core as unknown as {
            rfqDeps: {
              executors: Array<{
                tool: string;
                readLocalRfqPreconditions: (args: Record<string, unknown>) => unknown;
              }>;
            };
          }
        ).rfqDeps.executors
          .find((e) => e.tool === candidate.tool)!
          .readLocalRfqPreconditions(candidate.arguments),
      );
      expect(s.repo.getRelease(r.release_id)?.candidate_id).toBe(r.candidate_id);
      expect(s.db.isTransaction).toBe(false);
    } finally {
      s.db.close();
    }
  },
);
it("2-10 candidate write then failure rolls back the RFQ unit, while a prepared unrelated microtask write survives", async () => {
  const s = setup({ priceUnit: "yuan" });
  const { caseId, quote } = await pricedCase(s);
  s.db.exec("CREATE TABLE scratch(value TEXT)");
  const prepared = s.db.prepare("INSERT INTO scratch VALUES (?)");
  const create = s.approvals.create.bind(s.approvals);
  s.approvals.create = (input) => {
    const candidate = create(input);
    queueMicrotask(() => prepared.run("unrelated"));
    expect(s.repo.listReleasesForQuote(quote.quote_id, quote.revision)[0]?.candidate_id).toBe("");
    expect(candidate.preconditions).toBeDefined();
    throw new Error("after actual candidate insert");
  };
  try {
    await expect(
      s.service.prepareRelease(s.ctx, {
        caseId,
        quoteId: quote.quote_id,
        revision: quote.revision,
        idempotencyKey: "atomic",
        pendingCandidates: s.pendingCandidates,
      }),
    ).rejects.toThrow(/after actual candidate insert/);
    expect(s.approvals.listPending()).toHaveLength(0);
    expect(s.repo.listReleasesForQuote(quote.quote_id, quote.revision)).toHaveLength(0);
    expect(s.repo.getQuote(quote.quote_id, quote.revision)?.status).toBe("VALIDATED");
    expect(s.db.prepare("SELECT COUNT(*) n FROM rfq_artifacts").get()?.n).toBe(0);
    expect(s.db.prepare("SELECT value FROM scratch").get()?.value).toBe("unrelated");
    expect(s.db.isTransaction).toBe(false);
  } finally {
    s.db.close();
  }
});
it("2-10 actual runtime assembly MCP tool uses the synchronous same-database command port", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "a359-assembly-"));
  dirs.push(root);
  const oldRelease = process.env.KIWI_RFQ_RELEASE,
    oldUnit = process.env.KIWI_RFQ_PRICE_UNIT;
  process.env.KIWI_RFQ_RELEASE = "1";
  process.env.KIWI_RFQ_PRICE_UNIT = "yuan";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-03T15:00:00+08:00"));
  const assembly = await assembleMerchantRuntime({
    profile: testProfile({ merchant_policy: { quote_ttl_seconds: 300 } }),
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    authMode: "oauth",
    log: () => {},
  });
  try {
    const { caseId, quote } = await pricedCase({
      service: assembly.service.rfqService!,
      ctx: { principalId: PRINCIPAL, actor: PRINCIPAL, traceId: "actual-assembly" },
    });
    const result = await assembly.serverOptions.rfq!.tools.call(
      "kiwi_merchant_rfq_prepare_release",
      {
        case_id: caseId,
        quote_ref: { quote_id: quote.quote_id, revision: quote.revision },
        idempotency_key: "real-assembly",
      },
      ["merchant:write"],
    );
    expect(result.isError).not.toBe(true);
    const payload = result.structuredContent as { release_id: string; candidate_id: string };
    expect(payload.candidate_id).toBeTruthy();
    const candidate = assembly.service
      .listPendingCommands()
      .find((c) => c.candidate_id === payload.candidate_id);
    expect(candidate?.arguments.release_id).toBe(payload.release_id);
    expect(candidate?.risk).toBe("release_quote");
  } finally {
    vi.useRealTimers();
    await assembly.close();
    if (oldRelease === undefined) delete process.env.KIWI_RFQ_RELEASE;
    else process.env.KIWI_RFQ_RELEASE = oldRelease;
    if (oldUnit === undefined) delete process.env.KIWI_RFQ_PRICE_UNIT;
    else process.env.KIWI_RFQ_PRICE_UNIT = oldUnit;
  }
});
