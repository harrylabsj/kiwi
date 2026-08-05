/**
 * Operator event store tests (design §6, §14): append-only persistence,
 * 0600 file permissions, secret redaction, fail-closed corruption handling.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileOperatorEventStore,
  InMemoryOperatorEventStore,
  OperatorStoreError,
} from "../src/operator/store.js";
import type { OperatorEvent } from "../src/operator/types.js";
import { NOW } from "./helpers.js";

function sampleEvent(id: string, text: string): OperatorEvent {
  return {
    event_id: id,
    occurred_at: NOW,
    agent_id: "merchant-agent:merchant-001",
    role: "merchant",
    origin: "local_tui",
    visibility: "private",
    type: "operator.message",
    payload: { text },
  };
}

describe("InMemoryOperatorEventStore", () => {
  it("round-trips appended events in order", async () => {
    const store = new InMemoryOperatorEventStore();
    await store.append(sampleEvent("evt-1", "先争取包邮"));
    await store.append(sampleEvent("evt-2", "最多买 2 件"));
    const events = await store.readAll();
    expect(events.map((e) => e.event_id)).toEqual(["evt-1", "evt-2"]);
  });

  it("refuses events carrying secret-like values", async () => {
    const store = new InMemoryOperatorEventStore();
    const evil = {
      ...sampleEvent("evt-1", "hi"),
      payload: { text: "hi", api_key: "sk-live-123" },
    } as unknown as OperatorEvent;
    await expect(store.append(evil)).rejects.toThrow(OperatorStoreError);
    expect(await store.readAll()).toEqual([]);
  });
});

describe("FileOperatorEventStore", () => {
  it("persists JSONL with 0600 permissions and reloads it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      const store = new FileOperatorEventStore(dir);
      await store.append(sampleEvent("evt-1", "先争取包邮"));
      await store.append(sampleEvent("evt-2", "最多买 2 件"));
      const file = path.join(dir, "operator-events.jsonl");
      expect(statSync(file).mode & 0o777).toBe(0o600);

      const reloaded = await new FileOperatorEventStore(dir).readAll();
      expect(reloaded.map((e) => e.event_id)).toEqual(["evt-1", "evt-2"]);
      expect(reloaded[0]?.type).toBe("operator.message");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to load an event with an unknown type (fail closed)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      const store = new FileOperatorEventStore(dir);
      await store.append(sampleEvent("evt-1", "先争取包邮"));
      const file = path.join(dir, "operator-events.jsonl");
      const unknown = { ...sampleEvent("evt-2", "hi"), type: "some.future.type" };
      writeFileSync(file, `${readFileSync(file, "utf8").trimEnd()}\n${JSON.stringify(unknown)}\n`);
      await expect(store.readAll()).rejects.toThrow(/unknown type/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads an empty log for a missing file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      expect(await new FileOperatorEventStore(dir).readAll()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a corrupted log", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      writeFileSync(path.join(dir, "operator-events.jsonl"), "not json\n", { mode: 0o600 });
      await expect(new FileOperatorEventStore(dir).readAll()).rejects.toThrow(OperatorStoreError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a structurally invalid event line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      writeFileSync(path.join(dir, "operator-events.jsonl"), '{"foo":1}\n', { mode: 0o600 });
      await expect(new FileOperatorEventStore(dir).readAll()).rejects.toThrow(OperatorStoreError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to persist Bearer tokens and writes nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      const store = new FileOperatorEventStore(dir);
      await expect(store.append(sampleEvent("evt-1", "here: Bearer abc.def.ghi"))).rejects.toThrow(
        OperatorStoreError,
      );
      expect(existsSync(path.join(dir, "operator-events.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces 0700/0600 on a pre-existing directory and log file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      // Simulate paths left behind by another tool with loose permissions.
      chmodSync(dir, 0o755);
      const file = path.join(dir, "operator-events.jsonl");
      writeFileSync(file, "");
      chmodSync(file, 0o644);
      const store = new FileOperatorEventStore(dir);
      await store.append(sampleEvent("evt-1", "先争取包邮"));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses sk- and shopping-token-shaped credential values", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operator-store-"));
    try {
      const store = new FileOperatorEventStore(dir);
      await expect(store.append(sampleEvent("evt-1", "key: sk-abc123XYZ_456"))).rejects.toThrow(
        OperatorStoreError,
      );
      await expect(
        store.append(sampleEvent("evt-2", "token shopping_agent_token_9f8e7d6c")),
      ).rejects.toThrow(OperatorStoreError);
      // Nothing was persisted for either attempt.
      expect(existsSync(path.join(dir, "operator-events.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("in-memory store rejects credential-shaped values too", async () => {
    const store = new InMemoryOperatorEventStore();
    await expect(store.append(sampleEvent("evt-1", "sk-livekey-999888"))).rejects.toThrow(
      OperatorStoreError,
    );
    expect(await store.readAll()).toEqual([]);
  });
});
