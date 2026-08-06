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
 * Kiwi vendor capability 构造器（基线 §8.3 / §25.2 / §43）。
 *
 * capability 名：`com.harrylabsj.kiwi.shopping.negotiation`（真实 authority
 * `kiwi.harrylabsj.com`，对齐 §8.2 的 A2A Extension URI）。**生产发布前 MUST 把
 * authority 与 capability/service 名替换为 Kiwi 实际控制域名对应的 reverse-domain
 * namespace，并在该域名上真实托管 spec / schema**（§8.3，spec / schema origin 由
 * 构造器按 authority 推导，替换后自动满足 origin 绑定）。
 *
 * spec 用 §8.2 Extension URI；schema 用同 origin 的 JSON Schema 地址。negotiation 是
 * Vendor Root Capability（不带 extends，§25.2）。
 */

import type { UcpCapabilityDeclaration, UcpProfile } from "./types.js";

/**
 * 真实 authority（§8.2 / §8.3）。`kiwi.harrylabsj.com` 为项目维护者实际控制域名
 * （harrylabsj.com 的子域）；spec / schema 须托管在该域名上（UCP origin 绑定）。
 */
export const KIWI_VENDOR_AUTHORITY = "kiwi.harrylabsj.com";
export const KIWI_VENDOR_SERVICE_NAME = "com.harrylabsj.kiwi.shopping";
export const KIWI_VENDOR_CAPABILITY_NAME = "com.harrylabsj.kiwi.shopping.negotiation";
export const KIWI_NEGOTIATION_SPEC_PATH = "/a2a/extensions/negotiation/1.0";
export const KIWI_NEGOTIATION_SCHEMA_PATH = "/schemas/negotiation/1.0/schema.json";

export interface KiwiVendorBuildOptions {
  /** 实际控制域名的 reverse-domain authority（默认 kiwi.harrylabsj.com）。 */
  authority?: string;
  /** 声明版本（默认 "1.0"）。 */
  version?: string;
  /** capability 名（默认 com.harrylabsj.kiwi.shopping.negotiation）。换 authority 时必须同步替换。 */
  capabilityName?: string;
  /** service 名（默认 com.harrylabsj.kiwi.shopping）。换 authority 时必须同步替换。 */
  serviceName?: string;
}

export interface KiwiVendorCapability {
  name: string;
  declaration: UcpCapabilityDeclaration;
}

export function buildKiwiNegotiationCapability(
  opts: KiwiVendorBuildOptions = {},
): KiwiVendorCapability {
  const authority = opts.authority ?? KIWI_VENDOR_AUTHORITY;
  const name = opts.capabilityName ?? KIWI_VENDOR_CAPABILITY_NAME;
  return {
    name,
    declaration: {
      version: opts.version ?? "1.0",
      spec: `https://${authority}${KIWI_NEGOTIATION_SPEC_PATH}`,
      schema: `https://${authority}${KIWI_NEGOTIATION_SCHEMA_PATH}`,
    },
  };
}

export interface KiwiVendorProfileOptions extends KiwiVendorBuildOptions {
  /** 本机 A2A 服务的 Agent Card URL（a2a transport endpoint，基线 §25）。 */
  agentCardUrl: string;
  /** ucp.version spec family 日期（默认 2026-04-08，§43 pin）。 */
  ucpVersion?: string;
}

/** 组装完整的 Kiwi vendor UCP Profile（merchant 侧发布用，后续 WP2 服务端直接复用）。 */
export function buildKiwiVendorProfile(opts: KiwiVendorProfileOptions): UcpProfile {
  const authority = opts.authority ?? KIWI_VENDOR_AUTHORITY;
  const serviceName = opts.serviceName ?? KIWI_VENDOR_SERVICE_NAME;
  const capability = buildKiwiNegotiationCapability(opts);
  return {
    ucp: {
      version: opts.ucpVersion ?? "2026-04-08",
      services: {
        [serviceName]: [
          {
            version: "1.0",
            spec: `https://${authority}${KIWI_NEGOTIATION_SPEC_PATH}`,
            transport: "a2a",
            endpoint: opts.agentCardUrl,
          },
        ],
      },
      capabilities: {
        [capability.name]: [capability.declaration],
      },
    },
  };
}
