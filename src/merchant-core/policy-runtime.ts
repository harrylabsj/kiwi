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
 * 运行中商家策略提供器（BUG-07 修复）。
 *
 * 之前 `applyPolicyOverride` 只把 patch 落 `policy-overrides.json`，A2A handler
 * 与写执行器仍用启动时加载的 profile.merchant_policy——商家看到"已生效"但报价
 * 策略没变。现在：
 *
 *   - 写端（MCP/core 进程）：patch 与当前生效策略合并 → `parseMerchantPolicy`
 *     校验（与 profile 同规则；未知/非法字段拒绝，失败不落盘不生效）→ 原子写
 *     **完整生效策略**（tmp+rename，0600）→ 更新内存；
 *   - 读端（A2A 进程，与写端不同进程）：每次 `current()` stat 文件 mtime/size，
 *     变化才重载（每报价一次 stat，开销可忽略）；文件损坏/无效时保留上一个
 *     良好策略并告警（fail-safe，不因覆盖层坏档拒绝报价）；
 *   - 文件内容为完整生效策略（版本 + 时间 + policy）：一旦存在即完全接管
 *     （重启后延续，profile 后续改动被覆盖层遮蔽——以文件为准）；版本单调
 *     递增并持久化；digest 为生效策略的稳定序列化 sha256。
 *
 * patch 合并语义：顶层浅合并；值为 `null` 的键表示删除该键；per-SKU 映射
 * （price_floors/sku_max_discount_percent/promos）整体替换。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseMerchantPolicy, type MerchantPolicy } from "../config/profile.js";

/** 当前运行策略快照（读端/写端统一返回口径）。 */
export interface RunningPolicy {
  /** 当前生效策略（覆盖层文件内容；undefined = 尚未配置任何策略）。 */
  policy: MerchantPolicy | undefined;
  /** 单调递增版本（0 = 从未热更新过；持久化在覆盖层文件中）。 */
  version: number;
  /** 生效策略稳定序列化（键排序）的 sha256 hex。 */
  digest: string;
  updated_at: string;
}

/** applyPolicyOverride 的执行回执（进命令记录；不含策略数值本身——私密）。 */
export interface ApplyPolicyResult {
  version: number;
  digest: string;
  updated_at: string;
  /** 本次 patch 涉及的顶层键（值不透出）。 */
  applied_keys: string[];
}

/** 覆盖层文件格式（完整生效策略，非 patch）。 */
interface PolicyOverridesFile {
  version: number;
  updated_at: string;
  policy: MerchantPolicy;
}

/** 键排序的稳定 JSON 序列化（digest 与键序无关）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function digestOf(policy: MerchantPolicy | undefined): string {
  return createHash("sha256").update(stableStringify(policy ?? {})).digest("hex");
}

export interface MerchantPolicyRuntimeOptions {
  /** 启动 profile 的 merchant_policy（无覆盖层文件时的初始生效策略）。 */
  basePolicy: MerchantPolicy | undefined;
  /** 覆盖层文件绝对路径（`<merchantDataDir>/policy-overrides.json`）。 */
  file: string;
  now: () => string;
  /** 读端告警出口（缺省 stderr）。 */
  log?: (message: string) => void;
}

export class MerchantPolicyRuntime {
  private readonly basePolicy: MerchantPolicy | undefined;
  private readonly file: string;
  private readonly now: () => string;
  private readonly log: (message: string) => void;

  private state: RunningPolicy;
  /** 上次成功加载/写入的文件签名（mtimeMs+size）；与缓存一致则不重读。 */
  private lastSig: string | undefined;
  /** 已告警过的坏文件签名（同一坏文件只告警一次）。 */
  private warnedSig: string | undefined;

  constructor(options: MerchantPolicyRuntimeOptions) {
    this.basePolicy = options.basePolicy;
    this.file = options.file;
    this.now = options.now;
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.state = {
      policy: options.basePolicy,
      version: 0,
      digest: digestOf(options.basePolicy),
      updated_at: options.now(),
    };
    this.reloadIfChanged();
  }

