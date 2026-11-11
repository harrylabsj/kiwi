/**
 * 本地接入方式文件的升级/回滚兼容。
 *
 * 文件仍是 version 1、只含 `mode` 与可选非凭据 `catalog` 元数据；旧二进制
 * 读取时忽略未知 `catalog` 字段并继续按 mode 工作，因此回滚不会丢失模式。
 * 损坏的 catalog 元数据只丢弃元数据，不改变本地 mode，也不删除文件。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  accessModePath,
  readAccessMode,
  writeAccessMode,
} from "../src/cloud/access/access-mode.js";

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "access-mode-sync-file-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("merchant-access-mode.json 升级/回滚", () => {
  it("旧 v1 文件（只有 mode）按未同步读取", () => {
    const dir = makeDir();
    writeFileSync(accessModePath(dir), JSON.stringify({ version: 1, mode: "share_code" }));
    expect(readAccessMode(dir)).toEqual({
      mode: "share_code",
      persisted: true,
      invalid: false,
    });
  });

  it("写入 catalog 元数据后仍保留 version 1，旧二进制可只读 mode", () => {
    const dir = makeDir();
    writeAccessMode(dir, "no_share_code", {
      mode: "no_share_code",
      revision: 4,
      syncedAt: "2026-11-11T00:00:00Z",
    });
    const parsed = JSON.parse(readFileSync(accessModePath(dir), "utf8")) as {
      version: number;
      mode: string;
      catalog: { mode: string; revision: number };
    };
    // 旧版本只检查 version/mode；额外 catalog 字段不影响它。
    expect(parsed.version).toBe(1);
    expect(parsed.mode).toBe("no_share_code");
    expect(parsed.catalog).toMatchObject({ mode: "no_share_code", revision: 4 });
    expect(readAccessMode(dir)).toMatchObject({
      mode: "no_share_code",
      catalog: { mode: "no_share_code", revision: 4 },
    });
  });

  it("写模式但不传 catalog 时保留已有 revision（目录离线改模式仍可 CAS 重试）", () => {
    const dir = makeDir();
    writeAccessMode(dir, "auto", {
      mode: "auto",
      revision: 7,
      syncedAt: "2026-11-11T00:00:00Z",
    });
    writeAccessMode(dir, "share_code");
    expect(readAccessMode(dir)).toMatchObject({
      mode: "share_code",
      catalog: { mode: "auto", revision: 7 },
    });
  });

  it("损坏的 catalog 元数据只丢弃元数据，不改变 mode 也不删除文件", () => {
    const dir = makeDir();
    const file = accessModePath(dir);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, mode: "no_share_code", catalog: { mode: "bogus", revision: -1 } }),
    );
    expect(readAccessMode(dir)).toEqual({
      mode: "no_share_code",
      persisted: true,
      invalid: false,
    });
    expect(readFileSync(file, "utf8")).toContain("bogus");
  });
});
