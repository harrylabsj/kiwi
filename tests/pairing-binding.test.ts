/**
 * T025/T026/T027（M2 首验）：配对码的原子单次消费与绑定元组。
 *
 * 设计要求（§6.3）：单次消费、短 TTL，绑定 merchant_id/intent_id/generation/
 * 公钥摘要/回跳目标；**重放、过期、跨商家和另一部署代次均拒绝**。
 *
 * 历史实现只有"码 → 布尔"，没有绑定元组、也没有并发下的原子消费保证
 * （读-删时间窗内两个并发兑换都可能成功）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPairingCode,
  readPairingState,
  redeemPairingCodeBound,
  type PairingBinding,
} from "../src/auth/merchant-pairing.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const BINDING: PairingBinding = {
  merchant_id: "merchant-pilot-001",
  intent_id: "intent-001",
  generation: 1,
  key_thumbprint: "sha256:" + "a".repeat(64),
  redirect_target: "https://portal.example/bind",
};

describe("配对码：单次消费与绑定元组", () => {
  it("正确码兑换成功并返回绑定元组；第二次兑换失败（单次）", () => {
    const dir = tempDir("kiwi-pairing-");
    const { code } = createPairingCode(dir, { binding: BINDING });
    const first = redeemPairingCodeBound(dir, code);
    expect(first.ok).toBe(true);
    expect(first.ok && first.binding).toEqual(BINDING);
    const second = redeemPairingCodeBound(dir, code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(["replayed", "no_code"]).toContain(second.code);
  });

  it("并发兑换同一码：只有一个赢家（rename 竞争，不靠读-删时间窗）", async () => {
    const dir = tempDir("kiwi-pairing-race-");
    const { code } = createPairingCode(dir, { binding: BINDING });
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => redeemPairingCodeBound(dir, code)),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    // 其余全部失败（且原因是稳定码之一）
    const losers = results.filter((r) => !r.ok);
    expect(losers).toHaveLength(results.length - 1);
    for (const loser of losers) {
      if (!loser.ok) expect(["replayed", "no_code"]).toContain(loser.code);
    }
  });

  it("码错误 → invalid_code（不消费，仍可凭正确码兑换）", () => {
    const dir = tempDir("kiwi-pairing-wrong-");
    const { code } = createPairingCode(dir, { binding: BINDING });
    expect(redeemPairingCodeBound(dir, "WRONG-CODE-9999")).toMatchObject({
      ok: false,
      code: "invalid_code",
    });
    // 失败不动状态：正确码仍可兑换
    expect(redeemPairingCodeBound(dir, code).ok).toBe(true);
  });

  it("过期 → expired（并清理残留）", () => {
    const dir = tempDir("kiwi-pairing-expired-");
    const past = () => new Date(Date.now() - 60 * 60 * 1000);
    const { code } = createPairingCode(dir, { binding: BINDING, now: past, ttlMs: 1000 });
    expect(redeemPairingCodeBound(dir, code)).toMatchObject({ ok: false, code: "expired" });
    expect(readPairingState(dir)).toBeUndefined();
  });

  it("跨商家 / 异代次 / 换钥匙 → binding_mismatch，且码不被消费", () => {
    const dir = tempDir("kiwi-pairing-binding-");
    const { code } = createPairingCode(dir, { binding: BINDING });

    expect(
      redeemPairingCodeBound(dir, code, { expect: { merchant_id: "merchant-other" } }),
    ).toMatchObject({ ok: false, code: "binding_mismatch", reason: "merchant_id" });
    expect(
      redeemPairingCodeBound(dir, code, { expect: { generation: 2 } }),
    ).toMatchObject({ ok: false, code: "binding_mismatch", reason: "generation" });
    expect(
      redeemPairingCodeBound(dir, code, { expect: { key_thumbprint: "sha256:" + "b".repeat(64) } }),
    ).toMatchObject({ ok: false, code: "binding_mismatch", reason: "key_thumbprint" });

    // 失败的绑定校验不消费码：期望值正确时仍能兑换。
    expect(
      redeemPairingCodeBound(dir, code, {
        expect: {
          merchant_id: BINDING.merchant_id,
          generation: BINDING.generation,
          key_thumbprint: BINDING.key_thumbprint,
        },
      }).ok,
    ).toBe(true);
  });

  it("无码目录 → no_code（不伪造成功）", () => {
    const dir = tempDir("kiwi-pairing-none-");
    expect(redeemPairingCodeBound(dir, "ANY-CODE-2345")).toMatchObject({ ok: false, code: "no_code" });
  });
});
