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
 * 发布门禁的已复核豁免：只放行明确列出且未过期的 advisory，其余一律拦截。
 */

import { describe, expect, it } from "vitest";
import { advisoryIdOf, assertAllowList, classifyAudit } from "../scripts/lib/shipping-audit.mjs";

const NOW = new Date("2026-10-28T00:00:00Z");

function allow(entries: Array<Partial<{ id: string; package: string; expires_at: string }>>) {
  return {
    schema: "kiwi.shipping-audit-allow/1",
    entries: entries.map((entry) => ({
      id: entry.id ?? "GHSA-aaaa-bbbb-cccc",
      package: entry.package ?? "undici",
      reason: "test",
      approved_by: "tester",
      approved_at: "2026-10-28",
      expires_at: entry.expires_at ?? "2026-11-27",
    })),
  };
}

const undiciAudit = {
  vulnerabilities: {
    undici: {
      severity: "high",
      via: [
        {
          source: 1,
          name: "undici",
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
          severity: "high",
        },
      ],
    },
  },
  metadata: { vulnerabilities: { high: 1, total: 1 } },
};

describe("advisory id extraction", () => {
  it("reads the GHSA id from the advisory url and ignores package-name via entries", () => {
    expect(advisoryIdOf({ url: "https://github.com/advisories/GHSA-abcd-efgh-ijkl" })).toBe(
      "GHSA-ABCD-EFGH-IJKL",
    );
    expect(advisoryIdOf("undici")).toBeNull();
    expect(advisoryIdOf({ url: "https://example.com/x" })).toBeNull();
  });
});

describe("classifyAudit", () => {
  it("allows exactly the listed advisory", () => {
    const decision = classifyAudit(undiciAudit, allow([{}]), NOW);
    expect(decision.blocked).toEqual([]);
    expect(decision.allowed).toHaveLength(1);
    expect(decision.allowed[0]?.name).toBe("undici");
  });

  it("blocks the same package when a new advisory appears", () => {
    const audit = {
      vulnerabilities: {
        undici: {
          severity: "high",
          via: [
            { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" },
            { url: "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx" },
          ],
        },
      },
    };
    const decision = classifyAudit(audit, allow([{}]), NOW);
    expect(decision.blocked).toHaveLength(1);
    expect(decision.blocked[0]?.uncovered_advisories).toEqual(["GHSA-ZZZZ-YYYY-XXXX"]);
  });

  it("blocks an advisory listed for a different package", () => {
    const decision = classifyAudit(undiciAudit, allow([{ package: "other" }]), NOW);
    expect(decision.blocked).toHaveLength(1);
  });

  it("lets a parent vulnerability through only when every child advisory is allowed", () => {
    const audit = {
      vulnerabilities: {
        undici: {
          severity: "high",
          via: [{ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }],
        },
        "@scope/parent": { severity: "moderate", via: ["undici"] },
      },
    };
    const all = classifyAudit(audit, allow([{}]), NOW);
    expect(all.blocked).toEqual([]);
    expect(all.allowed.map((row) => row.name).sort()).toEqual(["@scope/parent", "undici"]);

    const partial = classifyAudit(audit, allow([]), NOW);
    expect(partial.blocked.map((row) => row.name).sort()).toEqual(["@scope/parent", "undici"]);
  });

  it("blocks findings it cannot attribute to an advisory", () => {
    const audit = { vulnerabilities: { mystery: { severity: "high", via: [] } } };
    expect(classifyAudit(audit, allow([]), NOW).blocked).toHaveLength(1);
  });

  it("fails closed on an expired or malformed allow entry", () => {
    expect(() => assertAllowList(allow([{ expires_at: "2026-10-27" }]), NOW)).toThrow(
      /SHIPPING_AUDIT_ALLOW_EXPIRED/,
    );
    expect(() => assertAllowList({ schema: "other", entries: [] }, NOW)).toThrow(
      /SHIPPING_AUDIT_ALLOW_MALFORMED/,
    );
    const broken = allow([{}]);
    delete (broken.entries[0] as Record<string, unknown>).reason;
    expect(() => assertAllowList(broken, NOW)).toThrow(/SHIPPING_AUDIT_ALLOW_MALFORMED/);
  });

  it("passes an empty audit with no findings", () => {
    const decision = classifyAudit({ vulnerabilities: {}, metadata: {} }, allow([]), NOW);
    expect(decision.allowed).toEqual([]);
    expect(decision.blocked).toEqual([]);
  });
});
