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
 * 现实单调时钟（审查 BUG-01）：生产路径不得使用固定日期基准——此前
 * node.ts / negotiate.ts 各自实现 monotonicNow，从固定 2026-08-07 起步、
 * 每次调用只 +1ms。第三方会收到历史时间戳或已过期报价，本机又用同一假
 * 时钟判断过期，形成"本机接受、外部拒绝"的互操作分裂；重启还会把时钟
 * 重置回同一历史起点。
 *
 * 语义：返回墙钟 ISO 时间，但保证同进程内严格单调（max(墙钟, prev+1)）——
 * 同一毫秒的多个事件不会产生相同时间戳（ledger 内容去重依赖相同内容，
 * 时间戳不参与去重键，但 created_at 必须与现实时间一致）。
 *
 * 测试可注入固定时间源：createMonotonicClock(() => Date.parse("..."))。
 */

/** 构造现实单调时钟：返回 ISO 字符串，同进程内严格递增。 */
export function createMonotonicClock(nowFn: () => number = Date.now): () => string {
  let previous = 0;
  return () => {
    const wall = nowFn();
    const t = Number.isFinite(wall) && wall > previous ? wall : previous + 1;
    previous = t;
    return new Date(t).toISOString();
  };
}
