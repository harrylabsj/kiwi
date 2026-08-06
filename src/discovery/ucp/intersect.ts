/**
 * UCP capability intersection（server-selects 语义；基线 §3.2 / §25 / §43）。
 *
 * UCP 官方 Intersection Algorithm（按规范给定实现，不发明）：
 *   1. Compute intersection —— business 的每个 capability，若 platform 也声明同名 → 纳入；
 *   2. Select version —— 对交集中每个 capability，取双方 version 数组的交集；非空选最高
 *      （最新日期，compareUcpVersions）；为空 → 该 capability 移出交集；
 *   3. Prune orphaned extensions —— extends 的 parent 不在交集中则移除
 *      （单 parent 必须在；多 parent 数组至少一个在）；
 *   4. Repeat pruning —— 重复 3 直到不再变化（处理传递依赖链到不动点）。
 *
 * extension schema 的 requires 约束（条目内联 `requires`；真实集成从 schema 文档解析后内联）：
 *   - requires.protocol.min / max 与 requires.capabilities.<parent>.min / max；
 *     min 含、max 含、max 缺省 = 无上限；版本字符串按 YYYY-MM-DD 日期比较；
 *   - 交集计算时若协商 protocol version 或 parent capability version 不满足 requires →
 *     该 extension 排除（requires_unsatisfied）并重新剪枝；
 *   - requires.capabilities 的键 MUST 是其 extends 键的子集，否则该 schema 声明本身非法
 *     （validateRequiresConstraint；在交集里按 fail-closed 记为 requires_unsatisfied）。
 *
 * UCP 是 server-selects：business（服务端）负责算交集，platform 宣告自己的 profile。
 * 交集为空或版本互不兼容 → capabilities_incompatible（业务结果，非 transport 错误）。
 * selectRelevantCapabilities 按 UCP 'Relevance' 规则从交集挑出与某操作相关的能力集：
 * root 匹配操作类型 + extension extends 命中相关 root（传递闭包）。
 *
 * 零新增依赖；纯函数，不抓取 schema —— requires 以条目内联形式提供。
 */

import type { UcpCapabilityDeclaration, UcpProfile } from "./types.js";

/** YYYY-MM-DD spec 日期格式（UCP §43）。 */
const SPEC_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * capability 交集排除原因枚举：
 *   - `no_mutual`             —— business 声明但 platform 未声明同名 capability；
 *   - `version_incompatible`  —— 双方都声明但 version 数组无交集（版本互不兼容）；
 *   - `orphaned_extension`    —— extends 的 parent 不在交集中
 *                                （单 parent 必须在 / 多 parent 至少一个在）；
 *   - `requires_unsatisfied`  —— requires 约束不满足，或 requires 声明本身非法（fail-closed）。
 */
export type CapabilityExclusionReason =
  | "no_mutual"
  | "version_incompatible"
  | "orphaned_extension"
  | "requires_unsatisfied";

/** 版本上下界（min 含、max 含、max 缺省 = 无上限）。 */
export interface UcpRequiresVersionBounds {
  /** 含边界下限（YYYY-MM-DD）。 */
  min?: string;
  /** 含边界上限（YYYY-MM-DD）；缺省 = 无上限。 */
  max?: string;
}

/** extension schema 的 requires 约束。 */
export interface UcpRequiresConstraint {
  /** 对协商协议版本（negotiatedProtocolVersion）的约束。 */
  protocol?: UcpRequiresVersionBounds;
  /** 对 extends 中 parent capability 选中版本的约束；键 MUST ⊆ extends 键。 */
  capabilities?: Record<string, UcpRequiresVersionBounds>;
}

/** 携带 schema requires 的 capability 声明（requires 从 schema 文档解析后内联到条目）。 */
export interface UcpCapabilityWithRequires extends UcpCapabilityDeclaration {
  requires?: UcpRequiresConstraint;
}

/** 交集活跃项：选中版本 + business 侧该版本的声明。 */
export interface ActiveCapability {
  /** 双方共同版本中选出的最高（最新）版本。 */
  version: string;
  /** business 侧选中版本的 capability 声明（可能携带 requires）。 */
  entry: UcpCapabilityWithRequires;
}

/** 被排除的 capability 记录。 */
export interface ExcludedCapability {
  name: string;
  reason: CapabilityExclusionReason;
}

