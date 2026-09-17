/**
 * V2 阶段四验收测试：
 * - CSV 导入闭环：解析预览逐行回执、部分成功 partially_failed、相同幂等键
 *   不重复导入、撤回逐项回执；
 * - operation 状态机（queued→running→succeeded/partially_failed/failed）与
 *   kiwi_merchant_get_operation 查询；
 * - F25 注册检查（可达/失效可检测，fail-closed）与 F03 域名向导检查单；
 * - F29 微信绑定状态（脱敏、不可得明确）；
 * - 告警事件（进程/商品源/积压/磁盘/证书）与备份恢复演练（RPO ≤ 备份周期
 *   口径：磋商 ledger 在备份集内，损坏→恢复→校验；不宣称 RPO=0）；
 * - 旧入口一致性：core 直读与 MCP 工具返回同一业务事实。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../../src/agent/merchant/fake-merchant-client.js";
import type { MerchantClient } from "../../src/agent/merchant/types.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import { MerchantOperationStore } from "../../src/merchant-core/operations.js";
import {
  buildDomainOnboardingChecklist,
  checkNetworkRegistration,
} from "../../src/merchant-core/network-checks.js";
import { buildMerchantMcpTools } from "../../src/mcp/merchant-tools.js";
import {
  saveCredentials,
  saveSyncState,
  credentialsPathFor,
  syncStatePathFor,
} from "../../src/weixin/credentials.js";
import { runBackup, restoreBackup } from "../../src/merchant-runtime/backup.js";
import { collectMerchantHealth } from "../../src/merchant-runtime/health.js";
import { testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "kiwi-stage4-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function setupCore(client?: MerchantClient, dataDir?: string) {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client ?? new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals: store,
    mode: () => "supervised",
    now: () => T0,
    commandPrincipalId: PRINCIPAL,
    operations: new MerchantOperationStore({ db, now: () => T0 }),
    ...(dataDir !== undefined ? { merchantDataDir: dataDir } : {}),
  });
  return { core, store, db };
}

const CSV_OK = "sku,title,price,stock\nsku-001,手写陶瓷杯,88,10\nsku-002,机制陶瓷杯,59,20\n";

describe("F04：CSV 导入闭环", () => {
  it("解析预览逐行回执（新增/更新/错误行）", async () => {
    const { core, db } = setupCore();
    const prepared = await core.prepareProductsImport({
      csv: "sku,title,price,stock\nsku-001,改名杯子,77,5\nbad-row\nsku-003,新杯子,10,3\n",
      idempotency_key: "imp-1",
    });
    const preview = prepared.preview.import_preview as {
      creates: number;
      updates: number;
      row_errors: Array<{ line: number }>;
    };
    expect(preview.updates).toBe(1); // sku-001 已存在
    expect(preview.creates).toBe(1); // sku-003 新增
    expect(preview.row_errors).toHaveLength(1); // bad-row
    db.close();
  });

  it("执行：逐行回执 + 部分成功 partially_failed；幂等键重放不重复导入", async () => {
    const { core, db } = setupCore();
    const prepared = await core.prepareProductsImport({
      csv: CSV_OK + "sku-004,坏行,abc,1\n",
      idempotency_key: "imp-2",
    });
    const outcome = await core.executeApproved(prepared.candidate.candidate_id);
    expect(outcome.kind).toBe("executed");
    const op = (outcome as { output?: { operation_id?: string; status?: string } }).output;
    expect(op?.status).toBe("partially_failed");
    const operationId = op?.operation_id ?? "";
    expect(operationId).not.toBe("");

    // operation 查询工具路径（read scope）
    const fetched = core.getOperation(operationId);
    expect(fetched.status).toBe("partially_failed");
    expect(fetched.receipts.some((r) => !r.ok && r.item === "line 4")).toBe(true);
    expect(fetched.receipts.filter((r) => r.ok)).toHaveLength(2);

    // 幂等键与内容摘要绑定（审查 P1）：同 key 不同内容 → 新 operation（不再
    // 静默返回旧 operation 谎报成功）；同 key 同内容 → 真重放，同一 operation。
    const prepared2 = await core.prepareProductsImport({ csv: CSV_OK, idempotency_key: "imp-2" });
    const outcome2 = await core.executeApproved(prepared2.candidate.candidate_id);
    const op2 = (outcome2 as { output?: { operation_id?: string } }).output;
    expect(op2?.operation_id).not.toBe(operationId);

    const prepared3 = await core.prepareProductsImport({
      csv: CSV_OK + "sku-004,坏行,abc,1\n",
      idempotency_key: "imp-2",
    });
    const outcome3 = await core.executeApproved(prepared3.candidate.candidate_id);
    const op3 = (outcome3 as { output?: { operation_id?: string } }).output;
    expect(op3?.operation_id).toBe(operationId);
    db.close();
  });

  it("撤回逐项回执（上游不支持时逐项明确失败；全部失败 → 候选 superseded 不谎报已执行）", async () => {
    const refusing = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
    refusing.pauseListing = async () => {
      throw new Error("shopping-cli 2.x 不提供 listing pause 端点");
    };
    const { core, db } = setupCore(refusing);
    const prepared = await core.prepareProductsWithdraw({
      skus: ["sku-001"],
      idempotency_key: "wd-1",
    });
    const outcome = await core.executeApproved(prepared.candidate.candidate_id);
    // 审查 P1：operation 终态 failed → 输出 ok:false → 候选标 superseded
    //（审计不再把「全部失败」记成已执行），提示重新生成候选。
    expect(outcome.kind).toBe("stale");
    expect(outcome.kind === "stale" && outcome.reason).toContain("执行失败");
    db.close();
  });
});

describe("operation 状态机", () => {
  it("queued→running→succeeded；异常 → failed", () => {
    const db = new DatabaseSync(":memory:");
    const ops = new MerchantOperationStore({ db, now: () => T0 });
    const { operation, created } = ops.createOrGet({ kind: "k", idempotencyKey: "i1" });
    expect(created).toBe(true);
    expect(operation.status).toBe("queued");
    expect(ops.createOrGet({ kind: "k", idempotencyKey: "i1" }).created).toBe(false);
    ops.markRunning(operation.operation_id);
    expect(ops.get(operation.operation_id)?.status).toBe("running");
    expect(ops.finish(operation.operation_id, [{ item: "a", ok: true }]).status).toBe("succeeded");
    expect(ops.finish(operation.operation_id, [], "boom").status).toBe("failed");
    db.close();
  });
});

describe("F25/F03：注册检查与域名向导", () => {
  it("F25：可达+有效注册 → ok；catalog 不可达/注册失效 → 结构化错误", async () => {
    const okFetch = async (url: unknown) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/health")
            ? { ok: true }
            : { agent: { agent_card_url: "https://a2a.merchant.example.com/card" } },
        ),
        { status: 200 },
      );
    const good = await checkNetworkRegistration({
      catalogBaseUrl: "https://catalog.example.com",
      agentId: "merchant-001",
      fetchImpl: okFetch as typeof fetch,
      now: () => T0,
    });
    expect(good.ok).toBe(true);
    expect(good.registration.registered).toBe(true);

    const down = await checkNetworkRegistration({
      catalogBaseUrl: "https://catalog.example.com",
      agentId: "merchant-001",
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
      now: () => T0,
    });
    expect(down.ok).toBe(false);
    expect(down.catalog.reachable).toBe(false);
    expect(down.registration.registered).toBe(false);
  });

  it("F03：检查单含公开投影分离 + DNS/TLS 人工项；私密键泄露报 pending", () => {
    const clean = buildDomainOnboardingChecklist(testProfile());
    expect(clean.items.some((i) => i.id === "dns" && i.status === "manual")).toBe(true);
    expect(clean.items.some((i) => i.id === "tls" && i.status === "manual")).toBe(true);
    expect(clean.items.find((i) => i.id === "public-projection-separation")?.status).toBe("ok");
    const leaky = buildDomainOnboardingChecklist(
      testProfile({ merchant_public: { public_url: "shop.example.com", merchant_token_env: "X" } }),
    );
    expect(leaky.items.find((i) => i.id === "public-projection-separation")?.status).toBe(
      "pending",
    ); // merchant_token_env 命中私密键模式
    expect(leaky.items.find((i) => i.id === "public-url")?.status).toBe("ok");
  });
});

describe("F29：微信绑定状态（只读、脱敏、不可得明确）", () => {
  it("未配置 merchantDataDir → 不可得；未绑定 → bound:false；已绑定 → 脱敏状态", () => {
    const noDir = setupCore();
    expect(() => noDir.core.getWeixinStatus()).toThrow(/不可得/);
    noDir.db.close();

    const dir = tmp();
    const unbound = setupCore(undefined, dir);
    expect(unbound.core.getWeixinStatus().bound).toBe(false);
    expect(unbound.core.getWeixinStatus().recent_events).toContain("不可得");
    unbound.db.close();

    saveCredentials(credentialsPathFor(dir), {
      ilink_bot_id: "bot-1",
      bot_token: "SECRET-TOKEN",
      base_url: "https://ilink.example.com",
      ilink_user_id: "user-1",
      saved_at: T0,
    });
    saveSyncState(syncStatePathFor(dir), { get_updates_buf: "buf", seen: ["a", "b"] });
    const bound = setupCore(undefined, dir);
    const status = bound.core.getWeixinStatus();
    expect(status.bound).toBe(true);
    expect(status.account?.bot_id).toBe("bot-1");
    expect(status.sync).toEqual({ buffered: true, seen_count: 2 });
    expect(JSON.stringify(status)).not.toContain("SECRET-TOKEN"); // 脱敏
    bound.db.close();
  });
});

describe("7×24：告警与备份恢复演练", () => {
  it("告警：进程未运行/商品源不可用/积压/磁盘/证书临期（备份新鲜，不产生 backup_stale）", () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, "capability-probe.json"),
      JSON.stringify({ ok: false, error: "down" }),
    );
    mkdirSync(path.join(dir, "backups"), { recursive: true });
    writeFileSync(
      path.join(dir, "backups", "latest-backup.json"),
      JSON.stringify({ created_at: T0 }),
    );
    const report = collectMerchantHealth({
      dataDir: dir,
      services: [{ name: "a2a", running: false, restarts: 0, stopped: true }],
      now: () => T0,
      pendingCommands: 60,
      registration: { ok: false, error: "HTTP 404" },
      certDaysLeft: 7,
      minFreeBytes: 0,
    });
    const codes = report.alerts.map((a) => a.code).sort();
    expect(codes).toEqual(
      [
        "backlog",
        "cert_expiring",
        "process_down",
        "product_source_unavailable",
        "registration_invalid",
      ].sort(),
    );
    expect(report.alerts.find((a) => a.code === "process_down")?.severity).toBe("critical");
  });

  it("备份恢复演练：备份 → 损坏 → 恢复 → 校验（磋商 ledger 在备份集内）", () => {
    const dataDir = tmp();
    const backupsDir = path.join(tmp(), "backups");
    mkdirSync(path.join(dataDir, "a2a", "ledger"), { recursive: true });
    // BUG-06：state.sqlite 用真实 SQLite（VACUUM INTO 一致性快照）
    const stateDb = new DatabaseSync(path.join(dataDir, "state.sqlite"));
    stateDb.exec("CREATE TABLE t (id INTEGER)");
    stateDb.exec("INSERT INTO t VALUES (1),(2),(3)");
    stateDb.close();
    writeFileSync(path.join(dataDir, "a2a", "ledger", "neg_1.jsonl"), '{"event":1}\n');

    const backup = runBackup({ dataDir, backupsDir, now: () => T0, keepLatest: 2 });
    expect(backup.manifest.files.map((f) => f.path).sort()).toEqual(
      ["a2a/ledger/neg_1.jsonl", "state.sqlite"].sort(),
    );

    // 损坏目标 → 恢复 → 校验
    const target = tmp();
    writeFileSync(path.join(target, "state.sqlite"), "corrupted");
    const restored = restoreBackup({ snapshotDir: backup.snapshot_dir, targetDir: target });
    expect(restored.verified).toBe(true);
    const restoredDb = new DatabaseSync(path.join(target, "state.sqlite"));
    expect(
      (restoredDb.prepare("SELECT count(*) c FROM t").get() as { c: number }).c,
    ).toBe(3); // 业务对账：行数一致
    restoredDb.close();
    expect(readFileSync(path.join(target, "a2a", "ledger", "neg_1.jsonl"), "utf8")).toContain(
      "event",
    );

    // 损坏的快照拒绝恢复
    writeFileSync(path.join(backup.snapshot_dir, "state.sqlite"), "tampered");
    expect(() => restoreBackup({ snapshotDir: backup.snapshot_dir, targetDir: tmp() })).toThrow(
      /摘要/,
    );

    // 轮换：keepLatest=2，第三份推走第一份
    runBackup({ dataDir, backupsDir, now: () => "2026-09-15T10:01:00.000Z", keepLatest: 2 });
    const third = runBackup({
      dataDir,
      backupsDir,
      now: () => "2026-09-15T10:02:00.000Z",
      keepLatest: 2,
    });
    expect(third.rotated_out).toHaveLength(1);
  });
});

describe("旧入口一致性（CLI/TUI/MCP 同一业务事实）", () => {
  it("core 直读与 MCP 工具返回同一目录数据", async () => {
    const { core, db } = setupCore();
    const direct = await core.listPublicProducts();
    const tools = buildMerchantMcpTools(core);
    const viaMcp = await tools.call("kiwi_merchant_list_products", {});
    expect(viaMcp.structuredContent).toMatchObject({
      count: direct.items.length,
      items: direct.items,
    });
    db.close();
  });
});

describe("BUG-06：并发写入期间的事务一致备份", () => {
  it("持续写入 + 多轮备份 → 恢复后 integrity_check 通过 + 业务对账（行数单调）", () => {
    const dataDir = tmp();
    const backupsDir = path.join(tmp(), "backups");
    const dbPath = path.join(dataDir, "state.sqlite");
    const writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, body TEXT)");

    let round = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      writer.exec(`INSERT INTO events (body) VALUES ('event-${tick}')`);
      if (tick % 50 === 0) {
        round += 1;
        // 写入进行中执行备份（VACUUM INTO 一致性快照）
        runBackup({
          dataDir,
          backupsDir,
          now: () => `2026-09-15T10:0${round}:00.000Z`,
        });
      }
    }
    writer.close();

    // 每轮快照：恢复 → integrity_check + 行数对账（≥ 快照时点数，单调不减）
    const stamp = (t: string) => t.replace(/[:.]/g, "-"); // 与 runBackup 同名规则
    const snapshots = (round: number) =>
      path.join(backupsDir, stamp(`2026-09-15T10:0${round}:00.000Z`));
    let prevCount = 0;
    for (let r = 1; r <= round; r += 1) {
      const target = tmp();
      const restored = restoreBackup({ snapshotDir: snapshots(r), targetDir: target });
      expect(restored.verified).toBe(true);
      const db = new DatabaseSync(path.join(target, "state.sqlite"));
      const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check: string;
      }>;
      expect(integrity[0]?.integrity_check).toBe("ok");
      const count = (db.prepare("SELECT count(*) c FROM events").get() as { c: number }).c;
      expect(count).toBeGreaterThanOrEqual(prevCount); // 单调（快照时点递增）
      expect(count).toBeGreaterThanOrEqual(1);
      prevCount = count;
      db.close();
    }
    // 最后一轮快照应接近全量（tick 150 时备份 → 151 行；容许边界）
    expect(prevCount).toBeGreaterThanOrEqual(150);
  });
});
