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
 * P1 发送流协调门（设计 §16.3 / M6-5）。
 *
 * 接待回复与经营通知共用同一 stream_key（merchant + 渠道 + 会话/收件范围），
 * 同一时刻只允许一条在途。UNKNOWN 未核对前保持占用；结果确认后才释放。
 * 持久实例使用共享 SQLite 租约；投递结果仍以各自 outbox 为准。
 */

import { constants, fchmodSync, fstatSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StreamGateErrorCode = "stream_busy";

export class StreamGateError extends Error {
  readonly code: StreamGateErrorCode;
  readonly streamKey: string;
  constructor(streamKey: string) {
    super(`发送流 ${streamKey} 已有在途通知`);
    this.name = "StreamGateError";
    this.code = "stream_busy";
    this.streamKey = streamKey;
  }
}

interface Holder {
  readonly holder_id: string;
  readonly lease_expires_at: string;
}

export class StreamGate {
  private readonly holders = new Map<string, Holder>();

  constructor(private readonly db?: DatabaseSync) {
    db?.exec(`
      CREATE TABLE IF NOT EXISTS delivery_stream_leases (
        stream_key TEXT PRIMARY KEY, holder_id TEXT NOT NULL, lease_expires_at TEXT NOT NULL
      )
    `);
  }

  static forDataDir(dataDir: string): StreamGate {
    const file = path.join(dataDir, "delivery-streams.sqlite");
    const fd = openSync(file, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid delivery stream database");
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      return new StreamGate(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db?.close();
  }

  /** 申请进入发送流；已有未过期 holder 时拒绝。 */
  enter(input: { stream_key: string; holder_id: string; lease_ms: number; now: string }): void {
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms <= 0) {
      throw new Error("lease_ms must be a positive integer");
    }
    const expiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
    if (this.db !== undefined) {
      const result = this.db.prepare(
        `INSERT INTO delivery_stream_leases (stream_key, holder_id, lease_expires_at)
         VALUES (?, ?, ?) ON CONFLICT(stream_key) DO UPDATE SET
           holder_id = excluded.holder_id, lease_expires_at = excluded.lease_expires_at
         WHERE delivery_stream_leases.lease_expires_at <= ?
            OR delivery_stream_leases.holder_id = excluded.holder_id`,
      ).run(input.stream_key, input.holder_id, expiresAt, input.now);
      if (result.changes === 0) throw new StreamGateError(input.stream_key);
      return;
    }
    const current = this.holders.get(input.stream_key);
    if (
      current !== undefined &&
      Date.parse(current.lease_expires_at) > Date.parse(input.now) &&
      current.holder_id !== input.holder_id
    ) {
      throw new StreamGateError(input.stream_key);
    }
    this.holders.set(input.stream_key, {
      holder_id: input.holder_id,
      lease_expires_at: expiresAt,
    });
  }

  /** 结果确定（SENT/not_sent）后释放；UNKNOWN 不释放。 */
  leave(stream_key: string, holder_id: string): void {
    if (this.db !== undefined) {
      this.db.prepare("DELETE FROM delivery_stream_leases WHERE stream_key = ? AND holder_id = ?")
        .run(stream_key, holder_id);
      return;
    }
    const current = this.holders.get(stream_key);
    if (current?.holder_id === holder_id) this.holders.delete(stream_key);
  }

  isHeld(stream_key: string, now: string): boolean {
    if (this.db !== undefined) {
      return this.db.prepare("SELECT 1 FROM delivery_stream_leases WHERE stream_key = ? AND lease_expires_at > ?")
        .get(stream_key, now) !== undefined;
    }
    const current = this.holders.get(stream_key);
    return current !== undefined && Date.parse(current.lease_expires_at) > Date.parse(now);
  }
}

/** 接待与经营通知共用的 stream key 约定。 */
export function streamKey(input: {
  merchant_id: string;
  channel: string;
  scope: string;
}): string {
  return `${input.merchant_id}:${input.channel}:${input.scope}`;
}
