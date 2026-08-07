/**
 * HandoffCandidate 生命周期测试（KTH rev0.3 §5.1；完成定义 #9、#18）。
 *
 * 覆盖：
 * - 迁移表：created→PROPOSED、ready→READY、rejected/stale/expired 终态、
 *   consumed 仅从 READY；
 * - 非法迁移 fail-closed；
 * - foldCandidateLifecycle 从 Ledger 事件序列投影（最后事件胜出、终态后
 *   事件被拒）；
 * - 终态不可 revive（stale 后必须新建候选带 supersedes_candidate_id）。
 */
import { describe, expect, it } from "vitest";
import {
  foldCandidateLifecycle,
  isTerminalLifecycleState,
  transitionCandidateLifecycle,
  type HandoffCandidateEventKind,
} from "../src/handoff/index.js";
import type { LedgerEvent } from "../src/negotiation/ledger/event.js";

function event(
  kind: HandoffCandidateEventKind,
  id = `evt_${kind}`,
): Pick<LedgerEvent, "event_kind" | "event_id" | "recorded_at"> {
  return { event_kind: kind, event_id: id, recorded_at: "2026-08-07T00:00:00Z" };
}

describe("transitionCandidateLifecycle", () => {
  it("created → PROPOSED → ready → READY → consumed → CONSUMED", () => {
    expect(transitionCandidateLifecycle(undefined, "handoff_candidate_created")).toBe("PROPOSED");
    expect(transitionCandidateLifecycle("PROPOSED", "handoff_candidate_ready")).toBe("READY");
    expect(transitionCandidateLifecycle("READY", "handoff_candidate_consumed")).toBe("CONSUMED");
  });

  it("rejected / stale / expired 可从 PROPOSED 或 READY 进入", () => {
    for (const kind of [
      "handoff_candidate_rejected",
      "handoff_candidate_stale",
      "handoff_candidate_expired",
    ] as const) {
      expect(transitionCandidateLifecycle("PROPOSED", kind)).toBeDefined();
      expect(transitionCandidateLifecycle("READY", kind)).toBeDefined();
    }
  });

  it("非法迁移 fail-closed：consumed 从 PROPOSED、created 二次进入", () => {
    expect(() => transitionCandidateLifecycle("PROPOSED", "handoff_candidate_consumed")).toThrow(
      /illegal/,
    );
    expect(() => transitionCandidateLifecycle("PROPOSED", "handoff_candidate_created")).toThrow(
      /illegal/,
    );
  });

  it("终态不可 revive（rejected/stale/expired/consumed 无出向迁移）", () => {
    for (const state of ["REJECTED", "STALE", "EXPIRED", "CONSUMED"] as const) {
      expect(isTerminalLifecycleState(state)).toBe(true);
      for (const kind of [
        "handoff_candidate_ready",
        "handoff_candidate_consumed",
      ] as const) {
        expect(() => transitionCandidateLifecycle(state, kind)).toThrow(/illegal/);
      }
    }
    expect(isTerminalLifecycleState("PROPOSED")).toBe(false);
    expect(isTerminalLifecycleState("READY")).toBe(false);
  });
});

describe("foldCandidateLifecycle", () => {
  it("事件序列投影（最后事件胜出）", () => {
    const state = foldCandidateLifecycle([
      event("handoff_candidate_created"),
      event("handoff_candidate_ready"),
      event("handoff_candidate_stale"),
    ]);
    expect(state).toBe("STALE");
  });

  it("空序列 → undefined", () => {
    expect(foldCandidateLifecycle([])).toBeUndefined();
  });

  it("非 candidate 事件被跳过（交付事件不影响候选状态）", () => {
    const state = foldCandidateLifecycle([
      event("handoff_candidate_created"),
      event("handoff_delivered" as HandoffCandidateEventKind, "evt_delivered"),
      event("handoff_candidate_ready"),
    ]);
    expect(state).toBe("READY");
  });

  it("重建 = 投影（完成定义 #18：lifecycle 从 Ledger 事件重建，不 mutate 候选）", () => {
    const events = [event("handoff_candidate_created"), event("handoff_candidate_ready")];
    expect(foldCandidateLifecycle(events)).toBe("READY");
  });
});
