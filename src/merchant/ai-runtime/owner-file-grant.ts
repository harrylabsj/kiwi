/**
 * owner-file-grant.ts — A205：R1 本地 file grant **每次操作强读**组件（独立件）。
 *
 * 职责边界（有意做窄，宿主自行集成）：
 *   - 只做强读 + 形状校验 + 精确身份比对 + canonical digest；**不** approve、
 *     不核对 effects、不权限提升、不读写授权文件以外任何东西、不 cache。
 *   - 兼容既有本地 grant 形状 `{ merchantId, principal, granted_at }`（A199 R1）；
 *     额外字段忽略；**不**自动补字段、**不**自称远端 authenticated。
 *   - `grantedAt` 是授权文件里的**声明值**，不是 host 权限证明；组件不自造
 *     TTL/有效期合法性判断（无时效字段）。
 *   - 错误只回固定码 + 固定安全文案：**不**含文件原文、绝对路径、身份值或
 *     任何 PII。
 *   - 能力边界 = local trusted caller：绑定解析器构造时捕获不可变身份副本，
 *     调用方事后改原 config 对象不扩权；工具入参只能给 grant **文件路径**，
 *     不能改绑定的 merchant/principal；返回的 snapshot 是纯数据（冻结），不是 SDK。
 *   - opaque merchant/principal ID 只做**精确字符串比对**（不 regex、不截断、
 *     不规范化）；组件从不拿 ID 拼路径——路径只能由宿主显式传入，ID 不参与
 *     任何文件定位（含 `../`、colon 的 raw ID 只是被散列/比对的身份字节）。
 */

import { readFileSync } from "node:fs";
import { contentDigest } from "../../negotiation/jcs.js";

// ── 错误码（固定、穷举）────────────────────────────────────────────────────

export type FileGrantErrorCode =
  /** 文件缺失/不可读/非法 JSON/形状非法/身份为空——统一 unknown 拒（fail-closed）。 */
  | "grant_unknown"
  /** merchantId 与绑定不一致（精确比对）。 */
  | "grant_merchant_mismatch"
  /** principal 与绑定不一致（精确比对）。 */
  | "grant_principal_mismatch";

export type FileGrantResult =
  | { readonly ok: true; readonly grant: FileGrantSnapshot }
  | { readonly ok: false; readonly code: FileGrantErrorCode; readonly message: string };

/** 不可变 grant snapshot（纯数据，非 SDK）。 */
export interface FileGrantSnapshot {
  /** 与绑定精确一致的 merchant ID（原样，未截断/规范化）。 */
  readonly merchantId: string;
  /** 与绑定精确一致的 principal（原样）。 */
  readonly principal: string;
  /** 授权文件声明的 granted_at（声明值；缺省为 null——不发明、不当权限证明）。 */
  readonly grantedAt: string | null;
  /** 规范 digest（contentDigest）：宿主发前比较撤销/字节级变更。 */
  readonly digest: string;
  /** 本端真实读取时间（ISO）——与 grantedAt 声明值严格区分。 */
  readonly readAt: string;
}

/** 绑定身份（构造时深拷贝冻结；调用方事后改原对象不扩权）。 */
export interface FileGrantBinding {
  readonly merchantId: string;
  readonly principal: string;
}

/** 绑定解析器：local trusted caller 能力边界。 */
export interface FileGrantResolver {
  /**
   * 每次操作强读 grant 文件（无 cache：每次真实 read）。
   * @param grantFile 授权文件路径（宿主显式传入；组件从不由 ID 推导路径）。
   */
  readStrong(grantFile: string): FileGrantResult;
}

// 固定安全文案（不得含路径/原文/身份值）。
const SAFE_MESSAGES: Record<FileGrantErrorCode, string> = {
  grant_unknown: "grant file unreadable or invalid",
  grant_merchant_mismatch: "grant merchant identity mismatch",
  grant_principal_mismatch: "grant principal identity mismatch",
};

function fail(code: FileGrantErrorCode): FileGrantResult {
  return Object.freeze({ ok: false, code, message: SAFE_MESSAGES[code] });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0; // 空/纯空白 = 非法身份
}

/**
 * 构造绑定解析器。入参必须是合法 binding 对象——传 array/原始值/null 等
 * 直接抛 TypeError（不接受畸形 config 猜测性降级）。
 */
export function createFileGrantResolver(
  binding: FileGrantBinding,
  options: { now?: () => string } = {},
): FileGrantResolver {
  if (
    typeof binding !== "object" || binding === null || Array.isArray(binding)
    || !isNonEmptyString((binding as { merchantId?: unknown }).merchantId)
    || !isNonEmptyString((binding as { principal?: unknown }).principal)
  ) {
    throw new TypeError("file-grant resolver: binding must be { merchantId, principal } non-empty strings");
  }
  // 不可变身份副本：宿主事后改原 binding 对象不影响判定（不扩权）。
  const boundMerchant: string = binding.merchantId;
  const boundPrincipal: string = binding.principal;
  const now: () => string = options.now ?? (() => new Date().toISOString());

  return Object.freeze({
    readStrong(grantFile: string): FileGrantResult {
      let raw: string;
      try {
        raw = readFileSync(grantFile, "utf8"); // 只读；不 chmod/创建/删除
      } catch {
        return fail("grant_unknown");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return fail("grant_unknown");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return fail("grant_unknown");
      }
      const rec = parsed as { merchantId?: unknown; principal?: unknown; granted_at?: unknown };
      // 精确比对：不 regex、不截断、不规范化、不大小写折叠。
      if (!isNonEmptyString(rec.merchantId) || !isNonEmptyString(rec.principal)) {
        return fail("grant_unknown"); // 空身份/缺失字段/类型错 = unknown 拒
      }
      if (rec.merchantId !== boundMerchant) return fail("grant_merchant_mismatch");
      if (rec.principal !== boundPrincipal) return fail("grant_principal_mismatch");
      // granted_at 可选；若存在必须是 string，否则形状非法。
      const grantedAt: string | null =
        rec.granted_at === undefined ? null : (isNonEmptyString(rec.granted_at) ? rec.granted_at : null);
      if (rec.granted_at !== undefined && grantedAt === null) {
        return fail("grant_unknown");
      }
      // 白名单重建 snapshot：额外字段不进 snapshot，原文对象与结果解耦。
      const snapshot: FileGrantSnapshot = Object.freeze({
        merchantId: rec.merchantId,
        principal: rec.principal,
        grantedAt,
        digest: contentDigest({ merchantId: rec.merchantId, principal: rec.principal, grantedAt }),
        readAt: now(), // 本端读取时间，与 grantedAt 声明值严格区分
      });
      return Object.freeze({ ok: true, grant: snapshot });
    },
  });
}

/** 便捷一次性强读（无绑定的形状校验场景少用；宿主一般应建 resolver）。 */
export function readFileGrantSnapshot(grantFile: string, options: { now?: () => string } = {}): FileGrantResult {
  // 先读形状，再按文件内身份构造绑定解析——identity 必须非空，否则 unknown。
  let raw: string;
  try {
    raw = readFileSync(grantFile, "utf8");
  } catch {
    return fail("grant_unknown");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("grant_unknown");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("grant_unknown");
  const rec = parsed as { merchantId?: unknown; principal?: unknown };
  if (!isNonEmptyString(rec.merchantId) || !isNonEmptyString(rec.principal)) return fail("grant_unknown");
  return createFileGrantResolver({ merchantId: rec.merchantId, principal: rec.principal }, options)
    .readStrong(grantFile);
}
