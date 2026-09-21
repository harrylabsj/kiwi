/**
 * BD-01/BD-02：共用商家应用服务与已验证主体（BD 设计 §7/§8/§9/§10）。
 *
 * 逐条对上验收用例：
 *   UC09 A 会话访问 B 对象   —— 统一 404，不透露对方存在；
 *   UC10 伪造 merchant_id    —— **手写主体一律拒**（运行时不认）；
 *   UC12 未登录/viewer 写操作 —— 403，且业务无变化；
 *   UC15 伪造人工同意        —— approved=true / 无确认引用不能执行；
 *   UC16 规则或商品变更后批准 —— 摘要不符即 precondition_changed(409)，旧确认失效。
 */
import { describe, expect, it } from "vitest";

import {
  MERCHANT_ROLES,
  ActorContextError,
  assertVerifiedActor,
  createVerifiedActorContext,
  hasPermission,
  permissionsForRole,
  type MerchantRole,
} from "../src/merchant/application/actor.js";
import {
  MANAGEMENT_ERROR_STATUS,
  ManagementError,
  MerchantApplicationService,
  type MerchantApplicationDeps,
  type OperationReceipt,
} from "../src/merchant/application/service.js";
import type { WriteApprovalCandidate } from "../src/agent/merchant/action-candidate.js";

const NOW = new Date("2026-09-21T10:00:00Z");
const EXPIRES = "2026-09-21T22:00:00Z";
const MERCHANT = "merchant-001";

function actor(role: MerchantRole, overrides: Record<string, unknown> = {}) {
  return createVerifiedActorContext({
    actorId: `admin:${MERCHANT}`,
    merchantId: MERCHANT,
    role,
    authMethod: "merchant-session",
    generation: 1,
    requestId: "req-1",
    expiresAt: EXPIRES,
    ...overrides,
  });
}

function candidate(overrides: Partial<WriteApprovalCandidate> = {}): WriteApprovalCandidate {
  return {
    candidate_id: "act_1",
    principal_id: `merchant-agent:${MERCHANT}`,
    tool: "publish_listing",
    arguments: { sku: "SKU-1" },
    arguments_hash: "sha256:args",
    preconditions: { policy_revision: 7 },
    preconditions_hash: "sha256:pre",
    risk: "medium",
    status: "pending_approval",
    expires_at: "2026-09-21T12:00:00Z",
    created_at: "2026-09-21T09:00:00Z",
    updated_at: "2026-09-21T09:00:00Z",
    ...overrides,
  };
}

function service(overrides: Partial<MerchantApplicationDeps> = {}) {
  const decided: unknown[] = [];
  const deps: MerchantApplicationDeps = {
    merchantId: MERCHANT,
    generation: () => 1,
    runtimeVersion: "0.10.0",
    readiness: async () => ({ ready: true, checks: { storage: { ok: true } } }),
    serviceState: () => "OPERATING",
    capabilities: () => ({ management_page: true, dialog_tools: false }),
    listCandidates: () => [candidate()],
    getCandidate: (id) => (id === "act_1" ? candidate() : undefined),
    decide: async (input) => {
      decided.push(input);
      return { operationId: "op_1", status: "succeeded", resultRevision: 8 };
    },
    getOperation: (id): OperationReceipt | undefined =>
      id === "op_1"
        ? {
            operation_id: "op_1",
            command_type: "approval.approve",
            status: "succeeded",
            resource_ref: "act_1",
            result_revision: 8,
            created_at: NOW.toISOString(),
            completed_at: NOW.toISOString(),
            support_id: "sup_1",
          }
        : undefined,
    now: () => NOW,
    ...overrides,
  };
  return { service: new MerchantApplicationService(deps), decided };
}

const VALID_DECISION = {
  expected_revision: 1,
  arguments_hash: "sha256:args",
  preconditions_hash: "sha256:pre",
  confirmation_ref: "confirm_1",
};

