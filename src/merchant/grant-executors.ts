/** Owner-only, WebAuthn-committed scoped grant mutation executors. */

import type { CommandExecutor } from "../merchant-core/executor.js";
import { createVerifiedActorContext } from "./application/actor.js";
import {
  GRANT_ACTIONS,
  type GrantAction,
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
      execute: async (args) =>
        store().createGrant(ownerContext(options.merchantId, args), {
          subjectId: requireText(args["subject_id"], "subject_id"),
          action: requireAction(args["grant_action"]),
          resourceType: requireResourceType(args["resource_type"]),
          resourceSelector: requireSelector(args["resource_selector"]),
          expiresAt: requireText(args["expires_at"], "expires_at"),
        }),
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
      execute: async (args) =>
        store().revokeGrant(
          ownerContext(options.merchantId, args),
          requireText(args["grant_id"], "grant_id"),
        ),
    },
  ];
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
