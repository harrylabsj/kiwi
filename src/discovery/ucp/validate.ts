/**
 * UCP Profile 运行时校验（UCP 2026-04-08 platform MUST validate 语义）。
 *
 * 两层校验：
 *   1. 硬结构错误（profile 非对象、ucp 缺失、ucp.version 非 YYYY-MM-DD、services /
 *      capabilities 非对象、signing_keys 非对象数组）→ 抛 UcpError("profile_malformed")，
 *      整份 profile 拒绝（fail-closed，§4.6）；
 *   2. 逐条校验（namespace 三段式、transport 枚举、a2a endpoint MUST 指向 Agent Card
 *      URL、spec/schema origin 与 namespace authority 绑定）→ 越权/非法的那一条
 *      capability 或 service 被丢弃并在 `rejected` 中记录，其余合法条目照常保留——
 *      UCP 要求 platform 只使用能验证通过的条目，而不是整份 profile 连带失败。
 *
 * forward-compat：未知字段（顶层 / ucp 内 / 条目内）原样保留，不做 additionalProperties
 * 拒绝。
 */

import { UcpError } from "./error.js";
import {
  UCP_TRANSPORTS,
  isHttpsUrl,
  originHostFor,
  parseCapabilityNamespace,
  parseServiceNamespace,
} from "./types.js";
import type {
  UcpCapabilityDeclaration,
  UcpProfile,
  UcpServiceDeclaration,
  UcpSigningKey,
  UcpTransport,
} from "./types.js";

const SPEC_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type UcpRejectionCode =
  | "entry_malformed"
  | "namespace_invalid"
  | "transport_unsupported"
  | "spec_invalid"
  | "schema_invalid"
  | "spec_origin_mismatch"
  | "schema_origin_mismatch"
  | "endpoint_invalid"
  | "a2a_endpoint_required"
  | "extends_invalid";

export interface UcpRejectedEntry {
  kind: "service" | "capability";
  name: string;
  /** 声明数组内下标；整条 namespace 被拒时为 -1。 */
  index: number;
  /** JSON Pointer 风格路径。 */
  path: string;
  code: UcpRejectionCode;
  message: string;
}

export interface UcpValidationResult {
  /** 过滤后的可用 profile（非法条目已剔除）。 */
  profile: UcpProfile;
  /** 被拒绝（丢弃）的条目。 */
  rejected: UcpRejectedEntry[];
}

function isValidSpecDate(s: string): boolean {
  const match = SPEC_DATE_RE.exec(s);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UcpError("profile_malformed", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new UcpError("profile_malformed", `${path} must be an array`);
  }
  return value;
}

function reject(
  rejected: UcpRejectedEntry[],
  kind: "service" | "capability",
  name: string,
  index: number,
  path: string,
  code: UcpRejectionCode,
  message: string,
): void {
  rejected.push({ kind, name, index, path, code, message });
}

