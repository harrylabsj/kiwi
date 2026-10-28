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

/** 发布门禁豁免判定的类型声明（实现见 shipping-audit.mjs）。 */

export interface AuditFinding {
  name: string;
  severity: string;
  via_allowlist?: string[];
  uncovered_advisories?: string[];
  uncovered_references?: string[];
}

export interface AuditDecision {
  allowed: AuditFinding[];
  blocked: AuditFinding[];
  counts: Record<string, number>;
  allowlist_size: number;
}

export interface ActiveAllowEntry {
  id: string;
  package: string;
  expires_at: string;
}

export function advisoryIdOf(via: unknown): string | null;

export function assertAllowList(allow: unknown, now: Date): Map<string, ActiveAllowEntry>;

export function classifyAudit(audit: unknown, allow: unknown, now?: Date): AuditDecision;
