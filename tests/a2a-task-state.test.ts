/**
 * A2A Task 生命周期状态机测试（基线 §18.3 / 子规范 §23）。
 *
 * 覆盖：
 *  - 六态合法转换路径与终态不可回退；
 *  - 未知状态 fail-closed（`unknown` 源/目标一律拒绝，不猜测）；
 *  - 非法转换拒绝（如 completed → working）；
 *  - 同状态 no-op（轮询重观察合法）；
 *  - TaskLifecycleTracker 首观察 / 后续观察 / 终态判定。
 */
import { describe, expect, it } from "vitest";
import {
  isTerminalTaskState,
  TaskLifecycleTracker,
  TaskStateError,
  transitionTaskState,
} from "../src/a2a/task/index.js";

describe("transitionTaskState", () => {
  it("accepts legal A2A transitions", () => {
    expect(transitionTaskState("submitted", "working")).toBe("working");
    expect(transitionTaskState("submitted", "input-required")).toBe("input-required");
    expect(transitionTaskState("working", "input-required")).toBe("input-required");
    expect(transitionTaskState("input-required", "working")).toBe("working");
    expect(transitionTaskState("working", "completed")).toBe("completed");
    expect(transitionTaskState("submitted", "canceled")).toBe("canceled");
    expect(transitionTaskState("working", "failed")).toBe("failed");
  });

  it("treats same-state observation as a legal no-op", () => {
    expect(transitionTaskState("working", "working")).toBe("working");
    expect(transitionTaskState("completed", "completed")).toBe("completed");
    expect(transitionTaskState("submitted", "submitted")).toBe("submitted");
  });

  it("rejects transitions out of a terminal state (fail-closed)", () => {
    expect(() => transitionTaskState("completed", "working")).toThrowError(TaskStateError);
    expect(() => transitionTaskState("canceled", "submitted")).toThrowError(TaskStateError);
    expect(() => transitionTaskState("failed", "working")).toThrowError(TaskStateError);
    expect(() => transitionTaskState("completed", "input-required")).toThrowError(TaskStateError);
  });

  it("rejects illegal forward transitions", () => {
    // input-required 不能回 submitted；submitted 不能直接…（submitted→working 合法）
    expect(() => transitionTaskState("input-required", "submitted")).toThrowError(TaskStateError);
    expect(() => transitionTaskState("working", "submitted")).toThrowError(TaskStateError);
  });

  it("rejects unknown states on either side (fail-closed, no guessing)", () => {
    expect(() => transitionTaskState("unknown", "working")).toThrowError(/unknown/i);
    expect(() => transitionTaskState("working", "unknown")).toThrowError(/unknown/i);
    expect(() => transitionTaskState("unknown", "unknown")).toThrowError(/unknown/i);
  });

  it("distinguishes error codes", () => {
    try {
      transitionTaskState("completed", "working");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TaskStateError);
      expect((err as TaskStateError).code).toBe("illegal_transition");
    }
    try {
      transitionTaskState("working", "unknown");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as TaskStateError).code).toBe("unknown_state");
    }
  });
});

describe("isTerminalTaskState", () => {
  it("classifies the three terminal states", () => {
    expect(isTerminalTaskState("completed")).toBe(true);
    expect(isTerminalTaskState("canceled")).toBe(true);
    expect(isTerminalTaskState("failed")).toBe(true);
    expect(isTerminalTaskState("working")).toBe(false);
    expect(isTerminalTaskState("submitted")).toBe(false);
    expect(isTerminalTaskState("input-required")).toBe(false);
    expect(isTerminalTaskState("unknown")).toBe(false);
    expect(isTerminalTaskState(undefined)).toBe(false);
  });
});

describe("TaskLifecycleTracker", () => {
  it("accepts the first observation of any real state", () => {
    const tracker = new TaskLifecycleTracker();
    expect(tracker.current()).toBeNull();
    expect(tracker.observe("working")).toBe("working");
    expect(tracker.current()).toBe("working");
  });

  it("rejects an unknown first observation", () => {
    const tracker = new TaskLifecycleTracker();
    expect(() => tracker.observe("unknown")).toThrowError(/unknown/i);
    expect(tracker.current()).toBeNull();
  });

  it("tracks a legal working → input-required → working → completed journey", () => {
    const tracker = new TaskLifecycleTracker();
    expect(tracker.observe("submitted")).toBe("submitted");
    expect(tracker.observe("working")).toBe("working");
    expect(tracker.observe("input-required")).toBe("input-required");
    expect(tracker.observe("working")).toBe("working");
    expect(tracker.observe("completed")).toBe("completed");
    expect(tracker.isTerminal()).toBe(true);
  });

  it("rejects an illegal backward jump (completed → working)", () => {
    const tracker = new TaskLifecycleTracker();
    tracker.observe("working");
    tracker.observe("completed");
    expect(() => tracker.observe("working")).toThrowError(TaskStateError);
    // fail-closed：状态保持在 completed，绝不回退。
    expect(tracker.current()).toBe("completed");
    expect(tracker.isTerminal()).toBe(true);
  });

  it("allows same-state re-observation (polling) without a transition error", () => {
    const tracker = new TaskLifecycleTracker();
    tracker.observe("working");
    expect(tracker.observe("working")).toBe("working");
    expect(tracker.current()).toBe("working");
  });
});