function validateServiceEntry(
  value: unknown,
  path: string,
  authorityHost: string,
  rejected: UcpRejectedEntry[],
  name: string,
  index: number,
): UcpServiceDeclaration | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(rejected, "service", name, index, path, "entry_malformed", `${path} must be an object`);
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const decl = { ...obj } as UcpServiceDeclaration;

  const version = obj.version;
  if (typeof version !== "string" || version.length === 0) {
    reject(
      rejected,
      "service",
      name,
      index,
      path,
      "entry_malformed",
      `${path}/version must be a non-empty string`,
    );
    return undefined;
  }
  decl.version = version;

  const spec = obj.spec;
  if (!isHttpsUrl(spec)) {
    reject(rejected, "service", name, index, path, "spec_invalid", `${path}/spec must be an https URL`);
    return undefined;
  }
  if (originHostFor(spec) !== authorityHost) {
    reject(
      rejected,
      "service",
      name,
      index,
      path,
      "spec_origin_mismatch",
      `${path}/spec origin ${originHostFor(spec)} must equal namespace authority ${authorityHost}`,
    );
    return undefined;
  }
  decl.spec = spec;

  const transport = obj.transport;
  if (typeof transport !== "string" || !(UCP_TRANSPORTS as readonly string[]).includes(transport)) {
    reject(
      rejected,
      "service",
      name,
      index,
      path,
      "transport_unsupported",
      `${path}/transport must be one of ${UCP_TRANSPORTS.join(" | ")} (got ${String(transport)})`,
    );
    return undefined;
  }
  decl.transport = transport as UcpTransport;

  const endpoint = obj.endpoint;
  if (endpoint !== undefined) {
    if (!isHttpsUrl(endpoint)) {
      reject(
        rejected,
        "service",
        name,
        index,
        path,
        "endpoint_invalid",
        `${path}/endpoint must be an https URL`,
      );
      return undefined;
    }
    decl.endpoint = endpoint;
  }
  if (decl.transport === "a2a" && decl.endpoint === undefined) {
    reject(
      rejected,
      "service",
      name,
      index,
      path,
      "a2a_endpoint_required",
      `${path}: a2a transport requires an endpoint pointing to the Agent Card URL`,
    );
    return undefined;
  }

  const schema = obj.schema;
  if (schema !== undefined) {
    if (!isHttpsUrl(schema)) {
      reject(
        rejected,
        "service",
        name,
        index,
        path,
        "schema_invalid",
        `${path}/schema must be an https URL`,
      );
      return undefined;
    }
    if (originHostFor(schema) !== authorityHost) {
      reject(
        rejected,
        "service",
        name,
        index,
        path,
        "schema_origin_mismatch",
        `${path}/schema origin ${originHostFor(schema)} must equal namespace authority ${authorityHost}`,
      );
      return undefined;
    }
    decl.schema = schema;
  }

  return decl;
}

function validateCapabilityEntry(
  value: unknown,
  path: string,
  authorityHost: string,
  rejected: UcpRejectedEntry[],
  name: string,
  index: number,
): UcpCapabilityDeclaration | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(
      rejected,
      "capability",
      name,
      index,
      path,
      "entry_malformed",
      `${path} must be an object`,
    );
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const decl = { ...obj } as UcpCapabilityDeclaration;

  const version = obj.version;
  if (typeof version !== "string" || version.length === 0) {
    reject(
      rejected,
      "capability",
      name,
      index,
      path,
      "entry_malformed",
      `${path}/version must be a non-empty string`,
    );
    return undefined;
  }
  decl.version = version;

  const spec = obj.spec;
  if (!isHttpsUrl(spec)) {
    reject(
      rejected,
      "capability",
      name,
      index,
      path,
      "spec_invalid",
      `${path}/spec must be an https URL`,
    );
    return undefined;
  }
  if (originHostFor(spec) !== authorityHost) {
    reject(
      rejected,
      "capability",
      name,
      index,
      path,
      "spec_origin_mismatch",
      `${path}/spec origin ${originHostFor(spec)} must equal namespace authority ${authorityHost}`,
    );
    return undefined;
  }
  decl.spec = spec;

  const schema = obj.schema;
  if (!isHttpsUrl(schema)) {
    reject(
      rejected,
      "capability",
      name,
      index,
      path,
      "schema_invalid",
      `${path}/schema must be an https URL`,
    );
    return undefined;
  }
  if (originHostFor(schema) !== authorityHost) {
    reject(
      rejected,
      "capability",
      name,
      index,
      path,
      "schema_origin_mismatch",
      `${path}/schema origin ${originHostFor(schema)} must equal namespace authority ${authorityHost}`,
    );
    return undefined;
  }
  decl.schema = schema;

  if (obj.extends !== undefined) {
    const ext = obj.extends;
    const valid =
      (typeof ext === "string" && ext.length > 0) ||
      (Array.isArray(ext) && ext.length > 0 && ext.every((e) => typeof e === "string" && e.length > 0));
    if (!valid) {
      reject(
        rejected,
        "capability",
        name,
        index,
        path,
        "extends_invalid",
        `${path}/extends must be a non-empty string or non-empty array of strings`,
      );
      return undefined;
    }
    decl.extends = ext as string | string[];
  }

  return decl;
}

