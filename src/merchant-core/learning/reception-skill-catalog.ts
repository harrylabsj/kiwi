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
 * 基于 state.sqlite 的接待技能目录（M2-6）。
 *
 * 只读取生效指针指向且 state=ACTIVE 的发布版本；撤回/退役后立即不再返回。
 * 数据库是懒打开：首个技能发布前或旧二进制库中没有学习表时返回空目录，
 * 不影响现有接待（fail-open 到“无技能”，而不是破坏接待启动）。
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { CurrentSkillBinding } from "../context-governance/context-guard.js";
import {
  summarizeBindings,
  type ReceptionSkillBinding,
  type ReceptionSkillCatalog,
  type SkillSummaryResult,
} from "../../a2a/reception/skill-catalog.js";
import type {
  CompiledReceptionSkill,
  ReceptionSkillStep,
  ReceptionSkillTool,
} from "../../a2a/reception/skill-contract.js";

interface ReleaseRow {
  release_id: string;
  skill_key: string;
  trigger_text: string;
  generation: number;
  artifact_hash: string;
  compiled_artifact_json: string;
  question_schema_version: number;
  tool_contract_digest: string;
  revocation_epoch: number;
}

const ACTIVE_BINDINGS_SQL = `
SELECT r.release_id, r.skill_key, r.trigger_text, r.generation, r.artifact_hash,
       r.compiled_artifact_json, r.question_schema_version, r.tool_contract_digest,
       r.revocation_epoch
  FROM skill_active_pointers p
  JOIN skill_releases r
    ON r.merchant_id = p.merchant_id AND r.release_id = p.release_id
 WHERE p.merchant_id = ? AND p.release_id IS NOT NULL AND r.state = 'ACTIVE'
 ORDER BY r.skill_key ASC
`;

function toBinding(row: ReleaseRow): ReceptionSkillBinding | undefined {
  let artifact: CompiledReceptionSkill;
  try {
    artifact = JSON.parse(row.compiled_artifact_json) as CompiledReceptionSkill;
  } catch {
    return undefined;
  }
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    typeof artifact.body_text !== "string" ||
    !Array.isArray(artifact.steps) ||
    !Array.isArray(artifact.required_tools)
  ) {
    return undefined;
  }
  return {
    skill_key: row.skill_key,
    release_id: row.release_id,
    compiled_artifact_hash: row.artifact_hash,
    generation: row.generation,
    revocation_epoch: row.revocation_epoch,
    trigger_text: row.trigger_text,
    question_schema_version: row.question_schema_version,
    tool_contract_digest: row.tool_contract_digest,
    body_text: artifact.body_text,
    steps: artifact.steps as readonly ReceptionSkillStep[],
    required_tools: artifact.required_tools as readonly ReceptionSkillTool[],
  };
}

export class SqliteReceptionSkillCatalog implements ReceptionSkillCatalog {
  private readonly dbPath: string;
  private handle: DatabaseSync | undefined;
  private unavailable = false;

  constructor(options: { dbPath: string }) {
    this.dbPath = options.dbPath;
  }

  private db(): DatabaseSync | undefined {
    if (this.handle !== undefined) return this.handle;
    if (this.unavailable || !existsSync(this.dbPath)) return undefined;
    try {
      this.handle = new DatabaseSync(this.dbPath);
      return this.handle;
    } catch {
      this.unavailable = true;
      return undefined;
    }
  }

  private rows(sql: string, ...params: Array<string | number | null>): ReleaseRow[] {
    const db = this.db();
    if (db === undefined) return [];
    try {
      return db.prepare(sql).all(...params) as unknown as ReleaseRow[];
    } catch {
      // 旧库/迁移未完成：保持空目录，不阻断接待。
      return [];
    }
  }

  activeBindings(merchantId: string): ReceptionSkillBinding[] {
    return this.rows(ACTIVE_BINDINGS_SQL, merchantId)
      .map(toBinding)
      .filter((binding): binding is ReceptionSkillBinding => binding !== undefined);
  }

  summaries(merchantId: string): SkillSummaryResult {
    return summarizeBindings(this.activeBindings(merchantId));
  }

  currentBinding(merchantId: string, skillKey: string): CurrentSkillBinding | undefined {
    const binding = this.activeBindings(merchantId).find(
      (item) => item.skill_key === skillKey,
    );
    return binding === undefined
      ? undefined
      : {
          release_id: binding.release_id,
          compiled_artifact_hash: binding.compiled_artifact_hash,
          generation: binding.generation,
          revocation_epoch: binding.revocation_epoch,
        };
  }

  /**
   * 加载运行快照中已固定的产物（A10）。
   *
   * RETIRED 不再分配给新运行，但已固定且仍兼容的在途运行可完成；REVOKED
   * 一律拒绝。调用方只在运行快照包含该 release 时才会请求，因此这里不
   * 依赖当前生效指针。
   */
  loadArtifact(
    merchantId: string,
    skillKey: string,
    releaseId: string,
  ): ReceptionSkillBinding | undefined {
    const rows = this.rows(
      `SELECT r.release_id, r.skill_key, r.trigger_text, r.generation, r.artifact_hash,
              r.compiled_artifact_json, r.question_schema_version, r.tool_contract_digest,
              r.revocation_epoch
         FROM skill_releases r
        WHERE r.merchant_id = ? AND r.skill_key = ? AND r.release_id = ?
          AND r.state IN ('ACTIVE','RETIRED') AND r.revoked_at IS NULL`,
      merchantId,
      skillKey,
      releaseId,
    );
    return rows.length === 1 ? toBinding(rows[0]!) : undefined;
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