describe("UC10：主体只能由认证层构造", () => {
  it("手写对象（哪怕字段齐全）在运行时被拒——请求里的 merchant_id 不能当主体", () => {
    const forged = {
      actorId: "admin:merchant-001",
      merchantId: "merchant-001",
      role: "owner",
      permissions: permissionsForRole("owner"),
      expiresAt: EXPIRES,
      authMethod: "merchant-session",
      generation: 1,
      requestId: "forged",
    };
    expect(() => assertVerifiedActor(forged, NOW)).toThrow(ActorContextError);
    expect(() => assertVerifiedActor({ merchant_id: MERCHANT }, NOW)).toThrow(/authentication layer/);
  });

  it("服务方法对伪造主体同样拒绝（不是只在类型层面）", async () => {
    const { service: svc } = service();
    const forged = { merchantId: MERCHANT, role: "owner", permissions: new Set() } as never;
    await expect(svc.getStatus(forged)).rejects.toThrow(ActorContextError);
  });

  it("过期主体被拒（不复用缓存许可）", () => {
    const expired = actor("owner", { expiresAt: "2026-09-21T09:00:00Z" });
    expect(() => assertVerifiedActor(expired, NOW)).toThrow(/expired/);
  });
});

describe("§7.2：角色与权限", () => {
  it("三个角色都存在，且权限逐级包含", () => {
    expect([...MERCHANT_ROLES]).toEqual(["owner", "operator", "viewer"]);
    const viewer = permissionsForRole("viewer");
    const operator = permissionsForRole("operator");
    const owner = permissionsForRole("owner");
    for (const permission of viewer) expect(operator.has(permission)).toBe(true);
    for (const permission of operator) expect(owner.has(permission)).toBe(true);
  });

  it("恢复接待 / 删资源 / 敏感策略**只给 owner**（§7.2）", () => {
    for (const permission of ["service:resume", "resources:delete", "policy:read_sensitive"] as const) {
      expect(hasPermission(actor("owner"), permission)).toBe(true);
      expect(hasPermission(actor("operator"), permission)).toBe(false);
      expect(hasPermission(actor("viewer"), permission)).toBe(false);
    }
  });

  it("暂停是安全动作：operator 就能做（越晚停损失越大）", () => {
    expect(hasPermission(actor("operator"), "service:pause")).toBe(true);
  });
});

describe("UC12：viewer 只能读，写操作 403 且业务无变化", () => {
  it("viewer 读得到状态与待审批", async () => {
    const { service: svc } = service();
    const status = await svc.getStatus(actor("viewer"));
    expect(status.service_state).toBe("OPERATING");
    expect(status.capabilities).toEqual({ management_page: true, dialog_tools: false });
    expect((await svc.listApprovals(actor("viewer"))).items).toHaveLength(1);
  });

  it("viewer 审批被 403，且 decide 从未被调用", async () => {
    const { service: svc, decided } = service();
    await expect(
      svc.decideApproval(actor("viewer"), "act_1", VALID_DECISION, {
        approve: true,
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/missing permission/);
    expect(decided).toEqual([]);
  });
});

describe("UC09：跨商家对象统一 404", () => {
  it("别的商家的会话读不到本实例的对象（不透露存在性）", async () => {
    const { service: svc } = service();
    const other = actor("owner", { merchantId: "merchant-999", actorId: "admin:merchant-999" });
    await expect(svc.getApproval(other, "act_1")).rejects.toThrow(/does not belong to this merchant/);
    await expect(svc.getStatus(other)).rejects.toThrow(/does not belong to this merchant/);
    const error = await svc.listApprovals(other).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).code).toBe("not_found");
    // 404 而不是 403：不区分"不存在"与"不归你"，避免枚举
    expect(MANAGEMENT_ERROR_STATUS.not_found).toBe(404);
  });
});

