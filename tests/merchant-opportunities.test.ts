/**
 * 销售机会/来源/需求（v0.2 §6 / FR05–FR07、AC02/AC03/AC17）。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { OpportunityRepository } from "../src/merchant-core/opportunity/repository.js";
import { OpportunityService } from "../src/merchant-core/opportunity/service.js";
import type { OpportunityEvent, RequirementField } from "../src/merchant-core/opportunity/types.js";

let clock = "2026-10-29T10:00:00.000Z";
const now = () => clock;

let db: DatabaseSync;
let service: OpportunityService;
let repository: OpportunityRepository;

beforeEach(() => {
  clock = "2026-10-29T10:00:00.000Z";
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  repository = new OpportunityRepository({ db, now });
  service = new OpportunityService({ repository, now });
});

afterEach(() => db.close());

function ingestInput(overrides: Record<string, unknown> = {}) {
  return {
    merchant_id: "merchant-1",
    source_namespace: "manual-rfq",
    source_account_id: "account-1",
    external_inquiry_id: "inquiry-1",
    external_event_id: "event-1",
    event_kind: "message",
    raw_excerpt: "500 个纸箱，周五前送到杭州",
    received_at: "2026-10-29T09:00:00.000Z",
    operator: "operator-1",
    parse_version: "v1",
    ...overrides,
  };
}

function field(
  name: string,
  value: string | number | boolean | null,
  status: RequirementField["status"] = "CONFIRMED",
  extra: Partial<RequirementField> = {},
): RequirementField {
  return {
    field: name,
    value,
    status,
    ...(status === "CONFIRMED"
      ? { confirmed_by: "operator-1", confirmed_at: "2026-10-29T09:30:00.000Z" }
      : {}),
    ...extra,
  };
}

function createOpportunity(overrides: Record<string, unknown> = {}) {
  const ingested = service.ingestSource(ingestInput());
  return {
    ...service.createOpportunity({
      merchant_id: "merchant-1",
      source_id: ingested.source.source_id,
      owner: "operator-1",
      operator: "operator-1",
      next_action: "确认纸箱内尺寸与承重",
      required_fields: ["quantity", "region"],
      requirement_fields: [
        field("quantity", 500, "UNCONFIRMED"),
        field("region", "杭州", "UNKNOWN"),
      ],
      basis: "manual entry",
      ...overrides,
    }),
    sourceId: ingested.source.source_id,
  };
}

describe("来源摄取与幂等", () => {
  it("同一外部询盘/事件重复进入不新建来源或事件", () => {
    const first = service.ingestSource(ingestInput());
    const replay = service.ingestSource(ingestInput());
    expect(first.created_source).toBe(true);
    expect(first.created_event).toBe(true);
    expect(replay.created_source).toBe(false);
    expect(replay.created_event).toBe(false);
    expect(replay.source.source_id).toBe(first.source.source_id);
    expect(replay.event.event_id).toBe(first.event.event_id);
  });

  it("同一询盘的后续消息只增加事件，不增加来源记录", () => {
    const first = service.ingestSource(ingestInput());
    const second = service.ingestSource(ingestInput({ external_event_id: "event-2" }));
    expect(second.created_source).toBe(false);
    expect(second.created_event).toBe(true);
    expect(second.source.source_id).toBe(first.source.source_id);
    expect(repository.getSourceEvent(first.source.source_id, "event-2")).toBeDefined();
  });

  it("不同外部询盘生成独立来源记录", () => {
    service.ingestSource(ingestInput());
    const other = service.ingestSource(ingestInput({ external_inquiry_id: "inquiry-2" }));
    expect(other.created_source).toBe(true);
    expect(other.source.source_id).not.toBe(
      service.ingestSource(ingestInput()).source.source_id,
    );
  });
});

describe("机会创建、关联与需求", () => {
  it("关键字段未确认 → 待补充；全部确认后 → 待方案", () => {
    const created = createOpportunity();
    expect(created.opportunity.status).toBe("NEEDS_INFO");
    expect(created.requirement.revision).toBe(1);
    expect(created.link.status).toBe("LINKED");

    const updated = service.recordRequirement({
      merchant_id: "merchant-1",
      opportunity_id: created.opportunity.opportunity_id,
      expected_revision: created.opportunity.revision,
      required_fields: ["quantity", "region"],
      fields: [field("quantity", 500), field("region", "杭州")],
      created_by: "operator-1",
      actor: "operator-1",
    });
    expect(updated.opportunity.status).toBe("READY_FOR_PROPOSAL");
    expect(updated.requirement.revision).toBe(2);
  });

  it("同一来源不能静默关联到第二个机会", () => {
    const created = createOpportunity();
    expect(() =>
      service.createOpportunity({
        merchant_id: "merchant-1",
        source_id: created.sourceId,
        owner: "operator-2",
        operator: "operator-2",
        next_action: "重复机会",
        required_fields: [],
        requirement_fields: [],
        basis: "duplicate",
      }),
    ).toThrowError(expect.objectContaining({ code: "source_conflict" }));
  });

  it("解除错误关联后可重新关联到另一个机会，事件保留审计", () => {
    const first = createOpportunity();
    const ingested = service.ingestSource(ingestInput({ external_inquiry_id: "inquiry-2" }));
    const second = service.createOpportunity({
      merchant_id: "merchant-1",
      source_id: ingested.source.source_id,
      owner: "operator-1",
      operator: "operator-1",
      next_action: "新机会",
      required_fields: [],
      requirement_fields: [],
      basis: "new",
    });

    const unlinked = service.unlinkSource({
      merchant_id: "merchant-1",
      source_id: first.sourceId,
      basis: "重复录入",
      operator: "operator-1",
    });
    expect(unlinked.status).toBe("UNLINKED");

    const relinked = service.linkSource({
      merchant_id: "merchant-1",
      opportunity_id: second.opportunity.opportunity_id,
      source_id: first.sourceId,
      basis: "确认同一采购意图",
      operator: "operator-1",
    });
    expect(relinked.status).toBe("LINKED");
    expect(relinked.opportunity_id).toBe(second.opportunity.opportunity_id);
    expect(relinked.revision).toBeGreaterThan(unlinked.revision);
  });

  it("需求字段：确认状态与确认者分别保存，推测不能伪装成确认", () => {
    expect(() =>
      service.createOpportunity({
        merchant_id: "merchant-1",
        source_id: service.ingestSource(ingestInput()).source.source_id,
        owner: "operator-1",
        operator: "operator-1",
        next_action: "确认",
        required_fields: ["quantity"],
        requirement_fields: [{ field: "quantity", value: 500, status: "CONFIRMED" }],
        basis: "manual",
      }),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
  });
});

describe("机会状态迁移（§6.3）", () => {
  function readyOpportunity() {
    const created = createOpportunity();
    return service.recordRequirement({
      merchant_id: "merchant-1",
      opportunity_id: created.opportunity.opportunity_id,
      expected_revision: created.opportunity.revision,
      required_fields: ["quantity", "region"],
      fields: [field("quantity", 500), field("region", "杭州")],
      created_by: "operator-1",
      actor: "operator-1",
    }).opportunity;
  }

  function advance(
    opportunity: { opportunity_id: string; revision: number },
    event: OpportunityEvent,
    overrides: Record<string, unknown> = {},
  ) {
    return service.advance({
      merchant_id: "merchant-1",
      opportunity_id: opportunity.opportunity_id,
      expected_revision: opportunity.revision,
      event,
      actor: "operator-1",
      ...overrides,
    });
  }

  it("待方案 → 待批准 → 等待客户 → 结果待核实 → 已结束", () => {
    let opportunity = readyOpportunity();
    opportunity = advance(opportunity, { type: "SUBMIT_FOR_APPROVAL" }).opportunity;
    expect(opportunity.status).toBe("PENDING_APPROVAL");

    opportunity = advance(opportunity, { type: "APPROVAL_GRANTED_AND_SENT" }).opportunity;
    expect(opportunity.status).toBe("WAITING_CUSTOMER");

    opportunity = advance(opportunity, { type: "ORDER_CLAIMED" }).opportunity;
    expect(opportunity.status).toBe("RESULT_UNVERIFIED");

    opportunity = advance(opportunity, {
      type: "ORDER_VERIFIED",
      has_open_sales_todo: false,
    }).opportunity;
    expect(opportunity.status).toBe("CLOSED");
  });

  it("审批退回按缺项回到待补充或待方案", () => {
    let opportunity = readyOpportunity();
    opportunity = advance(opportunity, { type: "SUBMIT_FOR_APPROVAL" }).opportunity;
    const rejected = advance(opportunity, { type: "APPROVAL_REJECTED", needs_info: true });
    expect(rejected.opportunity.status).toBe("NEEDS_INFO");
  });

  it("非法迁移被拒绝（待补充不能直接提交批准）", () => {
    const created = createOpportunity();
    expect(() =>
      advance(created.opportunity, { type: "SUBMIT_FOR_APPROVAL" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("已结束保持终态：迟到回复只追加证据，不复活任务", () => {
    let opportunity = readyOpportunity();
    opportunity = advance(opportunity, {
      type: "CLOSE",
      reason: "客户取消",
    }).opportunity;
    expect(opportunity.status).toBe("CLOSED");

    const late = advance(opportunity, {
      type: "CUSTOMER_REPLIED",
      needs_info: false,
      needs_new_proposal: true,
    });
    expect(late.opportunity.status).toBe("CLOSED");
    expect(late.transition.side_effects).toContain("append_evidence_only");
  });

  it("旧 revision 提交被拒绝", () => {
    const opportunity = readyOpportunity();
    expect(() =>
      service.advance({
        merchant_id: "merchant-1",
        opportunity_id: opportunity.opportunity_id,
        expected_revision: opportunity.revision - 1,
        event: { type: "SUBMIT_FOR_APPROVAL" },
        actor: "operator-1",
      }),
    ).toThrowError(expect.objectContaining({ code: "version_conflict" }));
  });

  it("幂等键：同内容重放返回原结果，异内容冲突", () => {
    const opportunity = readyOpportunity();
    const event: OpportunityEvent = { type: "SUBMIT_FOR_APPROVAL" };
    const first = service.advance(
      {
        merchant_id: "merchant-1",
        opportunity_id: opportunity.opportunity_id,
        expected_revision: opportunity.revision,
        event,
        actor: "operator-1",
      },
      { idempotency_key: "advance-1" },
    );
    const replay = service.advance(
      {
        merchant_id: "merchant-1",
        opportunity_id: opportunity.opportunity_id,
        expected_revision: opportunity.revision,
        event,
        actor: "operator-1",
      },
      { idempotency_key: "advance-1" },
    );
    expect(replay.opportunity.revision).toBe(first.opportunity.revision);
    expect(() =>
      service.advance(
        {
          merchant_id: "merchant-1",
          opportunity_id: opportunity.opportunity_id,
          expected_revision: opportunity.revision,
          event: { type: "CLOSE", reason: "x" },
          actor: "operator-1",
        },
        { idempotency_key: "advance-1" },
      ),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });

  it("租户隔离：其他商家读不到机会", () => {
    const created = createOpportunity();
    expect(service.getOpportunity("merchant-2", created.opportunity.opportunity_id)).toBeUndefined();
    expect(() =>
      service.advance({
        merchant_id: "merchant-2",
        opportunity_id: created.opportunity.opportunity_id,
        expected_revision: created.opportunity.revision,
        event: { type: "CLOSE", reason: "x" },
        actor: "operator-2",
      }),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));
  });
});
