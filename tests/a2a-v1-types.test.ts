/**
 * A2A v1 域模型测试（issue 02）：统一 Part 字段存在性判别、TaskState 全集、
 * Role 常量、词表单一来源。
 */
import { describe, expect, it } from "vitest";
import {
  A2A_TASK_STATES,
  ROLE_AGENT,
  ROLE_USER,
  type A2ATaskState,
  type A2AV1Part,
} from "../src/a2a/v1/types.js";

describe("A2A v1 types（issue 02）", () => {
  it("TaskState 全集为大写下划线枚举（含 1.0 新增 REJECTED/AUTH_REQUIRED/UNSPECIFIED）", () => {
    expect(A2A_TASK_STATES).toEqual([
      "SUBMITTED",
      "WORKING",
      "INPUT_REQUIRED",
      "COMPLETED",
      "CANCELED",
      "FAILED",
      "REJECTED",
      "AUTH_REQUIRED",
      "UNSPECIFIED",
    ]);
    // 1.0 新增状态在列；0.3 的 `unknown` 语义由 `UNSPECIFIED` 承接。
    expect(A2A_TASK_STATES).toContain("REJECTED");
    expect(A2A_TASK_STATES).toContain("AUTH_REQUIRED");
    expect(A2A_TASK_STATES).toContain("UNSPECIFIED");
    expect(A2A_TASK_STATES).not.toContain("unknown");
  });

  it("Role 常量为 agent / user", () => {
    expect(ROLE_AGENT).toBe("agent");
    expect(ROLE_USER).toBe("user");
  });

  it("统一 Part 用字段存在性判别（无 kind 字段）", () => {
    const byField = (part: A2AV1Part): string => {
      if ("text" in part) return "text";
      if ("data" in part) return "data";
      if ("url" in part) return "url";
      if ("raw" in part) return "raw";
      return "unknown";
    };
    const text: A2AV1Part = { text: "hi" };
    const data: A2AV1Part = { data: { knp_envelope: {} }, mediaType: "application/json" };
    const url: A2AV1Part = { url: "https://x.example/f" };
    const file: A2AV1Part = { raw: "aGVsbG8=", mediaType: "text/plain" };
    expect(byField(text)).toBe("text");
    expect(byField(data)).toBe("data");
    expect(byField(url)).toBe("url");
    expect(byField(file)).toBe("raw");
  });

  it("类型编译：A2ATaskState 覆盖枚举成员", () => {
    const state: A2ATaskState = "UNSPECIFIED";
    expect(state).toBe("UNSPECIFIED");
  });
});
