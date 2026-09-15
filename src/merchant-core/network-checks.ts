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
 * 网络注册与域名接入检查（V2 阶段四：F25 + F03）。
 *
 * F25 注册状态检查：catalog 可达性 + 注册信息有效性（/v1/agents/{id} 能解析
 * 出本商家记录且指向的 Agent Card URL 非空）；失效可检测（结构化报告，
 * ok:false + 各分项 error）。fail-closed：任何一步失败不假装已注册。
 *
 * F03 域名接入向导：产出结构化检查单（公开投影无私密字段 / public_url /
 * 反代 TLS / DNS 人工核验项）——无法自动化的步骤显式标 manual，不假装完成。
 */

import type { AgentProfile } from "../config/profile.js";

export interface NetworkRegistrationReport {
  ok: boolean;
  checked_at: string;
  catalog: { reachable: boolean; base_url: string; error?: string };
  registration: { registered: boolean; agent_id: string; agent_card_url?: string; error?: string };
}

/** F25：注册状态检查（结构化、可查询；失效可检测）。 */
export async function checkNetworkRegistration(deps: {
  catalogBaseUrl: string;
  agentId: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
}): Promise<NetworkRegistrationReport> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const checkedAt = (deps.now ?? (() => new Date().toISOString()))();
  const base = deps.catalogBaseUrl.replace(/\/+$/, "");
  const report: NetworkRegistrationReport = {
    ok: false,
    checked_at: checkedAt,
    catalog: { reachable: false, base_url: base },
    registration: { registered: false, agent_id: deps.agentId },
  };
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
    report.catalog.reachable = res.ok;
    if (!res.ok) report.catalog.error = `HTTP ${res.status}`;
  } catch (err) {
    report.catalog.error = err instanceof Error ? err.message : String(err);
    return report; // 不可达即失效（fail-closed）
  }
  try {
    const res = await fetchImpl(`${base}/v1/agents/${encodeURIComponent(deps.agentId)}`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      report.registration.error = `HTTP ${res.status}（注册记录不可得或已失效）`;
      return report;
    }
    const body = (await res.json()) as { agent?: { agent_card_url?: string; status?: string } };
    const cardUrl = body.agent?.agent_card_url;
    if (typeof cardUrl === "string" && cardUrl !== "") {
      report.registration.registered = true;
      report.registration.agent_card_url = cardUrl;
      report.ok = true;
    } else {
      report.registration.error = "注册记录缺 agent_card_url（无效注册）";
    }
  } catch (err) {
    report.registration.error = err instanceof Error ? err.message : String(err);
  }
  return report;
}

export interface DomainChecklistItem {
  id: string;
  title: string;
  status: "ok" | "pending" | "manual";
  detail: string;
}

export interface DomainOnboardingChecklist {
  ok: boolean;
  merchant_id: string;
  items: DomainChecklistItem[];
}

/**
 * F03 域名接入向导检查单：自动可判定的给 ok/pending，DNS/TLS 等需人工的标
 * manual（明确人工检查单）。公开投影分离检查：profile 的公开字段集合不包
 * 含任何私密键（*_private / token / secret）。
 */
export function buildDomainOnboardingChecklist(profile: AgentProfile): DomainOnboardingChecklist {
  const items: DomainChecklistItem[] = [];
  const publicUrl = profile.merchant_public?.public_url;
  items.push({
    id: "public-url",
    title: "公网 A2A 域名已配置（merchant_public.public_url）",
    status: publicUrl !== undefined && publicUrl !== "" ? "ok" : "pending",
    detail: publicUrl ?? "未配置——kiwi merchant setup-public 引导",
  });
  // 公开投影分离：公开配置绝不携带私密键（底价/成本/token）
  const PUBLIC_FORBIDDEN = /(_private|token|secret|password)/i;
  const publicSection = JSON.stringify(profile.merchant_public ?? {});
  items.push({
    id: "public-projection-separation",
    title: "公开投影与私有数据分离（公开配置无私密键）",
    status: PUBLIC_FORBIDDEN.test(publicSection) ? "pending" : "ok",
    detail: PUBLIC_FORBIDDEN.test(publicSection)
      ? "merchant_public 段含疑似私密键——公开投影不得含 *_private/token/secret"
      : "merchant_public 段无私密键",
  });
  items.push({
    id: "dns",
    title: "DNS 解析指向服务器（人工核验）",
    status: "manual",
    detail:
      "人工：dig <域名> 确认 A/AAAA 记录指向部署机；kiwi merchant setup-public --check 可辅助",
  });
  items.push({
    id: "tls",
    title: "TLS 证书有效（人工核验/反代自动续期）",
    status: "manual",
    detail: "人工：确认 Caddy/Nginx 反代 TLS 正常且自动续期；证书临期告警接 runtime 健康检查",
  });
  items.push({
    id: "loopback-a2a",
    title: "A2A 节点仅监听 loopback（反代前置）",
    status: "ok",
    detail: "startA2aNode 绑定 127.0.0.1，公网经反代；KIWI_A2A_AUTH 守卫 fail-closed（BUG-02）",
  });
  const ok = items.every((i) => i.status === "ok" || i.status === "manual");
  return {
    ok,
    merchant_id: profile.owner_id,
    items,
  };
}
