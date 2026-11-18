/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 */
/** Workbench 在所有权事务内核验接待快照并写入候选。 */
import type { DatabaseSync } from "node:sqlite";
import type { CustomerMemoryToolProvider } from "../../a2a/reception/customer-memory-tools.js";
import { createActorContext } from "../context-governance/actor-context.js";
import { DataUseGrantStore } from "../context-governance/data-use-grant.js";
import { SourceGovernanceService } from "../context-governance/source-governance.js";
import { CustomerIdentityService } from "./identity.js";
import { CustomerMemoryService } from "./memory.js";

export type ReceptionMemoryWriter = (context: Parameters<CustomerMemoryToolProvider["propose"]>[0], input: Parameters<CustomerMemoryToolProvider["propose"]>[1]) => { memory_id: string; state: string };

export function createReceptionMemoryWriter(options: {
  db: DatabaseSync; merchantId: string; now: () => string; write: <T>(work: () => T) => T;
}): ReceptionMemoryWriter {
  const { db, merchantId, now, write } = options;
  return (context, input) => write(() => {
    if (!context || context.merchant_id !== merchantId || typeof context.actor_id !== "string" || !context.actor_id || typeof context.memory_scope_id !== "string") throw new Error("invalid context");
    const memoryScope = context.memory_scope_id;
    const identity = new CustomerIdentityService({ db, now });
    const binding = identity.currentSubjectForActor(merchantId, context.actor_id);
    if (!binding || binding.subject_id !== context.subject_id || binding.binding_epoch !== context.binding_epoch) throw new Error("binding changed");
    const source = new SourceGovernanceService({ db, now });
    const scope = source.getDataScope(merchantId, memoryScope);
    if (!scope || scope.state !== "ACTIVE" || scope.data_epoch !== context.data_scope_epochs?.[memoryScope]) throw new Error("scope changed");
    const grants = new DataUseGrantStore({ db, now });
    const grant = grants.getActiveGrant({ merchant_id: merchantId, subject_id: context.subject_id, purpose: "customer_memory", resource_scope_id: memoryScope });
    if (!grant || context.grant_versions?.[grant.grant_id] !== grant.grant_epoch) throw new Error("grant changed");
    const memory = new CustomerMemoryService({ db, now, sourceGovernance: source, identity });
    if ((memory.currentMemorySetVersion(merchantId, context.subject_id) ?? 0) !== context.memory_set_version) throw new Error("memory changed");
    const actor = createActorContext({ merchant_id: merchantId, actor_id: "system:reception-memory", auth_strength: "verified", subject_binding: "organization", capabilities: ["memory:write"] });
    const result = memory.proposeMemory({ merchant_id: merchantId, actor, subject_id: context.subject_id, resource_scope_id: memoryScope, namespace: input.namespace, key: input.key, value_ref: input.value_ref, value_type: input.value_type, source_kind: input.source_kind, ...(input.confidence !== undefined ? { confidence: input.confidence } : {}) });
    return { memory_id: result.memory_id, state: result.state };
  });
}
