/**
 * HandoffIdempotencyStore 测试（KTH rev0.3 §10.1；完成标准 11）。
 *
 * 覆盖：
 * - 幂等键 (candidate_id, candidate_digest)：同键命中 → 返回原 handoff_id；
 * - 不同 digest（同候选）→ 不命中（调用方 fail-closed 的输入）；
 * - 保留期清理（prune 删除过期行）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HandoffIdempotencyStore } from "../src/handoff/index.js";

function store(now: () => string = () => "2026-08-07T00:00:00Z"): HandoffIdempotencyStore {
  return new HandoffIdempotencyStore({
    dir: mkdtempSync(path.join(tmpdir(), "kiwi-idem-")),
    now,
  });
}

describe("HandoffIdempotencyStore", () => {
  it("record + lookup 同键命中", () => {
    const s = store();
    expect(s.lookup("hcan_01", "sha256:abc")).toBeUndefined();
    s.record("hcan_01", "sha256:abc", "hnd_99");
    expect(s.lookup("hcan_01", "sha256:abc")).toEqual({ handoff_id: "hnd_99" });
  });

  it("同候选不同 digest → 不命中（幂等键的 digest 分量生效）", () => {
    const s = store();
    s.record("hcan_01", "sha256:abc", "hnd_99");
    expect(s.lookup("hcan_01", "sha256:def")).toBeUndefined();
  });

  it("prune 清理过期行，保留新行", () => {
    let now = "2026-08-07T00:00:00Z";
    const s = store(() => now);
    s.record("hcan_old", "sha256:old", "hnd_old");
    now = "2026-08-10T00:00:00Z";
    s.record("hcan_new", "sha256:new", "hnd_new");
    now = "2026-08-20T00:00:00Z"; // 距 old 13 天（>7 天），距 new 10 天（>7 天）
    const pruned = s.prune();
    expect(pruned).toBe(2);
    expect(s.lookup("hcan_old", "sha256:old")).toBeUndefined();
    expect(s.lookup("hcan_new", "sha256:new")).toBeUndefined();
  });

  it("保留期内不清理", () => {
    let now = "2026-08-07T00:00:00Z";
    const s = store(() => now);
    s.record("hcan_01", "sha256:abc", "hnd_01");
    now = "2026-08-10T00:00:00Z"; // 3 天后
    expect(s.prune()).toBe(0);
    expect(s.lookup("hcan_01", "sha256:abc")).toEqual({ handoff_id: "hnd_01" });
  });
});
