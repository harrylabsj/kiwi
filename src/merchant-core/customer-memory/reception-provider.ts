/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 基于 state.sqlite 的接待客户记忆工具提供者（M3-6）。
 *
 * 懒打开数据库；无绑定、无有效 grant 或 scope 已封存时返回 undefined，接待
 * 只使用当前会话。工具内部用服务主体执行，模型不能提交 subject/merchant。
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ActorContext } from "../context-governance/actor-context.js";
import { createActorContext } from "../context-governance/actor-context.js";
import { DataUseGrantStore } from "../context-governance/data-use-grant.js";
import { SourceGovernanceService } from "../context-governance/source-governance.js";
import type {
  CustomerMemoryToolProvider,
  CustomerRecallContext,
} from "../../a2a/reception/customer-memory-tools.js";
import type {
  HistorySearchResult,
  MemoryNamespace,
  MemorySourceKind,
} from "./types.js";
import { CustomerIdentityService } from "./identity.js";
import { CustomerMemoryService } from "./memory.js";
import { HistorySearchService } from "./history.js";

export class SqliteCustomerMemoryProvider implements CustomerMemoryToolProvider {
  private readonly dbPath: string;
  private readonly now: () => string;
  private handle: DatabaseSync | undefined;

  constructor(options: { dbPath: string; now?: () => string }) {
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private db(): DatabaseSync | undefined {
    if (this.handle !== undefined) return this.handle;
    if (!existsSync(this.dbPath)) return undefined;
    try {
      this.handle = new DatabaseSync(this.dbPath);
      return this.handle;
    } catch {
      return undefined;
    }
  }

  private systemActor(merchantId: string): ActorContext {
    return createActorContext({
      merchant_id: merchantId,
      actor_id: "system:reception-memory",
      auth_strength: "verified",
      subject_binding: "organization",
      capabilities: ["memory:read", "memory:write", "customer:self"],
    });
  }

  private services(db: DatabaseSync): {
    identity: CustomerIdentityService;
    grants: DataUseGrantStore;
    memory: CustomerMemoryService;
    history: HistorySearchService;
    source: SourceGovernanceService;
  } {
    const source = new SourceGovernanceService({ db, now: this.now });
    return {
      identity: new CustomerIdentityService({ db, now: this.now }),
      grants: new DataUseGrantStore({ db, now: this.now }),
      memory: new CustomerMemoryService({ db, now: this.now, sourceGovernance: source }),
      history: new HistorySearchService({ db, now: this.now }),
      source,
    };
  }

  contextFor(merchantId: string, actorId: string): CustomerRecallContext | undefined {
    const db = this.db();
    if (db === undefined) return undefined;
    try {
      const { identity, source } = this.services(db);
      const binding = identity.currentSubjectForActor(merchantId, actorId);
      if (binding === undefined) return undefined;
      const stamp = this.now();
      const grants = db
        .prepare(
          `SELECT grant_id, grant_epoch, purpose, resource_scope_id
             FROM data_grants
            WHERE merchant_id = ? AND subject_id = ?
              AND status = 'ACTIVE' AND expires_at > ?`,
        )
        .all(merchantId, binding.subject_id, stamp) as unknown as Array<{
        grant_id: string;
        grant_epoch: number;
        purpose: string;
        resource_scope_id: string;
      }>;
      if (grants.length === 0) return undefined;
      const scope =
        grants.find((grant) => grant.purpose === "history_recall")?.resource_scope_id ??
        grants.find((grant) => grant.purpose === "customer_memory")?.resource_scope_id;
      if (scope === undefined) return undefined;
      const dataScope = source.getDataScope(merchantId, scope);
      if (dataScope === undefined || dataScope.state !== "ACTIVE") return undefined;
      const grantVersions: Record<string, number> = {};
      for (const grant of grants) grantVersions[grant.grant_id] = grant.grant_epoch;
      const setVersion =
        this.services(db).memory.currentMemorySetVersion(merchantId, binding.subject_id) ?? 0;
      return {
        merchant_id: merchantId,
        subject_id: binding.subject_id,
        binding_epoch: binding.binding_epoch,
        resource_scope_id: scope,
        grant_versions: grantVersions,
        memory_set_version: setVersion,
        data_scope_epochs: { [scope]: dataScope.data_epoch },
      };
    } catch {
      return undefined;
    }
  }

  currentBindingEpoch(merchantId: string, actorId: string): number | undefined {
    const db = this.db();
    if (db === undefined) return undefined;
    try {
      return new CustomerIdentityService({ db, now: this.now }).currentBindingEpoch(
        merchantId,
        actorId,
      );
    } catch {
      return undefined;
    }
  }

  currentGrantEpoch(merchantId: string, grantId: string): number | undefined {
    const db = this.db();
    if (db === undefined) return undefined;
    try {
      return new DataUseGrantStore({ db, now: this.now }).currentGrantEpoch(
        merchantId,
        grantId,
      );
    } catch {
      return undefined;
    }
  }

  currentDataScopeEpoch(merchantId: string, scopeKey: string): number | undefined {
    const db = this.db();
    if (db === undefined) return undefined;
    try {
      return new SourceGovernanceService({ db, now: this.now }).currentDataScopeEpoch(
        merchantId,
        scopeKey,
      );
    } catch {
      return undefined;
    }
  }

  currentMemorySetVersion(merchantId: string, subjectId: string): number | undefined {
    const db = this.db();
    if (db === undefined) return undefined;
    try {
      return new CustomerMemoryService({ db, now: this.now }).currentMemorySetVersion(
        merchantId,
        subjectId,
      );
    } catch {
      return undefined;
    }
  }

  recall(context: CustomerRecallContext): Array<{
    memory_id: string;
    namespace: MemoryNamespace;
    key: string;
    value_ref: string;
    value_type: string;
    version: number;
    confirmed_at: string | null;
  }> {
    const db = this.db();
    if (db === undefined) return [];
    try {
      return this.services(db)
        .memory.listActiveForRecall(context.merchant_id, context.subject_id)
        .slice(0, 5)
        .map((memory) => ({
          memory_id: memory.memory_id,
          namespace: memory.namespace,
          key: memory.key,
          value_ref: memory.value_ref,
          value_type: memory.value_type,
          version: memory.version,
          confirmed_at: memory.confirmed_at,
        }));
    } catch {
      return [];
    }
  }

  search(
    context: CustomerRecallContext,
    input: { query: string; cursor?: string; limit?: number },
  ): HistorySearchResult {
    const db = this.db();
    if (db === undefined) return { status: "unavailable", reason: "history_store_unavailable" };
    try {
      return this.services(db).history.search({
        merchant_id: context.merchant_id,
        actor: this.systemActor(context.merchant_id),
        subject_id: context.subject_id,
        resource_scope_id: context.resource_scope_id,
        query: input.query,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
    } catch {
      return { status: "unavailable", reason: "history_store_error" };
    }
  }

  propose(
    context: CustomerRecallContext,
    input: {
      namespace: MemoryNamespace;
      key: string;
      value_ref: string;
      value_type: string;
      source_kind: MemorySourceKind;
      confidence?: number;
    },
  ): { memory_id: string; state: string } {
    const db = this.db();
    if (db === undefined) {
      throw new Error("customer memory store unavailable");
    }
    const memory = this.services(db).memory.proposeMemory({
      merchant_id: context.merchant_id,
      actor: this.systemActor(context.merchant_id),
      subject_id: context.subject_id,
      resource_scope_id: context.resource_scope_id,
      namespace: input.namespace,
      key: input.key,
      value_ref: input.value_ref,
      value_type: input.value_type,
      source_kind: input.source_kind,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    });
    return { memory_id: memory.memory_id, state: memory.state };
  }

  close(): void {
    if (this.handle !== undefined) {
      try {
        this.handle.close();
      } catch {
        // 关闭失败不影响退出。
      }
      this.handle = undefined;
    }
  }
}
