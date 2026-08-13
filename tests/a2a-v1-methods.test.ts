/**
 * A2A v1 方法名测试（issue 03）：方法名常量、v1↔legacy 双向映射、判别函数。
 */
import { describe, expect, it } from "vitest";
import {
  isLegacyMethod,
  isV1Method,
  LEGACY_METHODS,
  LEGACY_TO_V1,
  METHOD_CANCEL_TASK,
  METHOD_GET_TASK,
  METHOD_LIST_TASKS,
  METHOD_SEND_MESSAGE,
  METHOD_SUBSCRIBE_TO_TASK,
  V1_METHODS,
  V1_TO_LEGACY,
} from "../src/a2a/v1/methods.js";

describe("A2A v1 methods（issue 03）", () => {
  it("1.0 方法名常量覆盖 SendMessage/GetTask/ListTasks/CancelTask/SubscribeToTask", () => {
    expect(METHOD_SEND_MESSAGE).toBe("SendMessage");
    expect(METHOD_GET_TASK).toBe("GetTask");
    expect(METHOD_LIST_TASKS).toBe("ListTasks");
    expect(METHOD_CANCEL_TASK).toBe("CancelTask");
    expect(METHOD_SUBSCRIBE_TO_TASK).toBe("SubscribeToTask");
  });

  it("v1↔legacy 映射双向一致", () => {
    expect(V1_TO_LEGACY[METHOD_SEND_MESSAGE]).toBe("message/send");
    expect(V1_TO_LEGACY[METHOD_GET_TASK]).toBe("tasks/get");
    // 反向映射完整覆盖正向（无遗漏/无多余）。
    expect(LEGACY_TO_V1["message/send"]).toBe(METHOD_SEND_MESSAGE);
    expect(LEGACY_TO_V1["tasks/get"]).toBe(METHOD_GET_TASK);
    for (const [v1, legacy] of Object.entries(V1_TO_LEGACY)) {
      expect(LEGACY_TO_V1[legacy]).toBe(v1);
    }
    for (const [legacy, v1] of Object.entries(LEGACY_TO_V1)) {
      expect(V1_TO_LEGACY[v1]).toBe(legacy);
    }
  });

  it("集合与判别函数一致", () => {
    expect(V1_METHODS.has("SendMessage")).toBe(true);
    expect(LEGACY_METHODS.has("message/send")).toBe(true);
    expect(isV1Method("SendMessage")).toBe(true);
    expect(isV1Method("message/send")).toBe(false);
    expect(isLegacyMethod("message/send")).toBe(true);
    expect(isLegacyMethod("GetTask")).toBe(false);
  });
});
