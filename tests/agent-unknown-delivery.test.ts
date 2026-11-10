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
 * review P2：连接器缺失 fee / eta_minutes 必须按“未知”处理，不能静默变成
 * 0（免邮 / 立即送达），否则 hardFilter 与跟踪规则会误放行、误通知。
 */
import { describe, expect, it } from "vitest";
import { parseConnectorProduct } from "../src/agent/connector/types.js";
import { hardFilter, scoreCandidate } from "../src/agent/buyer/ranker.js";
import type { TaskConstraints, TaskIntent } from "../src/agent/buyer/types.js";

const NOW = "2026-11-10T12:00:00Z";

function product(delivery: Record<string, unknown>) {
  return parseConnectorProduct({
    sku: "sku-1",
    merchant_id: "m-1",
    title: "Synthetic",
    price: 100,
    currency: "CNY",
    stock: 5,
    delivery,
    merchant: { id: "m-1", name: "Merchant" },
  });
}

const intent: TaskIntent = { query_text: "Synthetic" };

describe("unknown delivery facts", () => {
  it("keeps missing fee/eta as undefined instead of zero", () => {
    const parsed = product({ service_area: "上海" });
    expect(parsed.delivery.fee).toBeUndefined();
    expect(parsed.delivery.eta_minutes).toBeUndefined();
  });

  it("still rejects explicitly malformed values", () => {
    expect(() => product({ fee: "free" })).toThrow(/fee must be a finite number/);
    expect(() => product({ eta_minutes: "soon" })).toThrow(/eta_minutes must be a finite number/);
  });

  it("reports unknown fee as uncertainty, not as passing a total budget", () => {
    const constraints: TaskConstraints = { max_total_price: 150 };
    const result = hardFilter(product({ service_area: "上海" }), constraints, NOW);
    expect(result.eligible).toBe("unknown");
    expect(result.unknowns.some((u) => u.includes("运费未知"))).toBe(true);
  });

  it("still filters out when the goods price alone exceeds the budget", () => {
    const result = hardFilter(product({}), { max_total_price: 50 }, NOW);
    expect(result.eligible).toBe("ineligible");
  });

  it("reports unknown eta as uncertainty rather than a satisfied deadline", () => {
    const result = hardFilter(
      product({}),
      { latest_eta: "2026-11-11T00:00:00Z" },
      NOW,
    );
    expect(result.eligible).toBe("unknown");
    expect(result.unknowns.some((u) => u.includes("交期未知"))).toBe(true);
  });

  it("marks the ranking explanation instead of scoring unknown delivery as free/instant", () => {
    const scored = scoreCandidate(product({}), { intent, policy: { weights: {}, sources: {} }, now: NOW, observations: new Map() });
    expect(scored.explanation.stale_facts.some((f) => f.includes("运费"))).toBe(true);
    const cost = scored.explanation.dimensions.find((d) => d.dimension === "total_cost");
    expect(cost?.note).toContain("未知");
    const delivery = scored.explanation.dimensions.find((d) => d.dimension === "delivery");
    expect(delivery?.note).toBe("交期未知");
  });
});
