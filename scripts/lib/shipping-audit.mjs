// Copyright 2026 harrylabsj
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * 发布门禁的 **已复核豁免清单**（owner 决策 2026-10-28）。
 *
 * 背景：`npm audit --omit=dev` 在发布构建里 fail-closed。个别公告来自上游**精确
 * pin** 的依赖（例如 Pi 把 undici 锁死在 8.10.2），而我们既不能替换版本（会破坏
 * 打包依赖边校验），也不该因为等上游修复把所有产品一起卡死。
 *
 * 规则（全部 fail-closed）：
 *   1. 清单是**受冻源契约覆盖**的文件，任何改动都要重签契约、走评审；
 *   2. 每条必须写明 advisory id、包名、理由、批准人与**到期日**；
 *   3. 过期条目立即失效（`SHIPPING_AUDIT_ALLOW_EXPIRED`）；
 *   4. 只豁免**明确列出**的 advisory；同一包出现新的公告仍然拦截；
 *   5. 解析不出 advisory id 的发现一律拦截（不猜）。
 *
 * 本模块是纯函数，便于单测；不联网、不写文件。
 */

const ALLOW_SCHEMA = "kiwi.shipping-audit-allow/1";
const GHSA_RE = /GHSA-[a-z0-9-]+/i;

/** 从 npm audit 的 via 条目里取 advisory id（对象形态才有）。 */
export function advisoryIdOf(via) {
  if (via === null || typeof via !== "object") return null;
  const url = typeof via.url === "string" ? via.url : "";
  const match = GHSA_RE.exec(url);
  return match === null ? null : match[0].toUpperCase();
}

function fail(message) {
  const error = new Error(message);
  error.code = message;
  throw error;
}

/** 校验豁免清单的形状与到期状态；任何不合规立即抛错。 */
export function assertAllowList(allow, now) {
  if (allow === null || typeof allow !== "object" || Array.isArray(allow)) {
    fail("SHIPPING_AUDIT_ALLOW_MALFORMED");
  }
  if (allow.schema !== ALLOW_SCHEMA) fail("SHIPPING_AUDIT_ALLOW_MALFORMED");
  if (!Array.isArray(allow.entries)) fail("SHIPPING_AUDIT_ALLOW_MALFORMED");
  const today = now.toISOString().slice(0, 10);
  const active = new Map();
  for (const entry of allow.entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim().toUpperCase() : "";
    const pkg = typeof entry?.package === "string" ? entry.package.trim() : "";
    const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
    const approvedBy = typeof entry?.approved_by === "string" ? entry.approved_by.trim() : "";
    const expiresAt = typeof entry?.expires_at === "string" ? entry.expires_at.trim() : "";
    if (
      !GHSA_RE.test(id) ||
      pkg === "" ||
      reason === "" ||
      approvedBy === "" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
    ) {
      fail(`SHIPPING_AUDIT_ALLOW_MALFORMED ${id || pkg || "<entry>"}`);
    }
    if (expiresAt < today) {
      fail(`SHIPPING_AUDIT_ALLOW_EXPIRED ${id} (expired ${expiresAt})`);
    }
    active.set(id, { id, package: pkg, expires_at: expiresAt });
  }
  return active;
}

/**
 * 校验这确实是一份 `npm audit --json` 报告。
 *
 * `npm audit` 在**无法运行**时也会以非零码退出并把 `{"error":{...}}` 打到
 * stdout（典型：CI 连不上 registry，ENETUNREACH/EAI_AGAIN）。调用方为了拿到
 * 号令公告的完整 JSON 会吞掉非零退出码；若不在这里区分，错误对象会被当成
 * "没有任何漏洞"的报告，门禁静默放行。
 */
export function assertAuditReport(audit) {
  const looksLikeReport =
    audit !== null &&
    typeof audit === "object" &&
    !Array.isArray(audit) &&
    audit.error === undefined &&
    typeof audit.vulnerabilities === "object" &&
    audit.vulnerabilities !== null &&
    !Array.isArray(audit.vulnerabilities) &&
    (typeof audit.auditReportVersion === "number" || typeof audit.metadata === "object");
  if (!looksLikeReport) fail("SHIPPING_AUDIT_UNREADABLE");
  return audit;
}

/**
 * 把 `npm audit --json` 的结果分成"已复核放行"与"必须拦截"两堆。
 *
 * @param audit  npm audit --json 的解析结果（可能含 exitCode 语义的包装）
 * @param allow  豁免清单（已通过 assertAllowList）
 * @param now    判定"是否过期"的时钟（注入便于测试）
 */
export function classifyAudit(audit, allow, now = new Date()) {
  const active = assertAllowList(allow, now);
  const vulnerabilities =
    audit !== null && typeof audit === "object" && typeof audit.vulnerabilities === "object"
      ? audit.vulnerabilities
      : {};
  const verdicts = new Map();
  const evaluating = new Set();

  const evaluate = (name) => {
    if (verdicts.has(name)) return verdicts.get(name);
    if (evaluating.has(name)) return { allowed: false, reason: "cycle" };
    const vulnerability = vulnerabilities[name];
    if (vulnerability === undefined) return { allowed: false, reason: "unknown" };
    evaluating.add(name);
    const viaEntries = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    const advisories = viaEntries.map(advisoryIdOf).filter((id) => id !== null);
    const referenced = viaEntries.filter((via) => typeof via === "string");
    const uncoveredAdvisories = advisories.filter((id) => {
      const entry = active.get(id);
      return entry === undefined || entry.package !== name;
    });
    let uncoveredReferences = [];
    if (advisories.length === 0) {
      // 只有字符串 via（"该问题来自依赖 X"）：只有 X 本身被完全豁免才算放行。
      uncoveredReferences = referenced.filter((dep) => evaluate(dep).allowed !== true);
    }
    const allowed = uncoveredAdvisories.length === 0 && uncoveredReferences.length === 0 && (advisories.length > 0 || referenced.length > 0);
    const verdict = {
      allowed,
      ...(allowed
        ? { via_allowlist: [...advisories, ...referenced] }
        : {
            ...(uncoveredAdvisories.length > 0 ? { uncovered_advisories: uncoveredAdvisories } : {}),
            ...(uncoveredReferences.length > 0 ? { uncovered_references: uncoveredReferences } : {}),
          }),
    };
    evaluating.delete(name);
    verdicts.set(name, verdict);
    return verdict;
  };

  const allowed = [];
  const blocked = [];
  for (const name of Object.keys(vulnerabilities).sort()) {
    const verdict = evaluate(name);
    const row = {
      name,
      severity: vulnerabilities[name].severity ?? "unknown",
      ...(verdict.allowed ? { via_allowlist: verdict.via_allowlist } : {}),
      ...(verdict.uncovered_advisories ? { uncovered_advisories: verdict.uncovered_advisories } : {}),
      ...(verdict.uncovered_references ? { uncovered_references: verdict.uncovered_references } : {}),
    };
    (verdict.allowed ? allowed : blocked).push(row);
  }
  return {
    allowed,
    blocked,
    counts: audit?.metadata?.vulnerabilities ?? {},
    allowlist_size: active.size,
  };
}
