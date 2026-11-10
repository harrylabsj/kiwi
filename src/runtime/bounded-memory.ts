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
 * 有界内存表（审查 P2：多个生命周期 Map/Set 只增不减）。
 *
 * 淘汰最旧的条目（插入顺序）。这些结构只是**进程内热缓存**：权威状态在
 * Ledger/持久化层，淘汰后按持久层重建（不会伪造状态，也不会丢失终态
 * 语义——只是重新从账本推导一次）。
 */

const DEFAULT_MAX_ENTRIES = 10_000;

export class BoundedMap<K, V> extends Map<K, V> {
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    super();
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.maxEntries) {
      const oldest = this.keys().next();
      if (oldest.done !== true) this.delete(oldest.value);
    }
    return super.set(key, value);
  }
}

export class BoundedSet<T> extends Set<T> {
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    super();
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  override add(value: T): this {
    if (!this.has(value) && this.size >= this.maxEntries) {
      const oldest = this.values().next();
      if (oldest.done !== true) this.delete(oldest.value);
    }
    return super.add(value);
  }
}
