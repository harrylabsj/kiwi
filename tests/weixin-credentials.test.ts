/**
 * 微信凭证/游标持久化测试——0600、原子写、损坏 fail-closed。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadCredentials,
  loadSyncState,
  saveCredentials,
  saveSyncState,
} from "../src/weixin/credentials.js";
import { WeixinError } from "../src/weixin/types.js";

const tmpDirs: string[] = [];

function tmpFile(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-wx-cred-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CREDS = {
  ilink_bot_id: "bot-1",
  bot_token: "secret-token",
  base_url: "https://ilinkai.weixin.qq.com",
  ilink_user_id: "wxid_owner",
  saved_at: "2026-08-08T12:00:00Z",
};

describe("credentials persistence", () => {
  it("save → mode 0600 → reload identical", () => {
    const file = tmpFile("creds.json");
    saveCredentials(file, CREDS);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadCredentials(file)).toEqual(CREDS);
  });

  it("atomic write leaves no tmp file", () => {
    const file = tmpFile("creds.json");
    saveCredentials(file, CREDS);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("missing file → not_configured", () => {
    expect(() => loadCredentials(tmpFile("nope.json"))).toThrow(WeixinError);
    try {
      loadCredentials(tmpFile("nope.json"));
    } catch (err) {
      expect((err as WeixinError).code).toBe("not_configured");
    }
  });

  it("corrupt JSON → validation (fail-closed)", () => {
    const file = tmpFile("creds.json");
    writeFileSync(file, "{not json");
    try {
      loadCredentials(file);
      expect.unreachable();
    } catch (err) {
      expect((err as WeixinError).code).toBe("validation");
    }
  });

  it("missing field → validation", () => {
    const file = tmpFile("creds.json");
    writeFileSync(file, JSON.stringify({ ilink_bot_id: "x", bot_token: "y" }));
    expect(() => loadCredentials(file)).toThrow(WeixinError);
  });
});

describe("sync state persistence", () => {
  it("missing → default empty", () => {
    expect(loadSyncState(tmpFile("sync.json"))).toEqual({ get_updates_buf: "", seen: [] });
  });

  it("save → reload roundtrip", () => {
    const file = tmpFile("sync.json");
    saveSyncState(file, { get_updates_buf: "buf-123", seen: ["a", "b"] });
    expect(loadSyncState(file)).toEqual({ get_updates_buf: "buf-123", seen: ["a", "b"] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("corrupt → validation", () => {
    const file = tmpFile("sync.json");
    writeFileSync(file, "garbage");
    expect(() => loadSyncState(file)).toThrow(WeixinError);
  });

  it("wrong shape → validation", () => {
    const file = tmpFile("sync.json");
    writeFileSync(file, JSON.stringify({ get_updates_buf: 42, seen: "x" }));
    expect(() => loadSyncState(file)).toThrow(WeixinError);
  });
});
