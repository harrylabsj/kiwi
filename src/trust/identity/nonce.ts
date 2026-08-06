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
 * 防重放 nonce 存储（RFC 9421 created/expires 之外的第二道防线）。
 *
 * created/expires 只证明签名在时间窗口内有效；nonce 让同一签名（相同 keyid +
 * nonce）在窗口内也只能使用一次。验签方把 (keyid, nonce) 记入 nonceStore，
 * 重复出现即 replay_detected。
 */

export interface NonceStore {
  /**
   * 记录一次 nonce 使用。返回 true 表示首次见到（fresh）；false 表示已用过
   * （replay）。实现必须原子（同一 key 并发只会有一个 true）。
   */
  checkAndSet(key: string): boolean;
}

/**
 * 进程内 nonce 缓存。适合单实例验证方；多实例部署应换共享存储（Redis 等）。
 * 达到上限时清空（保底防无限增长；T3 的 nonce 只在时钟窗口内有效，清空是
 * 保守而非危险行为）。
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("InMemoryNonceStore: maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  checkAndSet(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) this.seen.clear();
    this.seen.add(key);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
