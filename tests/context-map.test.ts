/**
 * negotiation_id ↔ remote contextId 持久化映射测试（基线 §9.2 / §24.4–§24.5）。
 *
 * 覆盖：
 *  - 写入 / 读取 / 覆盖 remote_context_id；
 *  - addTask 追加 taskId 列表（去重，首个 task 创建映射）；
 *  - 重启还原（同一数据目录新 store）；
 *  - 目录 0700 / 文件 0600 权限与原子写；
 *  - opaque 校验：远端 contextId 只做结构校验，不解析不推断；
 *  - 文件损坏 fail-closed（ContextMapError）；
 *  - negotiation_id 逃逸目录被拒。
 */
import { afterEach, describe, expect, it } from "vitest";
import {existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextMapError, ContextMapStore, contextMapFileName } from "../src/negotiation/context-map/index.js";

const NOW = "2026-08-06T10:00:00.000Z";

function makeDir(): string {
  return trackedMkdtemp("kiwi-context-map-");
}

describe("ContextMapStore: 写入与读取", () => {
  it("persists a remote_context_id for a negotiation", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      const created = store.set("neg_1", { remote_context_id: "ctx_remote_1" });
      expect(created).toEqual({
        negotiation_id: "neg_1",
        remote_context_id: "ctx_remote_1",
        task_ids: [],
        updated_at: NOW,
      });

      const loaded = store.get("neg_1");
      expect(loaded?.remote_context_id).toBe("ctx_remote_1");
      expect(loaded?.task_ids).toEqual([]);
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("adds taskIds and keeps the remote contextId across updates", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      store.set("neg_2", { remote_context_id: "ctx_a" });
      const first = store.addTask("neg_2", "task_1");
      expect(first.task_ids).toEqual(["task_1"]);
      expect(first.remote_context_id).toBe("ctx_a");

      const second = store.addTask("neg_2", "task_2");
      expect(second.task_ids).toEqual(["task_1", "task_2"]);

      // 重复 addTask 去重。
      const third = store.addTask("neg_2", "task_1");
      expect(third.task_ids).toEqual(["task_1", "task_2"]);
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("allows a mapping with only taskIds (no context yet)", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      const m = store.addTask("neg_3", "task_9");
      expect(m.remote_context_id).toBeUndefined();
      expect(m.task_ids).toEqual(["task_9"]);
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("restores mappings after a restart (same data dir)", () => {
    const dir = makeDir();
    try {
      const first = new ContextMapStore({ dir, now: () => NOW });
      first.set("neg_4", { remote_context_id: "ctx_persisted" });
      first.addTask("neg_4", "task_persist");

      // 模拟重启：同目录新 store，内存全空。
      const second = new ContextMapStore({ dir, now: () => NOW });
      const restored = second.get("neg_4");
      expect(restored?.remote_context_id).toBe("ctx_persisted");
      expect(restored?.task_ids).toEqual(["task_persist"]);
      expect(second.list().map((m) => m.negotiation_id)).toContain("neg_4");
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("writes the mapping file with 0600 and dir with 0700", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      store.set("neg_perm", { remote_context_id: "ctx" });
      const file = path.join(dir, "context-map", contextMapFileName("neg_perm"));
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, "context-map")).mode & 0o777).toBe(0o700);
      // 原子写不残留临时文件。
      expect(existsSync(`${file}.tmp-`)).toBe(false);
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("is corrupt fail-closed when the file is malformed", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      store.set("neg_bad", { remote_context_id: "ctx" });
      const file = path.join(dir, "context-map", contextMapFileName("neg_bad"));
      writeFileSync(file, "{ not json");

      expect(() => store.get("neg_bad")).toThrowError(ContextMapError);
      expect(() => store.get("neg_bad")).toThrowError(/not valid JSON/);
      // list() 同样 fail-closed，绝不返回残缺映射。
      expect(() => store.list()).toThrowError(ContextMapError);
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("rejects invalid opaque identifiers fail-closed", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      // remote_context_id 必须是非空无控制字符的 opaque 字符串。
      expect(() => store.set("neg_ok", { remote_context_id: "" })).toThrow();
      expect(() => store.set("neg_ok", { remote_context_id: "  " })).toThrow();
      // taskId 同样。
      expect(() => store.addTask("neg_ok", "")).toThrow();
      // negotiation_id 含路径分隔符：文件名被归一化（不逃逸目录），读写保持一致，
      // 不会把文件写到 context-map/ 之外。
      const escaped = store.set("../escape", { remote_context_id: "x" });
      expect(escaped.negotiation_id).toBe("../escape");
      expect(store.get("../escape")?.remote_context_id).toBe("x");
      // 没有逃逸到父目录：context-map/ 之外的任何 json 文件都不存在。
      const parentFiles = readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(parentFiles).toEqual([]);
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("returns null for an unknown negotiation", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      expect(store.get("neg_missing")).toBeNull();
      expect(store.has("neg_missing")).toBe(false);
    } finally {
      // 清理交给系统临时目录
    }
  });

  it("stores the raw opaque contextId verbatim (no parsing/inference)", () => {
    const dir = makeDir();
    try {
      const store = new ContextMapStore({ dir, now: () => NOW });
      // 任意 opaque 字符串都原样保存；文件内容与传入值逐字节一致。
      const opaque = "urn:ctx:merchant-01/session/2026/ab-09 复杂 opaque 值";
      store.set("neg_opaque", { remote_context_id: opaque });
      const file = path.join(dir, "context-map", contextMapFileName("neg_opaque"));
      const raw = readFileSync(file, "utf-8");
      expect(raw).toContain(opaque);
    } finally {
      // 清理交给系统临时目录
    }
  });
});

/** 评审项 L6：mkdtemp 目录跟踪清理（此前每次运行在 /tmp 残留）。 */
const tmpDirs: string[] = [];
function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