export interface CapabilityIntersectionResult {
  /** 存活的能力集（name → 选中版本 + business 侧声明），保序（business 声明顺序）。 */
  active: Map<string, ActiveCapability>;
  /** 被排除的 capability 及原因（仅 business 侧声明过的名字；platform-only 不出现）。 */
  excluded: ExcludedCapability[];
  /** 交集是否非空（false → capabilities_incompatible 业务结果）。 */
  compatible: boolean;
}

/** JSON 友好的交集视图（CounterpartyProfile 用，避免把 Map 泄漏到档案里）。 */
export interface UcpIntersectionView {
  /** 交集是否非空（false → capabilities_incompatible 业务结果）。 */
  compatible: boolean;
  /** 存活能力集（保序，business 声明顺序）：name → 选中版本。 */
  active: Array<{ name: string; version: string }>;
  /** 被排除的 capability 及原因。 */
  excluded: ExcludedCapability[];
}

/** 把 computeCapabilityIntersection 的结果投影为 JSON 友好视图。 */
export function intersectionView(result: CapabilityIntersectionResult): UcpIntersectionView {
  return {
    compatible: result.compatible,
    active: [...result.active.entries()].map(([name, cap]) => ({ name, version: cap.version })),
    excluded: result.excluded,
  };
}

/** 解析 YYYY-MM-DD 为 UTC 毫秒时间戳；非法返回 undefined。 */
function parseSpecDate(s: string): number | undefined {
  const m = SPEC_DATE_RE.exec(s);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const time = Date.UTC(year, month - 1, day);
  const d = new Date(time);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return time;
}

/** 版本字符串是否为合法 YYYY-MM-DD spec 日期。 */
export function isUcpVersionDate(s: string): boolean {
  return parseSpecDate(s) !== undefined;
}

/**
 * 版本比较：YYYY-MM-DD 按日期值比较；合法日期 > 非日期字符串；两个非日期按字典序
 * 比较（确定性回退，覆盖 vendor "1.0" 等占位版本）。返回负 / 零 / 正。
 */
