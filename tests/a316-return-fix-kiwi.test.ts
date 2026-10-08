/**
 * A316 返修合成测试（kiwi 侧）：仅覆盖本轮返修的原失败编号。
 * P1-3 真 CAS（全快照保护 + expected revision 强比较）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  CatalogPipelineError,
  saveWorkbuddyEnrollment,
} from "../src/cloud/onboarding/catalog-pipeline.js";
import { readEnrollmentStore } from "../src/cloud/binding/enrollment-challenge.js";

const dirs: string[] = [];
afterAll(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "a316-cas-"));
  dirs.push(d);
  return d;
}

function sampleState(enrollmentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enrollment_id: enrollmentId,
    runtime_origin: "https://merchant.example",
    key_thumbprint: `sha256:${"a".repeat(64)}`,
    catalog_origin: "https://catalog.example",
    catalog_agent_id: "cagt_a316",
    merchant_id: "merchant_a316",
    binding_id: "binding_a316",
    device_code: "D".repeat(48),
    user_code: "A316-CODE",
    verification_uri: "https://catalog.example/portal/connect/a316",
    interval: 5,
    preview_digest: `sha256:${"b".repeat(64)}`,
    frozen_card: {},
    status: "awaiting_confirmation",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    owner_ref: "record_a316",
    ...overrides,
  };
}

function findSession(dir: string, id: string): { status?: string; store_revision?: number } | undefined {
  return readEnrollmentStore(dir).sessions.find(
    (s) => s.enrollment_id === id,
  ) as unknown as { status?: string; store_revision?: number } | undefined;
}

describe("P1-3 返修：enrollment store 真 CAS（全快照保护）", () => {
  it("期望 revision 匹配 → 保存成功且 revision 递增", () => {
    const dir = tempDir();
    const state = sampleState("enr_cas_1");
    saveWorkbuddyEnrollment(dir, state as never, undefined); // 新建（期望不存在）
    expect(findSession(dir, "enr_cas_1")?.store_revision).toBe(1);
    saveWorkbuddyEnrollment(dir, { ...state, status: "authorized" } as never, 1);
    const after = findSession(dir, "enr_cas_1");
    expect(after?.store_revision).toBe(2);
    expect(after?.status).toBe("authorized");
  });

  it("他人新增会话在本写者保存后不丢（全快照保护）", () => {
    const dir = tempDir();
    saveWorkbuddyEnrollment(dir, sampleState("enr_cas_keep") as never, undefined);
    // 本写者用旧快照保存（会 CAS 失败），但另一会话已由他人写入
    saveWorkbuddyEnrollment(dir, sampleState("enr_other") as never, undefined);
    // 旧快照写 enr_cas_keep（期望 revision 1，实际已 1 → 匹配？——首次保存后 rev=1，
    // 本写者快照仍是 undefined→期望「不存在」→ 与实际 rev=1 不匹配 → CAS 拒绝）
    expect(() =>
      saveWorkbuddyEnrollment(dir, sampleState("enr_cas_keep") as never, undefined),
    ).toThrow(CatalogPipelineError);
    // 他人写入的会话必须仍在（fresh 全快照保护）
    expect(findSession(dir, "enr_other")).toBeDefined();
    expect(findSession(dir, "enr_cas_keep")?.store_revision).toBe(1);
  });

  it("期望 revision 过期（他人已推进）→ STATE_CAS_CONFLICT，不覆盖", () => {
    const dir = tempDir();
    const state = sampleState("enr_cas_2");
    saveWorkbuddyEnrollment(dir, state as never, undefined);
    // 另一写者推进（模拟 challenge responder / connect-service persist）
    saveWorkbuddyEnrollment(dir, { ...state, status: "authorized" } as never, 1);
    // 陈旧快照（revision 1）写入：必须拒绝，不能整文件回写覆盖他人推进
    const stale = { ...(state as Record<string, unknown>), status: "published" } as never;
    expect(() => saveWorkbuddyEnrollment(dir, stale, 1)).toThrow(CatalogPipelineError);
    try {
      saveWorkbuddyEnrollment(dir, stale, 1);
    } catch (err) {
      expect((err as CatalogPipelineError).code).toBe("STATE_CAS_CONFLICT");
    }
    const current = findSession(dir, "enr_cas_2");
    expect(current?.status).toBe("authorized");
    expect(current?.store_revision).toBe(2);
  });

  it("期望存在但实际不存在（乐观写无快照）→ 拒绝且不落盘", () => {
    const dir = tempDir();
    expect(() => saveWorkbuddyEnrollment(dir, sampleState("enr_cas_3") as never, 7)).toThrow(
      CatalogPipelineError,
    );
    expect(findSession(dir, "enr_cas_3")).toBeUndefined();
  });
});
