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
 * 本模块是进程内协调；持久在途由 DeliveryStore/outbox 承担。
 */

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

  /** 申请进入发送流；已有未过期 holder 时拒绝。 */
  enter(input: { stream_key: string; holder_id: string; lease_ms: number; now: string }): void {
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms <= 0) {
      throw new Error("lease_ms must be a positive integer");
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
      lease_expires_at: new Date(Date.parse(input.now) + input.lease_ms).toISOString(),
    });
  }

  /** 结果确定（SENT/not_sent）后释放；UNKNOWN 不释放。 */
  leave(stream_key: string, holder_id: string): void {
    const current = this.holders.get(stream_key);
    if (current?.holder_id === holder_id) this.holders.delete(stream_key);
  }

  isHeld(stream_key: string, now: string): boolean {
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
