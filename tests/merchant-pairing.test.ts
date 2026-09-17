/**
 * 实例侧一次性配对码（§8.4 第二期）测试。
 *
 * 语义要求：一次性、短 TTL、只存摘要（0600）、重新生成即覆盖旧码、
 * 过期即清理；明文只在生成时返回一次。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPairingCode,
  DEFAULT_PAIRING_TTL_MS,
  issuePairedCredential,
  matchesPairedCredential,
  PAIRED_CREDENTIAL_FILE,
  PAIRING_FILE,
  readPairedCredentialDigest,
  readPairingState,
  redeemPairingCode,
  revokePairedCredential,
} from "../src/auth/merchant-pairing.js";
import {
  CompositeMerchantMcpVerifier,
  PairedCredentialVerifier,
  StaticBearerTokenVerifier,
} from "../src/mcp/merchant-auth.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-pairing-"));
  dirs.push(dir);
  return dir;
}

describe("配对码生成", () => {
  it("生成可读格式的码，文件只存摘要且 0600", () => {
    const dir = tempDir();
    const { code, expiresAt } = createPairingCode(dir);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const file = path.join(dir, PAIRING_FILE);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(code.replaceAll("-", ""));
    expect(JSON.parse(raw).code_digest).toMatch(/^[0-9a-f]{64}$/);
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(DEFAULT_PAIRING_TTL_MS - 5_000);
  });

  it("重新生成即覆盖旧码", () => {
    const dir = tempDir();
    const first = createPairingCode(dir);
    const second = createPairingCode(dir);
    expect(second.code).not.toBe(first.code);
    expect(redeemPairingCode(dir, first.code)).toBe(false);
    expect(redeemPairingCode(dir, second.code)).toBe(true);
  });

  it("大小写与空格不敏感（手抄容错）", () => {
    const dir = tempDir();
    const { code } = createPairingCode(dir);
    expect(redeemPairingCode(dir, ` ${code.toLowerCase()} `)).toBe(true);
  });
});

describe("配对码兑换", () => {
  it("兑换成功即作废（单次）", () => {
    const dir = tempDir();
    const { code } = createPairingCode(dir);
    expect(redeemPairingCode(dir, code)).toBe(true);
    expect(redeemPairingCode(dir, code)).toBe(false);
    expect(readPairingState(dir)).toBeUndefined();
  });

  it("错误码不动状态（仍可在有效期内重试）", () => {
    const dir = tempDir();
    const { code } = createPairingCode(dir);
    expect(redeemPairingCode(dir, "AAAA-BBBB-CCCC")).toBe(false);
    expect(readPairingState(dir)).toBeDefined();
    expect(redeemPairingCode(dir, code)).toBe(true);
  });

  it("过期后失效并被清理", () => {
    const dir = tempDir();
    const created = new Date("2026-09-17T10:00:00.000Z");
    const { code } = createPairingCode(dir, { now: () => created, ttlMs: 60_000 });
    const later = new Date(created.getTime() + 61_000);
    expect(readPairingState(dir, { now: () => later })).toBeUndefined();
    expect(redeemPairingCode(dir, code, { now: () => later })).toBe(false);
    expect(readPairingState(dir, { now: () => later })).toBeUndefined();
  });

  it("无码/坏文件时一律失败（fail-closed）", () => {
    const dir = tempDir();
    expect(redeemPairingCode(dir, "AAAA-BBBB-CCCC")).toBe(false);
    expect(readPairingState(dir)).toBeUndefined();
    writeFileSync(path.join(dir, PAIRING_FILE), "{ not json }", { mode: 0o600 });
    expect(redeemPairingCode(dir, "AAAA-BBBB-CCCC")).toBe(false);
    expect(readPairingState(dir)).toBeUndefined();
  });
});

describe("配对凭据（最小授权：实例签发、网关持有）", () => {
  it("签发后只存摘要（0600），明文只返回一次", () => {
    const dir = tempDir();
    const { credential } = issuePairedCredential(dir);
    expect(credential.startsWith("pair_")).toBe(true);
    const file = path.join(dir, PAIRED_CREDENTIAL_FILE);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(credential);
    expect(JSON.parse(raw).credential_digest).toBe(readPairedCredentialDigest(dir));
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(matchesPairedCredential(dir, credential)).toBe(true);
    expect(matchesPairedCredential(dir, "pair_not-the-credential")).toBe(false);
  });

  it("重配对即轮换：旧凭据立即失效（单槽）", () => {
    const dir = tempDir();
    const first = issuePairedCredential(dir);
    const second = issuePairedCredential(dir);
    expect(second.credential).not.toBe(first.credential);
    expect(matchesPairedCredential(dir, first.credential)).toBe(false);
    expect(matchesPairedCredential(dir, second.credential)).toBe(true);
  });

  it("吊销后不再匹配；无凭据时一律不匹配", () => {
    const dir = tempDir();
    expect(matchesPairedCredential(dir, "pair_anything")).toBe(false);
    const { credential } = issuePairedCredential(dir);
    expect(revokePairedCredential(dir)).toBe(true);
    expect(matchesPairedCredential(dir, credential)).toBe(false);
    expect(revokePairedCredential(dir)).toBe(false);
  });
});

describe("实例侧校验器组合", () => {
  it("静态令牌与配对凭据并存：任一通过即放行，其它一律拒绝", () => {
    const dir = tempDir();
    const { credential } = issuePairedCredential(dir);
    const verifier = new CompositeMerchantMcpVerifier([
      new StaticBearerTokenVerifier("static-token"),
      new PairedCredentialVerifier(dir),
    ]);
    expect(verifier.verify({ authorizationHeader: "Bearer static-token" }).ok).toBe(true);
    expect(verifier.verify({ authorizationHeader: `Bearer ${credential}` }).ok).toBe(true);
    expect(verifier.verify({ authorizationHeader: "Bearer nope" }).ok).toBe(false);
    expect(verifier.verify({}).ok).toBe(false);
    // 配对凭据不带 scope（undefined = 全量），门禁由网关侧按用户令牌执行。
    const paired = verifier.verify({ authorizationHeader: `Bearer ${credential}` });
    expect(paired.ok && paired.authorization === undefined).toBe(true);
  });

  it("吊销配对凭据后仅静态令牌可用", () => {
    const dir = tempDir();
    const { credential } = issuePairedCredential(dir);
    revokePairedCredential(dir);
    const verifier = new CompositeMerchantMcpVerifier([
      new StaticBearerTokenVerifier("static-token"),
      new PairedCredentialVerifier(dir),
    ]);
    expect(verifier.verify({ authorizationHeader: `Bearer ${credential}` }).ok).toBe(false);
    expect(verifier.verify({ authorizationHeader: "Bearer static-token" }).ok).toBe(true);
  });
});
