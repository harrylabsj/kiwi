/**
 * 交易平台规则刷新缓存：TTL 内不重复打 catalog、失败短退避、不可达保留快照。
 */
import { describe, expect, it } from "vitest";
import {
  createTradePlatformRulesCache,
  fetchTradePlatformRules,
} from "../src/cloud/trade-platforms-client.js";
import { DEFAULT_TRADE_PLATFORM_RULES } from "../src/handoff/trade-platform-rules.js";

const RULES_A = [
  { id: "jd", label: "京东", domain: "item.jd.com", url_template: "https://item.jd.com/{id}.html", sort_order: 0 },
];
const RULES_B = [
  { id: "jd", label: "京东", domain: "item.jd.com", url_template: "https://item.jd.com/{id}.html", sort_order: 0 },
  { id: "taobao", label: "淘宝", domain: "item.taobao.com", url_template: "https://item.taobao.com/item.htm?id={id}", sort_order: 1 },
];

function fetchSequencer(responses: Array<"fail" | typeof RULES_A | typeof RULES_B>) {
  const calls: string[] = [];
  let index = 0;
  const impl = ((_input: string) => {
    calls.push(_input);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next === "fail") return Promise.reject(new Error("catalog down"));
    return Promise.resolve(new Response(JSON.stringify({ platforms: next }), { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("createTradePlatformRulesCache", () => {
  it("启动即拉取；TTL 内的后续刷新不再发请求", async () => {
    let t = 0;
    const { impl, calls } = fetchSequencer([RULES_A, RULES_B]);
    const cache = createTradePlatformRulesCache({
      catalogUrl: "https://catalog.example",
      fetchImpl: impl,
      now: () => t,
    });
    expect(await cache.refresh()).toEqual(RULES_A);
    expect(calls).toHaveLength(1);
    // 30s 内：直接用快照。
    t = 29_999;
    expect(await cache.refresh()).toEqual(RULES_A);
    expect(calls).toHaveLength(1);
    // TTL 过期：重新拉取，拿到运营最新规则。
    t = 30_000;
    expect(await cache.refresh()).toEqual(RULES_B);
    expect(calls).toHaveLength(2);
  });

  it("失败后退避：窗口内不重试、保留上次成功快照；窗口过后自动恢复", async () => {
    let t = 0;
    const { impl, calls } = fetchSequencer([RULES_A, "fail", "fail", RULES_B]);
    const cache = createTradePlatformRulesCache({
      catalogUrl: "https://catalog.example",
      fetchImpl: impl,
      now: () => t,
    });
    expect(await cache.refresh()).toEqual(RULES_A);
    // 失败：快照保留上次成功值。
    t = 40_000;
    expect(await cache.refresh()).toEqual(RULES_A);
    expect(calls).toHaveLength(2);
    // 失败退避窗口（10s）内不重试——买家报价热路径不再每次都吃 2s 超时。
    t = 45_000;
    expect(await cache.refresh()).toEqual(RULES_A);
    expect(calls).toHaveLength(2);
    // 退避结束：重试仍失败，继续保留快照。
    t = 50_001;
    expect(await cache.refresh()).toEqual(RULES_A);
    expect(calls).toHaveLength(3);
    // 再退避后重试成功：快照更新为新规则。
    t = 90_000;
    expect(await cache.refresh()).toEqual(RULES_B);
    expect(calls).toHaveLength(4);
  });

  it("未配置 catalog 时永远使用内置规则，不发请求", async () => {
    const { impl, calls } = fetchSequencer([RULES_A]);
    const cache = createTradePlatformRulesCache({ catalogUrl: undefined, fetchImpl: impl });
    expect(cache.current()).toEqual(DEFAULT_TRADE_PLATFORM_RULES);
    expect(await cache.refresh()).toEqual(DEFAULT_TRADE_PLATFORM_RULES);
    expect(calls).toHaveLength(0);
  });

  it("运营清空平台（[]）会被如实采纳，不会回落内置三家", async () => {
    const { impl } = fetchSequencer([[]]);
    const cache = createTradePlatformRulesCache({
      catalogUrl: "https://catalog.example",
      fetchImpl: impl,
    });
    expect(await cache.refresh()).toEqual([]);
  });

  it("catalog 响应非空但全部行非法时保留上次成功快照，不当作停用全部", async () => {
    let t = 0;
    let call = 0;
    const impl = (async () => {
      call += 1;
      const platforms =
        call === 1
          ? RULES_A
          : [
              {
                id: "",
                label: "",
                domain: "",
                url_template: "https://example.com/no-id",
                sort_order: 0,
              },
            ];
      return new Response(JSON.stringify({ platforms }), { status: 200 });
    }) as unknown as typeof fetch;
    const cache = createTradePlatformRulesCache({
      catalogUrl: "https://catalog.example",
      fetchImpl: impl,
      now: () => t,
    });
    expect(await cache.refresh()).toEqual(RULES_A);
    t = 30_000;
    expect(await cache.refresh()).toEqual(RULES_A);
  });

  it("catalog 不可达且从未成功时，快照保持内置三家", async () => {
    const { impl } = fetchSequencer(["fail"]);
    const cache = createTradePlatformRulesCache({
      catalogUrl: "https://catalog.example",
      fetchImpl: impl,
    });
    expect(await cache.refresh()).toEqual(DEFAULT_TRADE_PLATFORM_RULES);
  });
});

describe("fetchTradePlatformRules", () => {
  it("离线回落内置三家（保留给没有快照的调用方）", async () => {
    const { impl } = fetchSequencer(["fail"]);
    expect(await fetchTradePlatformRules("https://catalog.example", impl)).toEqual(
      DEFAULT_TRADE_PLATFORM_RULES,
    );
  });
});
