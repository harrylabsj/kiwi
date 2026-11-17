/**
 * M5 评测冻结夹具：商品、价格与搜索行为可复现，不依赖部署环境。
 */
import { describe, expect, it } from "vitest";
import {
  M5_FIXTURE_PRODUCTS,
  createM5FixtureProductSource,
} from "../src/merchant-core/learning/evaluation-fixtures.js";

describe("M5 评测冻结夹具", () => {
  it("固定三个 pilot 商品与公开价格", () => {
    expect(Object.keys(M5_FIXTURE_PRODUCTS).sort()).toEqual(["VQ-001", "VQ-002", "VQ-101"]);
    expect(M5_FIXTURE_PRODUCTS["VQ-001"]).toMatchObject({ price: 149.07, unit: "件" });
    expect(M5_FIXTURE_PRODUCTS["VQ-101"]).toMatchObject({
      title: "办公款保温杯",
      price: 99,
    });
    expect(M5_FIXTURE_PRODUCTS["VQ-002"]).toMatchObject({
      title: "基础款保温杯",
      price: 90,
    });
  });

  it("搜索按 SKU 或常用称呼命中；比较场景返回两个候选", async () => {
    const source = createM5FixtureProductSource();
    expect((await source.searchProducts("VQ-001")).map((item) => item.sku)).toEqual(["VQ-001"]);
    expect(
      (await source.searchProducts("办公款和基础款哪个更划算")).map((item) => item.sku).sort(),
    ).toEqual(["VQ-002", "VQ-101"]);
    expect(await source.searchProducts("没有这个商品")).toEqual([]);
  });

  it("未知 SKU 明确报错，不返回编造价格", async () => {
    const source = createM5FixtureProductSource();
    const product = await source.getProduct("VQ-001");
    expect(product).toMatchObject({ price: 149.07, currency: "CNY", stock: 100, unit: "件" });
    await expect(source.getProduct("VQ-404")).rejects.toThrow("unknown fixture sku");
  });
});
