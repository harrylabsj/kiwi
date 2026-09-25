/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Network 商品摘要与价格类型词表（双来源搜索设计 v1.1 §3.3/§6.2/§17）。
 *
 * `MerchantRecord` 原本主要是商家级摘要（matching_skus + delivery），不足以支撑
 * 「单条结果字段」要求的商品名/规格/价格/起订量/交期。本模块把 catalog listing
 * 的**真实字段**投影为商品摘要——只透出商家声明的事实，未知字段一律不设置，
 * 不因商家名或品类相似而补全（设计 §17）。
 *
 * 价格类型是设计 §3.3 的四值词表，本模块是它的单一来源：Backend 只产生
 * `merchant_listed_price` / `to_be_quoted`；`page_reference` 属于宿主互联网
 * 结果，`merchant_quoted` 属于 RFQ/磋商回复（`kiwi_get_task`）。宿主不得另立
 * 平行词表，也不得把资料价呈现为商家报价。
 */

import type { ListingSearchResult } from "../discovery/catalog-source/kiwi-record.js";

/** 价格类型（设计 §3.3）。 */
export const PRICE_KINDS = [
  /** 页面参考价：外部电商页面展示价（宿主互联网结果）。 */
  "page_reference",
  /** 商家资料价：Network 既有资料中的价格，未经本次询价确认。 */
  "merchant_listed_price",
  /** 商家报价：商家针对本次需求实际回复的价格（RFQ/磋商），保留适用条件。 */
  "merchant_quoted",
  /** 待询价：无可用价格，或无法确定价格是否适用于本次需求。 */
  "to_be_quoted",
] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** 每条商品的价格：只保留原文与类型，不做币种/单位换算，不生成到手价。 */
export interface ProductPrice {
  kind: PriceKind;
  /** 商家声明的价格原文（如 `¥12-15/件`）；`to_be_quoted` 时不设置。 */
  hint?: string;
}

/**
 * Network 商家的一条商品摘要（来自 catalog listing 的 discovery projection）。
 * 所有字段均为商家既有资料的原文投影：未提供即未知，宿主按「待确认」展示。
 */
export interface MerchantProductSummary {
  /** listing 标识（可追溯依据）。 */
  listing_id: string;
  title: string;
  brand?: string;
  category?: string;
  /** 商家声明的结构化属性（规格/型号/材质等原文），不做换算与补全。 */
  attributes?: Record<string, string | number | boolean>;
  price: ProductPrice;
  /** 起订量（商家声明）；未知时不设置——不得默认支持用户采购数量。 */
  moq?: number;
  /** 可供货状态声明（原文）；未知时不设置。 */
  availability_hint?: string;
  /** 交期声明（原文）；未知时不设置，也不得声称满足用户交期。 */
  lead_time_hint?: string;
  /** listing 更新时间（RFC3339）：信息何时更新，不代表库存/价格实时。 */
  updated_at: string;
  /** 信息性质：商家既有资料，未经本次需求确认（设计 §3.2「商家资料」）。 */
  basis: "merchant_listed";
  /** 依据等级：catalog discovery projection，非 Kiwi 背书、非实时可用性。 */
  authority: "discovery_projection";
}

/**
 * 每个商家最多投影的商品条数：控制 kiwi_search 工具返回体积。
 * 取 catalog 返回顺序的前 N 条（catalog 排序即相关性排序）。
 */
export const MAX_PRODUCTS_PER_MERCHANT = 3;

/** 把 catalog listing 搜索结果投影为商品摘要（只取真实字段）。 */
export function summarizeListing(result: ListingSearchResult): MerchantProductSummary {
  const listing = result.listing;
  const hints = listing.commercial_hints;
  const priceHint = hints?.price_range_hint;
  const attributeEntries = Object.entries(listing.attributes ?? {});
  return {
    listing_id: listing.listing_id,
    title: listing.title,
    ...(listing.brand !== undefined && listing.brand !== "" ? { brand: listing.brand } : {}),
    ...(listing.category !== "" ? { category: listing.category } : {}),
    ...(attributeEntries.length > 0
      ? {
          attributes: Object.fromEntries(attributeEntries) as Record<
            string,
            string | number | boolean
          >,
        }
      : {}),
    price:
      priceHint !== undefined && priceHint !== ""
        ? { kind: "merchant_listed_price", hint: priceHint }
        : { kind: "to_be_quoted" },
    ...(hints?.moq !== undefined ? { moq: hints.moq } : {}),
    ...(hints?.availability_hint !== undefined && hints.availability_hint !== ""
      ? { availability_hint: hints.availability_hint }
      : {}),
    ...(hints?.lead_time_hint !== undefined && hints.lead_time_hint !== ""
      ? { lead_time_hint: hints.lead_time_hint }
      : {}),
    updated_at: listing.updated_at,
    basis: "merchant_listed",
    authority: "discovery_projection",
  };
}
