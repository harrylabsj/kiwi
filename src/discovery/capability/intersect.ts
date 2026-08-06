/**
 * Capability intersection（基线 §3.1 / §33 AgentDiscovery：capability intersection）。
 *
 * 双方各持一组 `supportedInterfaces`；Kiwi MUST 从中选择双方共同支持的 binding，
 * 不得把某一种 binding 硬编码为协议本身（§3.1）。本模块：
 *
 * - 计算共同 binding 及其协议版本兼容性（未知版本 fail-closed，§4.6）；
 * - core binding（JSONRPC/GRPC/HTTP+JSON）中确定性地选一个作为 `selected`；
 * - 未知（非 core）binding 出现在 `unknownShared` 但**不选择**（§26 不拒绝但不选择）；
 * - 任一 binding 仅一方支持时记入 `oneSided`（诊断用）。
 *
 * 版本兼容默认精确匹配；可通过 `versionMatch` 注入未来 semver 匹配策略。
 */

import { isCoreProtocolBinding } from "../agent-card/types.js";
import type { AgentCard, AgentInterface } from "../agent-card/types.js";
import { CapabilityError } from "./error.js";

/** core binding 的确定性选择顺序：JSONRPC 优先，其次 GRPC，最后 HTTP+JSON。 */
export const DEFAULT_BINDING_PREFERENCE: readonly string[] = ["JSONRPC", "GRPC", "HTTP+JSON"];

export interface IncompatibleBinding {
  binding: string;
  localVersion?: string;
  remoteVersion?: string;
  reason: string;
}

export interface CapabilityIntersection {
  /** 是否存在共同 core binding 且协议版本兼容。 */
  compatible: boolean;
  /**
   * 共同且版本兼容的 core binding 的远端接口；调用方可按顺序逐个尝试。
   * 数组顺序即 preference 顺序。
   */
  candidates: AgentInterface[];
  /** 确定性选出的单一 binding 的远端接口；无兼容候选时为 undefined。 */
  selected?: AgentInterface;
  /** 双方都有但协议版本不兼容的 binding（fail-closed，§4.6）。 */
  incompatible: IncompatibleBinding[];
  /** 双方共同支持但不是 core binding 的 binding——不选择（§26）。 */
  unknownShared: string[];
  /** 只在一方出现、无法协商的 binding（仅诊断）。 */
  oneSided: string[];
}

export interface IntersectOptions {
  /** core binding 选择顺序。默认 JSONRPC > GRPC > HTTP+JSON。 */
  preference?: readonly string[];
  /** 版本兼容判定；默认精确字符串匹配，缺省版本视为不兼容。 */
  versionMatch?: (localVersion: string | undefined, remoteVersion: string | undefined) => boolean;
}

function toInterfaces(card: AgentCard | AgentInterface[]): AgentInterface[] {
  if (Array.isArray(card)) return card;
  return card.supportedInterfaces;
}

/** 同 binding 名合并多接口声明（同一 binding 出现多次时取全部，供版本匹配）。 */
function indexByBinding(
  interfaces: AgentInterface[],
): Map<string, { version?: string; iface: AgentInterface }[]> {
  const map = new Map<string, { version?: string; iface: AgentInterface }[]>();
  for (const iface of interfaces) {
    const entry = { version: iface.protocolVersion, iface };
    const list = map.get(iface.protocolBinding);
    if (list === undefined) {
      map.set(iface.protocolBinding, [entry]);
    } else {
      list.push(entry);
    }
  }
  return map;
}

/**
 * 双方 supportedInterfaces 的交集。
 *
 * 版本兼容定义（默认）：双方都声明了该 binding 的 protocolVersion 且字符串相等。
 * 任一方的版本缺省、或双方版本不同，该 binding 即视为不兼容（fail-closed）。
 */
export function intersectCapabilities(
  local: AgentCard | AgentInterface[],
  remote: AgentCard | AgentInterface[],
  options: IntersectOptions = {},
): CapabilityIntersection {
  const preference = options.preference ?? DEFAULT_BINDING_PREFERENCE;
  const versionMatch = options.versionMatch ?? ((l, r) => l !== undefined && l === r);

  const localInterfaces = toInterfaces(local);
  const remoteInterfaces = toInterfaces(remote);
  const localByBinding = indexByBinding(localInterfaces);
  const remoteByBinding = indexByBinding(remoteInterfaces);

  const allBindings = new Set<string>([...localByBinding.keys(), ...remoteByBinding.keys()]);

  const candidates: AgentInterface[] = [];
  const incompatible: IncompatibleBinding[] = [];
  const unknownShared: string[] = [];
  const oneSided: string[] = [];

  for (const binding of allBindings) {
    const localEntries = localByBinding.get(binding);
    const remoteEntries = remoteByBinding.get(binding);
    const localPresent = localEntries !== undefined;
    const remotePresent = remoteEntries !== undefined;

    if (!localPresent || !remotePresent) {
      if (isCoreProtocolBinding(binding)) {
        oneSided.push(binding);
      }
      continue;
    }

    // 双方都有。对同一 binding 的多份声明，取任一可兼容组合。
    const matched = remoteEntries?.find((remoteEntry) =>
      (localEntries ?? []).some((localEntry) =>
        versionMatch(localEntry.version, remoteEntry.version),
      ),
    );

    if (matched === undefined) {
      const localVersion = localEntries?.[0]?.version;
      const remoteVersion = remoteEntries?.[0]?.version;
      incompatible.push({
        binding,
        localVersion,
        remoteVersion,
        reason:
          localVersion === undefined || remoteVersion === undefined
            ? "protocolVersion missing on one side (fail-closed)"
            : `protocolVersion mismatch: local ${localVersion} vs remote ${remoteVersion}`,
      });
      continue;
    }

    if (!isCoreProtocolBinding(binding)) {
      unknownShared.push(binding);
      continue;
    }

    candidates.push(matched.iface);
  }

  // 按 preference 顺序稳定排序：preference 中靠前的 binding 优先。
  const preferenceRank = new Map<string, number>(preference.map((b, i) => [b, i]));
  candidates.sort((a, b) => {
    const ra = preferenceRank.get(a.protocolBinding) ?? Number.POSITIVE_INFINITY;
    const rb = preferenceRank.get(b.protocolBinding) ?? Number.POSITIVE_INFINITY;
    return ra - rb;
  });

  const selected = candidates.length > 0 ? (candidates[0] as AgentInterface) : undefined;

  return {
    compatible: candidates.length > 0,
    candidates,
    selected,
    incompatible,
    unknownShared,
    oneSided,
  };
}

/** 无共同可协商 binding 时抛 CapabilityError（fail-closed 断言）。 */
export function requireCompatibleCapabilities(
  local: AgentCard | AgentInterface[],
  remote: AgentCard | AgentInterface[],
  options: IntersectOptions = {},
): CapabilityIntersection {
  const intersection = intersectCapabilities(local, remote, options);
  if (!intersection.compatible) {
    const detail = [
      ...intersection.incompatible,
      ...intersection.oneSided.map((b) => ({
        binding: b,
        reason: "binding supported by only one side",
      })),
    ]
      .map((i) => `${i.binding} (${i.reason})`)
      .join("; ");
    throw new CapabilityError(
      `no common compatible A2A binding: ${detail || "no shared protocolBinding"}`,
    );
  }
  return intersection;
}
