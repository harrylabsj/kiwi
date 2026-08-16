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
 * Merchant UCP Profile 生成（战略 v2.5 §7.1 Protocol Publishing / §7.8 UCP-ready）。
 *
 * 商家在 `/.well-known/ucp` 发布 UCP Profile：声明 Catalog service（指向真实
 * 商品 endpoint）与 KNP 磋商 capability。Kiwi 的 Buyer 端（UcpProfileResolver）
 * 通过该 profile 发现商家能力；商品 truth 仍在 merchant/marketplace，不落 Kiwi。
 *
 * UCP 命名不变量（基线 §8.3）：service 名 = {reverse-domain}.{service}，
 * reverse-domain 反转即 namespace authority host；spec/schema URL origin MUST
 * 与 namespace authority 一致。
 */

import type { UcpProfile } from "../discovery/ucp/types.js";

export const UCP_VERSION = "2026-04-08";

export interface MerchantUcpProfileOptions {
  /** 商家规范域名（如 xihu-digital.example.com）——决定 namespace authority。 */
  domain: string;
  /** 商家 id（marketplace 商家 id，如 merchant-hz-xihu）。 */
  merchantId: string;
  /** 真实商品 catalog endpoint（marketplace search，如 http://127.0.0.1:8765/search/products）。 */
  catalogEndpoint: string;
}

/** 由域名派生 reverse-domain（UCP §8.3：反转 authority host 的 label）。 */
export function reverseDomain(domain: string): string {
  return domain.split(".").reverse().join(".");
}

export function buildMerchantUcpProfile(options: MerchantUcpProfileOptions): UcpProfile {
  const authority = options.domain;
  const rd = reverseDomain(options.domain);
  const catalogService = `${rd}.catalog`;
  const negotiationCapability = "com.harrylabsj.kiwi.shopping.negotiation";

  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [catalogService]: [
          {
            version: UCP_VERSION,
            spec: `https://${authority}/.well-known/ucp#catalog`,
            transport: "rest",
            endpoint: options.catalogEndpoint,
            schema: `https://${authority}/schemas/catalog.json`,
          },
        ],
      },
      capabilities: {
        [negotiationCapability]: [
          {
            version: "1.0",
            spec: "https://kiwi.harrylabsj.com/spec/negotiation/1.0",
            schema: "https://kiwi.harrylabsj.com/schemas/negotiation/1.0/schema.json",
          },
        ],
      },
    },
    signing_keys: [],
    // 商家元信息（非 UCP 标准字段，forward-compat）。
    merchant_id: options.merchantId,
  };
}
