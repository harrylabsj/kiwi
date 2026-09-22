/**
 * 时钟注入契约（防复发断言）。
 *
 * ## 起因（2026-09-22 真实发生）
 *
 * `MerchantGrantStore` 有自己的注入时钟 `this.now`，grant 过期比较与时间戳都在用它，
 * 但三处 `assertVerifiedActor` 走的是**默认墙钟**——于是注入时钟只控制一半：调用方
 * 把时间钉死也没用，主体仍按真实时间判过期。
 *
 * 后果：`merchant-grant-store.test.ts` 把 actor 的 `expiresAt` 硬编码为
 * `2026-09-22T00:00:00Z`，北京时间 2026-09-22 08:00 一到，**同一份代码**从
 * 4 passed 变成 4 failed。已核实该常量在 `30588c2`（声称门禁全绿的提交）里与今相同
 * ——代码未变，只是时间过去了。**门禁数字因此有保质期。**
 *
 * 同一天还查出第二处同型问题：`src/agent/kernel.ts` 声明了「统一时钟」并把同一个闭包
 * 传给十几个协作者，却在两处把**字面量墙钟**交出去。
 *
 * 这一类的共同形状是：**模块已经决定让时间可注入，但某个调用点偷偷用了真实时间。**
 * 它是静默的——没有任何现有测试会失败，直到墙钟越过某个硬编码时刻。
 *
 * ## 两条断言
 *
 * 1. **`assertVerifiedActor` 的第二个参数就是时钟**：全仓每一处调用都必须显式传。
 *    省略即等于用墙钟。这条是**精确的语义断言**（该函数签名 `(value, now = new Date())`
 *    决定了这一点），强度最高。
 * 2. **声明了统一时钟的模块不得把字面量墙钟交给协作者**（`kernel.ts`）。
 *    这条是**结构性近似**：它读源码文本，强度弱于行为测试，可能被等价重写绕过。
 *    **为什么仍然写它**：kernel 级的真实夹具需要构造完整 AgentKernel + handoffRuntime，
 *    成本高；而这条断言拦下的正是**真实发生过的那个改动形状**。若将来有了 kernel
 *    夹具，应把它替换成「冻结时钟 → 跑 handoff → 断言证据时间等于冻结值」的行为断言。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { FileLeaseStore } from "../src/negotiation/lease/store.js";

const SRC = path.join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 去掉整行注释与块注释行——只处理本仓实际使用的 `//` 与 `*`/`/**` 形态。 */
function codeLines(source: string): { line: number; text: string }[] {
  return source
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

describe("时钟注入契约", () => {
  it("src/ 下每一处 assertVerifiedActor 调用都显式传时钟", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const { line, text } of codeLines(readFileSync(file, "utf8"))) {
        // 单参数调用 = 没传时钟。`assertVerifiedActor(value, now)` 有两参数，不匹配。
        // 定义处的签名含逗号，同样不匹配。
        if (/assertVerifiedActor\([^,)]*\)/.test(text)) {
          offenders.push(`${path.relative(process.cwd(), file)}:${line}  ${text.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "assertVerifiedActor 的第二参数是时钟；省略会退回墙钟，让注入时钟失效，"
        + "使测试随真实时间变红（2026-09-22 已发生过一次）。改为传注入时钟："
        + "new Date(this.now()) 或 new Date(now())",
    ).toEqual([]);
  });

  it("kernel 的统一时钟不被字面量墙钟绕过", () => {
    const source = readFileSync(path.join(SRC, "agent", "kernel.ts"), "utf8");
    // 该模块声明了「统一时钟」，它的全部时间都应由该时钟产出。
    expect(
      /now:\s*\(\)\s*=>\s*new Date\(\)/.test(source),
      "kernel 声明了统一时钟，不得把 `now: () => new Date()` 这个字面量墙钟交给协作者；"
        + "应传 this.clock。",
    ).toBe(false);
    expect(
      /at:\s*new Date\(\)\.toISOString\(\)/.test(source),
      "kernel 的证据时间戳应由统一时钟产出（this.clock()），不要内联 new Date()。",
    ).toBe(false);
  });

  it("kernel 确实声明了统一时钟（防止上一条断言因字段被改名而空转）", () => {
    const source = readFileSync(path.join(SRC, "agent", "kernel.ts"), "utf8");
    expect(source).toMatch(/private readonly clock:\s*\(\)\s*=>\s*string/);
  });
});

describe("P2-1 刀 2 补注入：这两处的时间现在真的可钉死（行为断言）", () => {
  // 这两处此前是「无可注入接口的字面量墙钟」——与上面两条契约断言防的同族，
  // 但连注入入口都没有。补注入后，钉死时间必须真实决定落库与租约判定。

  it("MutableServiceState：落库 updated_at 走注入时钟（insert 与 persist 两条路径）", () => {
    let t = "2026-09-22T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    const state = new MutableServiceState("OPERATING", { now: () => t });
    state.attachPersistence(db, "merchant-clock");
    const updatedAt = () =>
      (
        db
          .prepare("SELECT updated_at FROM workbench_service_control WHERE merchant_id=?")
          .get("merchant-clock") as { updated_at: string }
      ).updated_at;
    // insertCurrent 路径（首次 attach 落行）
    expect(updatedAt()).toBe(t);
    // persistCurrent 路径（状态迁移落库）
    t = "2026-09-22T01:02:03.000Z";
    state.pause("clock test");
    expect(updatedAt()).toBe(t);
  });

  const leaseDirs: string[] = [];
  afterEach(() => {
    for (const dir of leaseDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function leaseStore(nowMs: () => number): FileLeaseStore {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-lease-clock-"));
    leaseDirs.push(dir);
    return new FileLeaseStore(dir, { nowMs });
  }

  it("FileLeaseStore.acquire：过期接管按注入的 nowMs 判定（不依赖墙钟等待）", () => {
    let t = 1_800_000_000_000;
    const s = leaseStore(() => t);
    expect(s.acquire("k", "owner-a", 1_000)).toBe(true);
    // 注入时间推进到 TTL 之内：不接管
    t += 999;
    expect(s.acquire("k", "owner-b", 1_000)).toBe(false);
    // 注入时间越过 TTL：崩溃残留被接管——无需等真实时间流逝
    t += 2;
    expect(s.acquire("k", "owner-b", 1_000)).toBe(true);
  });

  it("FileLeaseStore.renew：续约写出的截止时间同样按注入时钟计算", () => {
    let t = 1_800_000_000_000;
    const s = leaseStore(() => t);
    expect(s.acquire("k", "owner-a", 1_000)).toBe(true);
    t += 500;
    // 续约：expires = 当前注入时间 + TTL = t0+1500
    expect(s.renew("k", "owner-a", 1_000)).toBe(true);
    // t0+1499：续约后的窗口仍然有效，不接管
    t += 999;
    expect(s.acquire("k", "owner-b", 1_000)).toBe(false);
    // t0+1501：越过续约后的截止 → 接管
    t += 2;
    expect(s.acquire("k", "owner-b", 1_000)).toBe(true);
  });
});
