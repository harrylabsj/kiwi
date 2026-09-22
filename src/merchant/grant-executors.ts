/** Owner-only, WebAuthn-committed scoped grant mutation executors. */

import { contentHash } from "../agent/merchant/action-candidate.js";
import type { CommandExecutor } from "../merchant-core/executor.js";
import { createVerifiedActorContext } from "./application/actor.js";
import {
  GRANT_ACTIONS,
  GRANT_OPERATION_KINDS,
  type GrantAction,
  type GrantOperation,
  type GrantOperationKind,
  type GrantResourceType,
  type MerchantGrantStore,
} from "./grant-store.js";

export const GRANT_TOOLS = {
  create: "kiwi_workbench_grant_create",
  revoke: "kiwi_workbench_grant_revoke",
} as const;

export function createGrantExecutors(options: {
  merchantId: string;
  getStore: () => MerchantGrantStore | undefined;
}): CommandExecutor[] {
  const store = (): MerchantGrantStore => {
    const value = options.getStore();
    if (value === undefined) throw new Error("Merchant grant authority is not configured");
    return value;
  };
  /**
   * 构造本次操作的回执标识。`requestHash` 覆盖**语义输入**（不是读取时的原始 JSON）：
   * 同 operation_id 换了请求内容必须冲突，而字段顺序/无关字段不得造成假冲突。
   */
  const operationFor = (
    operationKind: GrantOperationKind,
    args: Readonly<Record<string, unknown>>,
    decision: { kind: "committed"; operationId: string; actorId: string } | undefined,
  ): GrantOperation => ({
    operationId: requireCommitted(decision).operationId,
    operationKind,
    requestHash: contentHash({
      operation_kind: operationKind,
      merchant_id: options.merchantId,
      subject_id: args.subject_id ?? null,
      grant_action: args.grant_action ?? null,
      resource_type: args.resource_type ?? null,
      resource_selector: args.resource_selector ?? null,
      expires_at: args.expires_at ?? null,
      grant_id: args.grant_id ?? null,
    }),
  });

  /**
   * 对账适配器：写后不确定时按 operation_id 查**我们自己的**回执。
   *
   * 授权写是 kiwi 内部写，没有下游服务可问——回执落在 grant store 自己的表里，
   * 且与效果**同事务**。没有这个适配器时 `MerchantCommandLog.reconcile` 会返回
   * unknown +「no downstream operation query adapter」，把一次可自动判定的对账
   * 变成人工升级。
   */
  const queryOutcome =
    (operationKind: GrantOperationKind) =>
    async (
      args: Record<string, unknown>,
      _ctx: unknown,
      decision: { operationId: string },
    ): Promise<{ status: "succeeded" } | { status: "unknown"; error: string }> => {
      const receipt = store().getOperation(options.merchantId, decision.operationId);
      if (receipt === undefined || receipt.operation_kind !== operationKind) {
        return { status: "unknown", error: "grant receipt does not match" };
      }
      // create 的 grant_id 由服务端生成，args 里没有，只能按 kind 核对；
      // revoke 必须核对回执对着的是同一个 grant。
      if (
        operationKind === GRANT_OPERATION_KINDS.revoke &&
        receipt.grant_id !== String(args["grant_id"] ?? "")
      ) {
        return { status: "unknown", error: "grant receipt does not match" };
      }
      return { status: "succeeded" };
    };
  return [
    {
      tool: GRANT_TOOLS.create,
      risk: "authorization_change",
      requiresCommittedDecision: true,
      readPreconditions: async (args) => ({
        subject_id: requireText(args["subject_id"], "subject_id"),
        authorization_generation: store().authorizationGeneration(
          options.merchantId,
          requireText(args["subject_id"], "subject_id"),
        ),
      }),
      execute: async (args, _context, decision) =>
        store().createGrant(
          ownerContext(options.merchantId, args),
          {
            subjectId: requireText(args["subject_id"], "subject_id"),
            action: requireAction(args["grant_action"]),
            resourceType: requireResourceType(args["resource_type"]),
            resourceSelector: requireSelector(args["resource_selector"]),
            expiresAt: requireText(args["expires_at"], "expires_at"),
          },
          operationFor(GRANT_OPERATION_KINDS.create, args, decision),
        ),
      queryOutcome: queryOutcome(GRANT_OPERATION_KINDS.create),
    },
    {
      tool: GRANT_TOOLS.revoke,
      risk: "authorization_change",
      requiresCommittedDecision: true,
      readPreconditions: async (args) => {
        const grant = store().getGrant(
          options.merchantId,
          requireText(args["grant_id"], "grant_id"),
        );
        return grant === undefined
          ? { missing: true }
          : {
              grant_id: grant.grant_id,
              subject_id: grant.subject_id,
              grant_version: grant.grant_version,
              revoked_at: grant.revoked_at,
              authorization_generation: store().authorizationGeneration(
                options.merchantId,
                grant.subject_id,
              ),
            };
      },
      execute: async (args, _context, decision) =>
        store().revokeGrant(
          ownerContext(options.merchantId, args),
          requireText(args["grant_id"], "grant_id"),
          operationFor(GRANT_OPERATION_KINDS.revoke, args, decision),
        ),
      queryOutcome: queryOutcome(GRANT_OPERATION_KINDS.revoke),
    },
  ];
}

function requireCommitted(
  value: { kind: "committed"; operationId: string; actorId: string } | undefined,
): { operationId: string; actorId: string } {
  if (value?.kind !== "committed") {
    throw new Error("grant execution requires a committed decision");
  }
  return value;
}

function ownerContext(merchantId: string, args: Readonly<Record<string, unknown>>) {
  const actorId = requireText(args["owner_actor_id"], "owner_actor_id");
  return createVerifiedActorContext({
    actorId,
    merchantId,
    role: "owner",
    authMethod: "service-identity",
    generation: 1,
    requestId: `grant-executor:${actorId}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requireAction(value: unknown): GrantAction {
  if (typeof value !== "string" || !GRANT_ACTIONS.includes(value as GrantAction)) {
    throw new Error("grant_action is invalid");
  }
  return value as GrantAction;
}

function requireResourceType(value: unknown): GrantResourceType {
  if (value !== "merchant" && value !== "product") throw new Error("resource_type is invalid");
  return value;
}

function requireSelector(value: unknown): "merchant" | "all_products" | readonly string[] {
  if (value === "merchant" || value === "all_products") return value;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("resource_selector is invalid");
  }
  return value;
}