  /** 当前生效策略快照（读端每请求调用：stat 缓存命中时 O(1)）。 */
  current(): RunningPolicy {
    this.reloadIfChanged();
    return this.state;
  }

  /** 仅取生效策略（A2A handler provider 用）。 */
  effective(): MerchantPolicy | undefined {
    return this.current().policy;
  }

  /**
   * 应用策略 patch（写端）：合并 → 校验 → 原子写完整生效策略 → 更新内存。
   * 校验失败抛错（ProfileError）：不落盘、不改内存、版本不前进。
   */
  apply(patch: Record<string, unknown>): ApplyPolicyResult {
    if (Object.keys(patch).length === 0) {
      throw new Error("策略 patch 为空：至少提供一个待变更字段");
    }
    const currentPolicy = this.current().policy ?? {};
    const merged: Record<string, unknown> = { ...currentPolicy };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    // 与 profile 启动加载同一套校验规则（BUG-07：拒绝未知/非法字段）。
    const policy = parseMerchantPolicy(merged, "policy-overrides");
    const version = this.state.version + 1;
    const updated_at = this.now();
    const next: RunningPolicy = { policy, version, digest: digestOf(policy), updated_at };
    // 原子写完整生效策略（tmp + rename，0600）：读者要么看到旧文件要么看到
    // 新文件，绝不读到半截 JSON。
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(
      tmp,
      `${JSON.stringify(
        { version, updated_at, policy } satisfies PolicyOverridesFile,
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, this.file);
    this.state = next;
    this.lastSig = this.statSig();
    this.warnedSig = undefined;
    return {
      version,
      digest: next.digest,
      updated_at,
      applied_keys: Object.keys(patch),
    };
  }

  private statSig(): string | undefined {
    try {
      const st = statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }

  /** 读端：文件签名变化才重载；坏文件保留上一个良好策略（同一坏文件告警一次）。
   *  审查 P2：文件被删除（sig === undefined）→ 显式告警一次并保留最后良好
   *  策略（内存态永不静默冻结——操作者删除覆盖层的语义是「回退 profile」，
   *  需两个进程都重启或显式恢复，此处必须让告警可见）。 */
  private reloadIfChanged(): void {
    const sig = this.statSig();
    if (sig === undefined) {
      if (this.lastSig !== undefined && sig !== this.warnedSig) {
        this.log(
          `[policy-runtime] ${this.file} 已消失（被删除？）：保留最后良好策略；` +
            "如需回退 profile 策略请重启相关进程或重新写入完整策略文件",
        );
        this.warnedSig = sig;
      }
      return;
    }
    if (sig === this.lastSig) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PolicyOverridesFile> & {
        patch?: unknown;
      };
      // legacy（BUG-07 修复前只落 patch）：无 policy 字段 → 视为未生效，告警。
      if (raw.policy === undefined) {
        if (sig !== this.warnedSig) {
          this.log(
            `[policy-runtime] ${this.file} 为 legacy patch 格式或缺少 policy 字段，忽略（以 profile 策略为准）`,
          );
          this.warnedSig = sig;
        }
        return;
      }
      const policy = parseMerchantPolicy(raw.policy, "policy-overrides");
      const version =
        typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version >= 1
          ? raw.version
          : 1;
      this.state = {
        policy,
        version,
        digest: digestOf(policy),
        updated_at:
          typeof raw.updated_at === "string" && raw.updated_at.length > 0
            ? raw.updated_at
            : this.now(),
      };
      this.lastSig = sig;
      this.warnedSig = undefined;
    } catch (error) {
      if (sig !== this.warnedSig) {
        this.log(
          `[policy-runtime] ${this.file} 读取/校验失败，保留上一个生效策略: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.warnedSig = sig;
      }
    }
  }
}
