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
 * SI. SIG-05 审计与恢复（设计 v0.1.2 §11.6）：
 *   - 记录签发 / 拒绝 / 轮换 / 撤销的**脱敏**审计（追加写，可读回）；
 *   - 撤销集独立于签发路径：被撤销的绑定或密钥指纹**不得因恢复而重新生效**。
 *
 * 脱敏口径：只允许白名单字段进入审计；字符串截断；形似密钥/JWS 的内容直接拒绝
 * （宁可记不下，也不把凭据写进日志）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type BindingAuditEventKind =
  | "issued"
  | "refused"
  | "verified"
  | "verify_failed"
  | "rotated"
  | "revoked";

export interface BindingAuditEvent {
  at: string;
  event: BindingAuditEventKind;
  binding_id?: string;
  merchant_id?: string;
  agent_id?: string;
  generation?: number;
  binding_version?: number;
  key_thumbprint?: string;
  /** 拒绝/失败原因码（稳定码，非自由文本）。 */
  code?: string;
  /** 短说明（截断到 200 字符）。 */
  note?: string;
}

const MAX_NOTE = 200;
/** 形似凭据的内容：一律拒绝写审计（宁可丢失说明，也不落库凭据）。 */
const SECRET_LIKE = /(BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|"d":"[A-Za-z0-9_-]{20,}")/;

function sanitizeNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  if (SECRET_LIKE.test(note)) return "[redacted:secret-like]";
  return note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE)}…` : note;
}

export class BindingAuditLog {
  private readonly file: string | undefined;
  private readonly now: () => Date;

  constructor(options: { file?: string; now?: () => Date } = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date());
    if (this.file !== undefined) {
      const dir = path.dirname(this.file);
      if (dir !== "" && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** 追加一条审计（追加写 + 立即落盘；失败不静默）。 */
  append(event: Omit<BindingAuditEvent, "at"> & { at?: string }): BindingAuditEvent {
    const record: BindingAuditEvent = {
      ...event,
      at: event.at ?? this.now().toISOString(),
      ...(event.note !== undefined ? { note: sanitizeNote(event.note) } : {}),
    };
    if (this.file !== undefined) {
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }
    return record;
  }

  /** 读回审计（用于复核；损坏行跳过并保留原文件不动）。 */
  read(): BindingAuditEvent[] {
    if (this.file === undefined || !existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as BindingAuditEvent];
        } catch {
          return [];
        }
      });
  }
}

export interface RevocationRecord {
  binding_id: string;
  key_thumbprint?: string;
  reason: string;
  revoked_at: string;
}

/**
 * 撤销集：SIG-05 的"恢复不复活已撤销密钥"。
 *
 * 语义：
 *   - 撤销是**追加**的，不从集合里删除；恢复流程只能读它、不能清空；
 *   - 依据 binding_id 或 key_thumbprint 判定（轮换泄漏时按指纹撤销）；
 *   - 可选持久化文件，重启后仍生效（否则"重启即复活"）。
 */
export class RevocationSet {
  private readonly file: string | undefined;
  private records: RevocationRecord[];

  constructor(options: { file?: string } = {}) {
    this.file = options.file;
    this.records = this.load();
  }

  private load(): RevocationRecord[] {
    if (this.file === undefined || !existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is RevocationRecord =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as RevocationRecord).binding_id === "string" &&
          typeof (item as RevocationRecord).revoked_at === "string",
      );
    } catch {
      // 文件损坏：返回空集合会让"已撤销"变成"未撤销"——因此改为抛出，让调用方
      // fail-closed（宁可不签发，也不复活已撤销密钥）。
      throw new Error(`撤销集文件损坏，拒绝以空集合继续：${this.file}`);
    }
  }

  private persist(): void {
    if (this.file === undefined) return;
    const dir = path.dirname(this.file);
    if (dir !== "" && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, `${JSON.stringify(this.records, null, 2)}\n`, { mode: 0o600 });
  }

  /** 追加撤销记录（幂等：同一 binding_id 重复撤销不重复追加）。 */
  revoke(record: RevocationRecord): RevocationRecord {
    const existing = this.records.find((item) => item.binding_id === record.binding_id);
    if (existing !== undefined) return existing;
    this.records.push(record);
    this.persist();
    return record;
  }

  byBinding(bindingId: string): RevocationRecord | undefined {
    return this.records.find((item) => item.binding_id === bindingId);
  }

  byThumbprint(thumbprint: string): RevocationRecord | undefined {
    return this.records.find((item) => item.key_thumbprint === thumbprint);
  }

  list(): RevocationRecord[] {
    return [...this.records];
  }
}