export function compareUcpVersions(a: string, b: string): number {
  const da = parseSpecDate(a);
  const db = parseSpecDate(b);
  if (da !== undefined && db !== undefined) return da - db;
  if (da !== undefined) return 1;
  if (db !== undefined) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function indexCapabilities(profile: UcpProfile): Map<string, UcpCapabilityWithRequires[]> {
  const map = new Map<string, UcpCapabilityWithRequires[]>();
  const caps = profile.ucp.capabilities;
  if (caps === undefined) return map;
  for (const [name, declarations] of Object.entries(caps)) {
    map.set(name, declarations.map((d) => d as UcpCapabilityWithRequires));
  }
  return map;
}

function extendsList(extendsValue: string | string[] | undefined): string[] {
  if (extendsValue === undefined) return [];
  return typeof extendsValue === "string" ? [extendsValue] : extendsValue;
}

/** 运行时读取条目内联 requires；malformed（非对象）返回 "malformed"（fail-closed）。 */
function readRequires(
  decl: UcpCapabilityWithRequires,
): UcpRequiresConstraint | "malformed" | undefined {
  const raw = decl.requires;
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "malformed";
  return raw as UcpRequiresConstraint;
}

function satisfiesBounds(
  version: string,
  bounds: UcpRequiresVersionBounds | undefined,
): boolean {
  if (bounds === undefined) return true;
  if (bounds.min !== undefined && compareUcpVersions(version, bounds.min) < 0) return false;
  if (bounds.max !== undefined && compareUcpVersions(version, bounds.max) > 0) return false;
  return true;
}

function requiresSatisfied(
  requires: UcpRequiresConstraint,
  protocolVersion: string,
  active: ReadonlyMap<string, ActiveCapability>,
): boolean {
  if (requires.protocol !== undefined && !satisfiesBounds(protocolVersion, requires.protocol)) {
    return false;
  }
  if (requires.capabilities !== undefined) {
    for (const [parentName, bounds] of Object.entries(requires.capabilities)) {
      const parent = active.get(parentName);
      // requires 指定的 parent 不在交集中 → 无法满足（即使多 parent 其他成员仍活跃）。
      if (parent === undefined) return false;
      if (!satisfiesBounds(parent.version, bounds)) return false;
    }
  }
  return true;
}

/** 剪枝条件：root（无 extends）恒保留；extension 需至少一个 parent 在交集。 */
function hasActiveParent(
  extendsValue: string | string[] | undefined,
  active: ReadonlyMap<string, ActiveCapability>,
): boolean {
  const parents = extendsList(extendsValue);
  if (parents.length === 0) return true;
  return parents.some((p) => active.has(p));
}

export interface RequiresValidationResult {
  valid: boolean;
  /** 人类可读问题列表；valid=true 时为空。 */
  problems: string[];
}

function validateBounds(
  bounds: Record<string, unknown>,
  path: string,
  problems: string[],
): void {
  const min = bounds.min;
  const max = bounds.max;
  if (min !== undefined && (typeof min !== "string" || !isUcpVersionDate(min))) {
    problems.push(`${path}.min must be a YYYY-MM-DD date`);
  }
  if (max !== undefined && (typeof max !== "string" || !isUcpVersionDate(max))) {
    problems.push(`${path}.max must be a YYYY-MM-DD date`);
  }
  if (
    typeof min === "string" &&
    typeof max === "string" &&
    isUcpVersionDate(min) &&
    isUcpVersionDate(max) &&
    compareUcpVersions(min, max) > 0
  ) {
    problems.push(`${path}.min must not be greater than max`);
  }
}

/**
 * requires 声明合法性校验（"该 schema 声明本身非法"判定）：
 *   - requires 必须是对象；
 *   - protocol / capabilities 中每个 bounds 的 min/max 必须是合法 YYYY-MM-DD 且 min <= max；
 *   - requires.capabilities 的键 MUST 是其 extends 键的子集
 *     （单 parent extends 视为 [extends]；无 extends 视为 []）。
 */
export function validateRequiresConstraint(
  requires: unknown,
  extendsValue: string | string[] | undefined,
): RequiresValidationResult {
  const problems: string[] = [];
  if (requires === undefined) return { valid: true, problems };
  if (requires === null || typeof requires !== "object" || Array.isArray(requires)) {
    return { valid: false, problems: ["requires must be an object"] };
  }
  const obj = requires as Record<string, unknown>;
  const extendsKeys = extendsList(extendsValue);

  if (obj.protocol !== undefined) {
    if (obj.protocol === null || typeof obj.protocol !== "object" || Array.isArray(obj.protocol)) {
      problems.push("requires.protocol must be an object");
    } else {
      validateBounds(obj.protocol as Record<string, unknown>, "requires.protocol", problems);
    }
  }

  if (obj.capabilities !== undefined) {
    if (
      obj.capabilities === null ||
      typeof obj.capabilities !== "object" ||
      Array.isArray(obj.capabilities)
    ) {
      problems.push("requires.capabilities must be an object");
    } else {
      const caps = obj.capabilities as Record<string, unknown>;
      for (const [parent, bounds] of Object.entries(caps)) {
        const path = `requires.capabilities.${parent}`;
        if (!extendsKeys.includes(parent)) {
          problems.push(
            `${path}: key must be a subset of the capability's extends keys (illegal declaration)`,
          );
          continue;
        }
        if (bounds === null || typeof bounds !== "object" || Array.isArray(bounds)) {
          problems.push(`${path} must be an object`);
          continue;
        }
        validateBounds(bounds as Record<string, unknown>, path, problems);
      }
    }
  }

  return { valid: problems.length === 0, problems };
}

/**
 * UCP capability intersection（business 侧计算，server-selects）。
 *
 * 严格实现四步 Intersection Algorithm + requires 约束（见文件头）。返回结构化结果：
 *   - `active`：存活能力集（name → 选中版本 + business 侧声明）；
 *   - `excluded`：被排除能力及原因（reason 枚举见 CapabilityExclusionReason）；
 *   - `compatible`：交集是否非空。
 */
export function computeCapabilityIntersection(
  businessProfile: UcpProfile,
  platformProfile: UcpProfile,
  negotiatedProtocolVersion?: string,
): CapabilityIntersectionResult {
  const protocolVersion = negotiatedProtocolVersion ?? businessProfile.ucp.version;
  const business = indexCapabilities(businessProfile);
  const platform = indexCapabilities(platformProfile);

  const excluded: ExcludedCapability[] = [];
  const active = new Map<string, ActiveCapability>();

  // Step 1 + 2：同名交集；对每个 capability 取双方 version 数组交集，非空选最高。
  for (const [name, businessDecls] of business) {
    const platformDecls = platform.get(name);
    if (platformDecls === undefined) {
      excluded.push({ name, reason: "no_mutual" });
      continue;
    }
    const platformVersions = new Set(platformDecls.map((d) => d.version));
    const common = businessDecls.map((d) => d.version).filter((v) => platformVersions.has(v));
    if (common.length === 0) {
      excluded.push({ name, reason: "version_incompatible" });
      continue;
    }
    const selectedVersion = common.reduce((a, b) => (compareUcpVersions(a, b) >= 0 ? a : b));
    const entry = businessDecls.find((d) => d.version === selectedVersion);
    if (entry !== undefined) {
      active.set(name, { version: selectedVersion, entry });
    }
  }

  // Step 3 + 4 + requires：迭代剪枝到不动点。
  // requires 先于孤儿判定（requires 不满足 → 排除并重新剪枝，其下游 extension 再判孤儿）。
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, cap] of active) {
      const requires = readRequires(cap.entry);
      if (requires === "malformed") {
        excluded.push({ name, reason: "requires_unsatisfied" });
        active.delete(name);
        changed = true;
        continue;
      }
      if (!validateRequiresConstraint(requires, cap.entry.extends).valid) {
        excluded.push({ name, reason: "requires_unsatisfied" });
        active.delete(name);
        changed = true;
        continue;
      }
      if (requires !== undefined && !requiresSatisfied(requires, protocolVersion, active)) {
        excluded.push({ name, reason: "requires_unsatisfied" });
        active.delete(name);
        changed = true;
        continue;
      }
      if (!hasActiveParent(cap.entry.extends, active)) {
        excluded.push({ name, reason: "orphaned_extension" });
        active.delete(name);
        changed = true;
        continue;
      }
    }
  }

  return { active, excluded, compatible: active.size > 0 };
}

