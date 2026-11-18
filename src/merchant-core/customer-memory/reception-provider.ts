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
import { requestMemoryProposal } from "./private-transport.js";

export class SqliteCustomerMemoryProvider implements CustomerMemoryToolProvider {
  private readonly dbPath: string;
  private readonly now: () => string;
  /** 接待进程是否允许写候选记忆；单写者部署下 a2a 只读。 */
  private readonly allowWrites: boolean;
  private readonly socketPath: string | undefined;
  private handle: DatabaseSync | undefined;

  constructor(options: { dbPath: string; now?: () => string; allowWrites?: boolean; socketPath?: string }) {
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date().toISOString());
    // P2-9：默认只读；直写路径必须由宿主显式开启（生产始终 false）。
    this.allowWrites = options.allowWrites ?? false;
    this.socketPath = options.socketPath;
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
      memory: new CustomerMemoryService({ db, now: this.now, sourceGovernance: source, identity: new CustomerIdentityService({ db, now: this.now }) }),
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
      const memoryScope = grants.find((grant) => grant.purpose === "customer_memory")?.resource_scope_id;
      const memoryDataScope = memoryScope === undefined ? undefined : source.getDataScope(merchantId, memoryScope);
      const dataScope = source.getDataScope(merchantId, scope);
      if (dataScope === undefined || dataScope.state !== "ACTIVE") return undefined;
      const grantVersions: Record<string, number> = {};
      for (const grant of grants) grantVersions[grant.grant_id] = grant.grant_epoch;
      const setVersion =
        this.services(db).memory.currentMemorySetVersion(merchantId, binding.subject_id) ?? 0;
      return {
        merchant_id: merchantId,
        actor_id: actorId,
        subject_id: binding.subject_id,
        binding_epoch: binding.binding_epoch,
        resource_scope_id: scope,
        ...(memoryScope !== undefined && memoryDataScope?.state === "ACTIVE" ? { memory_scope_id: memoryScope } : {}),
        grant_versions: grantVersions,
        memory_set_version: setVersion,
        data_scope_epochs: { [scope]: dataScope.data_epoch, ...(memoryScope !== undefined && memoryDataScope?.state === "ACTIVE" ? { [memoryScope]: memoryDataScope.data_epoch } : {}) },
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

  canPropose(context: CustomerRecallContext): boolean {
    return context.memory_scope_id !== undefined && (this.allowWrites || this.socketPath !== undefined);
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
  ): { memory_id: string; state: string } | Promise<{ memory_id: string; state: string }> {
    if (!this.allowWrites && this.socketPath !== undefined) return requestMemoryProposal(this.socketPath, context, input);
    if (!this.allowWrites) {
      throw new Error("customer memory writes are handled by the standalone workbench");
    }
    const db = this.db();
    if (db === undefined) {
      throw new Error("customer memory store unavailable");
    }
    const memory = this.services(db).memory.proposeMemory({
      merchant_id: context.merchant_id,
      actor: this.systemActor(context.merchant_id),
      subject_id: context.subject_id,
      // P2-8：与 canPropose 的判定一致——写记忆落在 memory scope，而不是
      // history scope（否则 fail-closed 或归档到错误域）。
      resource_scope_id: context.memory_scope_id ?? context.resource_scope_id,
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