describe("UC15/UC16：确认为真、前置条件要重验", () => {
  it("没有确认引用 → 403，绝不执行（approved=true 不是批准证据）", async () => {
    const { service: svc, decided } = service();
    await expect(
      svc.decideApproval(actor("owner"), "act_1", { ...VALID_DECISION, confirmation_ref: "" }, {
        approve: true,
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/confirmation reference is required/);
    expect(decided).toEqual([]);
  });

  it("参数摘要变了 → precondition_changed(409)，旧确认不能继续用（UC16）", async () => {
    const { service: svc, decided } = service();
    await expect(
      svc.decideApproval(actor("owner"), "act_1", { ...VALID_DECISION, arguments_hash: "sha256:other" }, {
        approve: true,
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/arguments changed/);
    expect(decided).toEqual([]);
  });

  it("前置状态摘要变了 → 同样 409", async () => {
    const { service: svc } = service();
    const error = await svc
      .decideApproval(actor("owner"), "act_1", { ...VALID_DECISION, preconditions_hash: "sha256:x" }, {
        approve: true,
        idempotencyKey: "k1",
      })
      .catch((err: unknown) => err);
    expect((error as ManagementError).code).toBe("precondition_changed");
    expect(MANAGEMENT_ERROR_STATUS.precondition_changed).toBe(409);
  });

  it("候选已过期 → 拒；已被处理过 → conflict", async () => {
    const expired = service({
      getCandidate: () => candidate({ expires_at: "2026-09-21T09:30:00Z" }),
    });
    await expect(
      expired.service.decideApproval(actor("owner"), "act_1", VALID_DECISION, {
        approve: true,
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/expired/);

    const already = service({ getCandidate: () => candidate({ status: "executed" }) });
    await expect(
      already.service.decideApproval(actor("owner"), "act_1", VALID_DECISION, {
        approve: true,
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/not awaiting approval/);
  });

  it("齐备时执行，并返回带 support_id 的持久操作回执", async () => {
    const { service: svc, decided } = service();
    const receipt = await svc.decideApproval(actor("owner"), "act_1", VALID_DECISION, {
      approve: true,
      idempotencyKey: "k1",
    });
    expect(receipt.status).toBe("succeeded");
    expect(receipt.command_type).toBe("approval.approve");
    expect(receipt.completed_at).not.toBeNull();
    expect(receipt.support_id).toMatch(/^sup_/);
    expect(decided).toHaveLength(1);
    // 主体身份来自认证上下文，不来自请求参数
    expect(decided[0]).toMatchObject({ actorId: `admin:${MERCHANT}`, merchantId: MERCHANT });
  });
});

describe("§9.2/§11.1：只读端点的投影与分页", () => {
  it("待审批投影**不含参数原文**（只给摘要与哈希）", async () => {
    const { service: svc } = service();
    const page = await svc.listApprovals(actor("operator"));
    const item = page.items[0];
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "arguments_hash",
      "candidate_id",
      "expires_at",
      "preconditions_hash",
      "related_revision",
      "status",
      "summary",
    ]);
    expect(JSON.stringify(page)).not.toContain("SKU-1");
  });

  it("分页游标：越界游标 → invalid_input；limit 有上限", async () => {
    const many = service({
      listCandidates: () => Array.from({ length: 5 }, (_, i) => candidate({ candidate_id: `act_${i}` })),
    });
    const first = await many.service.listApprovals(actor("viewer"), { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBe("2");
    const second = await many.service.listApprovals(actor("viewer"), { cursor: "2", limit: 2 });
    expect(second.items.map((i) => i.candidate_id)).toEqual(["act_2", "act_3"]);

    await expect(
      many.service.listApprovals(actor("viewer"), { cursor: "not-a-number" }),
    ).rejects.toThrow(/invalid cursor/);
  });

  it("操作回执：查得到就返回，查不到 404（unknown 不等于失败重做）", () => {
    const { service: svc } = service();
    expect(svc.getOperation(actor("viewer"), "op_1").status).toBe("succeeded");
    expect(() => svc.getOperation(actor("viewer"), "op_missing")).toThrow(/unknown operation/);
  });
});

describe("§11.3：错误码与 HTTP 映射", () => {
  it("错误码表与设计一致", () => {
    expect(MANAGEMENT_ERROR_STATUS).toMatchObject({
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      precondition_changed: 409,
      invalid_input: 400,
      rate_limited: 429,
      unavailable: 503,
      tool_binding_unavailable: 503,
      update_required: 409,
    });
  });

  it("可重试性有明确判断（只读可退避；写只能原键查询）", () => {
    expect(new ManagementError("rate_limited", "slow down").retryable).toBe(true);
    expect(new ManagementError("unavailable", "down").retryable).toBe(true);
    expect(new ManagementError("forbidden", "no").retryable).toBe(false);
    expect(new ManagementError("precondition_changed", "moved").retryable).toBe(false);
  });
});