/** 交集为空或版本互不兼容时抛的业务错误（capabilities_incompatible，非 transport 错误）。 */
export class CapabilityIncompatibleError extends Error {
  readonly code: "capability_incompatible";
  constructor(message: string) {
    super(message);
    this.name = "CapabilityIncompatibleError";
    this.code = "capability_incompatible";
  }
}

/** 兼容断言：交集为空/互不兼容时抛 CapabilityIncompatibleError；否则原样返回交集。 */
export function requireCapabilitiesCompatible(
  result: CapabilityIntersectionResult,
): CapabilityIntersectionResult {
  if (!result.compatible) {
    const detail = result.excluded.map((e) => `${e.name} (${e.reason})`).join("; ");
    throw new CapabilityIncompatibleError(
      `no mutually compatible UCP capabilities: ${detail || "empty intersection"}`,
    );
  }
  return result;
}

/** root capability 名是否匹配操作类型：全名相等，或末段 capability 标签相等。 */
export function matchesOperationType(operationType: string, rootName: string): boolean {
  if (rootName === operationType) return true;
  const lastSegment = rootName.slice(rootName.lastIndexOf(".") + 1);
  return lastSegment.length > 0 && lastSegment === operationType;
}

/**
 * 按 UCP 'Relevance' 规则从交集挑出与某操作相关的能力集：
 *   - root capability（无 extends）名匹配操作类型（matchesOperationType）；
 *   - extension extends 命中相关 root，沿 extends 传递闭包纳入（单/多 parent 任一命中即可）。
 * 返回 `active` 的一个子集（保序）。无匹配 root 时返回空集。
 */
export function selectRelevantCapabilities(
  active: ReadonlyMap<string, ActiveCapability>,
  operationType: string,
): Map<string, ActiveCapability> {
  const relevant = new Map<string, ActiveCapability>();
  const children = new Map<string, string[]>();
  for (const [name, cap] of active) {
    for (const parent of extendsList(cap.entry.extends)) {
      const list = children.get(parent);
      if (list === undefined) children.set(parent, [name]);
      else list.push(name);
    }
  }

  const queue: string[] = [];
  for (const [name, cap] of active) {
    if (extendsList(cap.entry.extends).length === 0 && matchesOperationType(operationType, name)) {
      relevant.set(name, cap);
      queue.push(name);
    }
  }

  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    for (const kid of children.get(parent) ?? []) {
      const cap = active.get(kid);
      if (cap !== undefined && !relevant.has(kid)) {
        relevant.set(kid, cap);
        queue.push(kid);
      }
    }
  }

  return relevant;
}
