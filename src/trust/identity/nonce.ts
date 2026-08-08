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
 * 达到上限时逐 key 淘汰最旧一条（FIFO，评审项 H6）：整体清空会让时钟窗口
 * 内**全部**已捕获 nonce 同时失效——此前配合"验签前消费"，攻击者用伪造
 * 签名填满 store 触发清空后，真实捕获的签名可被重放；FIFO 只挤出最旧一条
 * （最早的 nonce 最接近过期），配合验签后消费使 store 只能被真实签名写入。
 */
export class InMemoryNonceStore implements NonceStore {
  /** key → 记录时间（ms）。Map 迭代序 = 插入序，满额时删除首条。 */
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(maxEntries = 10_000, now: () => number = Date.now) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("InMemoryNonceStore: maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
    this.now = now;
  }

  checkAndSet(key: string): boolean {
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, this.now());
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
}
