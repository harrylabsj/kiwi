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
 * negotiation_id ↔ remote contextId 持久化存储（基线 §9.2 / §24.4）。
 *
 * 与 Ledger / Idempotency store 同构：目录 0700、文件 0600、同目录临时文件
 * （wx + fsync）+ rename 原子写（对齐 supervisor/manifest.ts）。每个 negotiation
 * 一个 JSON 文件，`<dir>/context-map/<safe>.json`（safe 文件名沿用 ledgerFileName
 * 的归一化 + sha256 前缀策略，防目录逃逸与碰撞）。
 *
 * 远端 contextId 对 Kiwi opaque：只做结构校验（parseContextMapping），不解析
 * 不推断。文件损坏 / 字段违规 fail-closed 抛 ContextMapError，绝不静默返回残缺映射。
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { sha256Hex } from "../jcs.js";
import { validateContextId, validateIdentifier, validateTaskId } from "../domain/identifiers.js";
import { parseContextMapping, type ContextMapping, type ContextMappingPatch } from "./types.js";

export type ContextMapErrorCode = "corrupt" | "invalid_input";

export class ContextMapError extends Error {
  readonly code: ContextMapErrorCode;
  constructor(code: ContextMapErrorCode, message: string) {
    super(message);
    this.name = "ContextMapError";
    this.code = code;
  }
}

export interface ContextMapStoreOptions {
  /** 基础数据目录；映射文件落在 `<dir>/context-map/`。 */
  dir: string;
  /** 可注入时钟（RFC 3339）；缺省用 new Date().toISOString()。 */
  now?: () => string;
}

let tmpSeq = 0;

/** opaque negotiation_id → 安全文件名（同 ledgerFileName：归一化 + sha256 前缀）。 */
export function contextMapFileName(negotiationId: string): string {
  const sanitized = negotiationId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${sanitized}.${sha256Hex(negotiationId).slice(0, 12)}.json`;
}

export class ContextMapStore {
  private readonly baseDir: string;
  private readonly mapDir: string;
  private readonly now: () => string;

  constructor(options: ContextMapStoreOptions) {
    this.baseDir = options.dir;
    this.mapDir = path.join(options.dir, "context-map");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private ensureMapDir(): string {
    mkdirSync(this.mapDir, { recursive: true, mode: 0o700 });
    chmodSync(this.mapDir, 0o700);
    return this.mapDir;
  }

  private filePathFor(negotiationId: string): string {
    const dir = this.ensureMapDir();
    const resolved = path.resolve(dir, contextMapFileName(negotiationId));
    if (!resolved.startsWith(`${dir}${path.sep}`)) {
      throw new ContextMapError("invalid_input", `negotiation_id escapes context-map dir`);
    }
    return resolved;
  }

  private writeFileAtomic(filePath: string, mapping: ContextMapping): void {
    const tmp = `${filePath}.tmp-${process.pid}-${++tmpSeq}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(mapping)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  }

  private readMapping(negotiationId: string): ContextMapping | null {
    const filePath = this.filePathFor(negotiationId);
    if (!existsSync(filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new ContextMapError("corrupt", `cannot read context map for ${negotiationId}: ${String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ContextMapError("corrupt", `context map for ${negotiationId} is not valid JSON`);
    }
    try {
      return parseContextMapping(parsed);
    } catch (err) {
      throw new ContextMapError(
        "corrupt",
        `context map for ${negotiationId} failed validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 取映射；不存在返回 null。文件损坏 → ContextMapError（fail-closed）。 */
  get(negotiationId: string): ContextMapping | null {
    return this.readMapping(negotiationId);
  }

  has(negotiationId: string): boolean {
    return this.get(negotiationId) !== null;
  }

  /**
   * 创建/更新映射。remote_context_id 变更以最后一次为准（§24.4 SHOULD reuse）。
   * task_ids 由 addTask 追加；set 不删除已有 taskIds。
   */
  set(negotiationId: string, patch: ContextMappingPatch): ContextMapping {
    validateIdentifier(negotiationId, "negotiation_id");
    if (patch.remote_context_id !== undefined) {
      validateContextId(patch.remote_context_id, "remote_context_id");
    }
    const existing = this.readMapping(negotiationId);
    const now = this.now();
    const mapping: ContextMapping = {
      negotiation_id: negotiationId,
      task_ids: existing?.task_ids ?? [],
      updated_at: now,
    };
    if (patch.remote_context_id !== undefined || existing?.remote_context_id !== undefined) {
      mapping.remote_context_id = patch.remote_context_id ?? existing?.remote_context_id;
    }
    this.writeFileAtomic(this.filePathFor(negotiationId), mapping);
    return mapping;
  }

  /** 追加一个 taskId（去重）。同 negotiation 首个 task 时创建映射。 */
  addTask(negotiationId: string, taskId: string): ContextMapping {
    validateIdentifier(negotiationId, "negotiation_id");
    validateTaskId(taskId, "task_id");
    const existing = this.readMapping(negotiationId);
    const taskIds = existing?.task_ids.includes(taskId)
      ? (existing.task_ids as string[])
      : [...(existing?.task_ids ?? []), taskId];
    const mapping: ContextMapping = {
      negotiation_id: negotiationId,
      task_ids: taskIds,
      updated_at: this.now(),
    };
    if (existing?.remote_context_id !== undefined) {
      mapping.remote_context_id = existing.remote_context_id;
    }
    this.writeFileAtomic(this.filePathFor(negotiationId), mapping);
    return mapping;
  }

  /** 所有已持久化的映射（按文件名扫描；损坏文件抛 ContextMapError）。 */
  list(): ContextMapping[] {
    const dir = this.ensureMapDir();
    const result: ContextMapping[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch (err) {
        throw new ContextMapError("corrupt", `cannot read ${name}: ${String(err)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ContextMapError("corrupt", `${name} is not valid JSON`);
      }
      try {
        result.push(parseContextMapping(parsed));
      } catch (err) {
        throw new ContextMapError(
          "corrupt",
          `${name} failed validation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return result;
  }
}
