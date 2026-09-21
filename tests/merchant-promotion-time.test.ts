import { describe, expect, it } from "vitest";

import { parsePromotionBoundary, promotionIsActive } from "../src/merchant/promotion-time.js";

describe("promotion time boundaries", () => {
  it("uses a half-open interval at millisecond boundaries", () => {
    const start = "2026-09-21T00:00:00.000Z";
    const end = "2026-09-22T00:00:00.000Z";
    expect(promotionIsActive(start, end, "2026-09-20T23:59:59.999Z")).toBe(false);
    expect(promotionIsActive(start, end, start)).toBe(true);
    expect(promotionIsActive(start, end, "2026-09-21T23:59:59.999Z")).toBe(true);
    expect(promotionIsActive(start, end, end)).toBe(false);
  });

  it("interprets an inclusive business date end as next local midnight", () => {
    const start = parsePromotionBoundary({ value: "2026-09-21", timezone: "Asia/Shanghai" });
    const end = parsePromotionBoundary({
      value: "2026-09-21",
      timezone: "Asia/Shanghai",
      dateEndInclusive: true,
    });
    expect(start).toMatchObject({
      instant: "2026-09-20T16:00:00.000Z",
      offset: "+08:00",
    });
    expect(end).toMatchObject({
      instant: "2026-09-21T16:00:00.000Z",
      offset: "+08:00",
    });
  });

  it("does not hard-code a business day to 24 hours across DST", () => {
    const start = parsePromotionBoundary({ value: "2026-03-08", timezone: "America/New_York" });
    const end = parsePromotionBoundary({
      value: "2026-03-08",
      timezone: "America/New_York",
      dateEndInclusive: true,
    });
    expect(Date.parse(end.instant) - Date.parse(start.instant)).toBe(23 * 60 * 60 * 1000);
    expect(start.offset).toBe("-05:00");
    expect(end.offset).toBe("-04:00");
  });

  it("rejects nonexistent and ambiguous local wall times unless an offset is explicit", () => {
    expect(() =>
      parsePromotionBoundary({
        value: "2026-03-08T02:30:00",
        timezone: "America/New_York",
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      parsePromotionBoundary({
        value: "2026-11-01T01:30:00",
        timezone: "America/New_York",
      }),
    ).toThrow(/ambiguous/);
    expect(
      parsePromotionBoundary({
        value: "2026-11-01T01:30:00-04:00",
        timezone: "America/New_York",
      }).instant,
    ).toBe("2026-11-01T05:30:00.000Z");
  });
});