/**
 * 运行时校验。返回 `{ profile, rejected }`；硬结构错误抛 UcpError("profile_malformed")。
 * profile 是过滤后的可用版本（非法条目剔除、未知字段保留）。
 */
export function validateUcpProfile(value: unknown): UcpValidationResult {
  const root = requireObject(value, "/");
  const ucpRaw = root.ucp;
  if (ucpRaw === undefined) {
    throw new UcpError("profile_malformed", "/ucp must be present");
  }
  const ucp = requireObject(ucpRaw, "/ucp");
  const version = ucp.version;
  if (typeof version !== "string" || !isValidSpecDate(version)) {
    throw new UcpError(
      "profile_malformed",
      `/ucp/version must be a YYYY-MM-DD spec date (got ${String(version)})`,
    );
  }

  const rejected: UcpRejectedEntry[] = [];
  const ucpOut: Record<string, unknown> = { ...ucp, version };

  if (ucp.services !== undefined) {
    const services = requireObject(ucp.services, "/ucp/services");
    const out: Record<string, UcpServiceDeclaration[]> = {};
    for (const [name, entries] of Object.entries(services)) {
      const ns = parseServiceNamespace(name);
      if (ns === undefined) {
        reject(
          rejected,
          "service",
          name,
          -1,
          `/ucp/services/${name}`,
          "namespace_invalid",
          `service name "${name}" is not a valid {reverse-domain}.{service} namespace`,
        );
        continue;
      }
      const arr = requireArray(entries, `/ucp/services/${name}`);
      const kept: UcpServiceDeclaration[] = [];
      arr.forEach((entry, i) => {
        const decl = validateServiceEntry(
          entry,
          `/ucp/services/${name}/${i}`,
          ns.authorityHost,
          rejected,
          name,
          i,
        );
        if (decl !== undefined) kept.push(decl);
      });
      if (kept.length > 0) out[name] = kept;
    }
    ucpOut.services = out;
  }

  if (ucp.capabilities !== undefined) {
    const capabilities = requireObject(ucp.capabilities, "/ucp/capabilities");
    const out: Record<string, UcpCapabilityDeclaration[]> = {};
    for (const [name, entries] of Object.entries(capabilities)) {
      const ns = parseCapabilityNamespace(name);
      if (ns === undefined) {
        reject(
          rejected,
          "capability",
          name,
          -1,
          `/ucp/capabilities/${name}`,
          "namespace_invalid",
          `capability name "${name}" is not a valid {reverse-domain}.{service}.{capability} namespace`,
        );
        continue;
      }
      const arr = requireArray(entries, `/ucp/capabilities/${name}`);
      const kept: UcpCapabilityDeclaration[] = [];
      arr.forEach((entry, i) => {
        const decl = validateCapabilityEntry(
          entry,
          `/ucp/capabilities/${name}/${i}`,
          ns.authorityHost,
          rejected,
          name,
          i,
        );
        if (decl !== undefined) kept.push(decl);
      });
      if (kept.length > 0) out[name] = kept;
    }
    ucpOut.capabilities = out;
  }

  const profileOut: Record<string, unknown> = { ...root, ucp: ucpOut };

  if (root.signing_keys !== undefined) {
    const keys = requireArray(root.signing_keys, "/signing_keys");
    const outKeys: UcpSigningKey[] = [];
    for (const key of keys) {
      if (key === null || typeof key !== "object" || Array.isArray(key)) {
        throw new UcpError("profile_malformed", "/signing_keys entries must be objects");
      }
      outKeys.push(key as UcpSigningKey);
    }
    profileOut.signing_keys = outKeys;
  }

  return { profile: profileOut as UcpProfile, rejected };
}
