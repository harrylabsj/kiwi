#!/usr/bin/env node
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
 * `kiwi merchant` 命令面（product-strategy rev1.1 §2.3/§19）。
 *
 * - stats：商家侧运营统计（本地 <dataDir>/a2a/stats.sqlite，由 merchant A2A
 *   节点在收到买家 KNP 消息时自动收集；数据只在商家本机，永不上报）。
 *   回答两个问题：多少个不同的买家联系过我、讨论了哪些商品（SKU）。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  openMerchantStatsStore,
  type ContactTotals,
  type DailyBucket,
  type SkuStat,
} from "./merchant/stats-store.js";

/** 身份语义说明：distinct_buyers 只在 signature 模式下是真实去重买家。 */
const IDENTITY_NOTE =
  "买家身份依赖传输层认证：signature 模式下为真实去重买家；loopback/none/bearer 模式会聚合买家";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const TOP_SKU_LIMIT = 20;

export interface MerchantStatsOptions {
  /** merchant agent_id（报告标识，不参与查询）。 */
  agentId: string;
  /** 节点数据目录（resolveServeDataDir 解析后的 dataDir；统计库在 <dataDir>/a2a/）。 */
  dataDir: string;
  /** 回看天数（缺省 14，clamp 1..90；天数一律 UTC）。 */
  days?: number;
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  now?: () => string;
}

export interface MerchantStatsReport {
  ok: true;
  agent_id: string;
  days: number;
  identity_note: string;
  totals: ContactTotals;
  today: { distinct_buyers: number; contact_events: number };
  /** 零填充的 N 天窗口（升序，含今天）。 */
  daily: DailyBucket[];
  top_skus: SkuStat[];
}

/** UTC 日串加减天数（`YYYY-MM-DD`）。 */
function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** 读本地买家触达统计（merchant start 运行并收到买家消息后才有数据；缺省报错）。 */
export function merchantStats(options: MerchantStatsOptions): MerchantStatsReport {
  const now = (options.now ?? (() => new Date().toISOString()))();
  const today = now.slice(0, 10);
  const requested = options.days ?? DEFAULT_DAYS;
  const days = Math.max(1, Math.min(MAX_DAYS, Math.trunc(requested)));
  const sinceDay = shiftDay(today, -(days - 1));

  const dbPath = path.join(options.dataDir, "a2a", "stats.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error(
      `尚无买家沟通数据（${dbPath} 不存在）——商家服务启动并收到买家消息后会自动收集（kiwi merchant start）`,
    );
  }
  const store = openMerchantStatsStore({ dbPath });
  try {
    const totals = store.totalsSince(sinceDay);
    const todayTotals = store.totalsSince(today);
    const byDay = new Map(store.dailySince(sinceDay).map((d) => [d.day, d]));
    const daily: DailyBucket[] = [];
    for (let i = 0; i < days; i++) {
      const day = shiftDay(sinceDay, i);
      daily.push(
        byDay.get(day) ?? { day, distinct_buyers: 0, contact_events: 0, negotiations: 0 },
      );
    }
    return {
      ok: true,
      agent_id: options.agentId,
      days,
      identity_note: IDENTITY_NOTE,
      totals,
      today: {
        distinct_buyers: todayTotals.distinct_buyers,
        contact_events: todayTotals.contact_events,
      },
      daily,
      top_skus: store.topSkus(sinceDay, TOP_SKU_LIMIT),
    };
  } finally {
    store.close();
  }
}
