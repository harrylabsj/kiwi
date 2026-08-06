/**
 * Kiwi vendor capability 构造器（基线 §8.3 / §25.2 / §43）。
 *
 * capability 名：`example.kiwi.shopping.negotiation`（占位 authority `kiwi.example`，
 * 对齐 §8.2 的 A2A Extension URI 示例）。**生产发布前 MUST 把 authority 与
 * capability/service 名整体替换为 Kiwi 实际控制域名对应的 reverse-domain namespace**
 * （§8.3），spec / schema origin 由构造器按 authority 推导，替换后自动满足 origin 绑定。
 *
 * spec 用 §8.2 Extension URI；schema 用同 origin 的 JSON Schema 地址。negotiation 是
 * Vendor Root Capability（不带 extends，§25.2）。
 */

import type { UcpCapabilityDeclaration, UcpProfile } from "./types.js";

/** 占位 authority（§8.2 示例域名）。生产前 MUST 替换为实际控制域名。 */
export const KIWI_VENDOR_AUTHORITY = "kiwi.example";
export const KIWI_VENDOR_SERVICE_NAME = "example.kiwi.shopping";
export const KIWI_VENDOR_CAPABILITY_NAME = "example.kiwi.shopping.negotiation";
export const KIWI_NEGOTIATION_SPEC_PATH = "/a2a/extensions/negotiation/1.0";
export const KIWI_NEGOTIATION_SCHEMA_PATH = "/schemas/negotiation/1.0/schema.json";

export interface KiwiVendorBuildOptions {
  /** 实际控制域名的 reverse-domain authority（默认占位 kiwi.example）。 */
  authority?: string;
  /** 声明版本（默认 "1.0"）。 */
  version?: string;
  /** capability 名（默认 example.kiwi.shopping.negotiation）。换 authority 时必须同步替换。 */
  capabilityName?: string;
  /** service 名（默认 example.kiwi.shopping）。换 authority 时必须同步替换。 */
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
