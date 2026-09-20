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
 * 移交材料（设计 v0.1.1 §11.2 prepare_handoff、§16.3、§16.4）。
 *
 *   - 首版移交只生成文件包：客户报价、规范需求、证据目录、报价版本与
 *     校验摘要。origin.kind=manual_quote 引用 quote/release；knp_agreement
 *     必须引用真实已校验 agreement_id——二者不能靠补一个字段混同。
 *   - 包已生成 ≠ 目标系统已受理（PACKET_READY）；人工提交后保存
 *     OWNER_RECORDED；只有目标系统凭据查询或目标方签发且绑定
 *     packet_digest 的回执才是 TARGET_VERIFIED。不接受模型自填 verified。
 */

import { randomUUID } from "node:crypto";
import { rfqContentDigest, RfqError, type PublicQuoteView, type RfqCaseFields } from "./types.js";
import type { RfqHandoffRow, RfqRepository } from "./repository.js";

export interface HandoffPacket {
  packet_version: "0.1.0";
  handoff_id: string;
  origin: { kind: "manual_quote"; quote_id: string; revision: number; release_id?: string };
  target_ref: string;
  intent_evidence_ref: string;
  quote: PublicQuoteView;
  requirements: RfqCaseFields;
  evidence_catalog: string[];
  created_at: string;
}

/** 组装移交包（内容确定性；digest 绑定包内容）。 */
export function buildHandoffPacket(input: {
  quoteId: string;
  revision: number;
  releaseId?: string;
  targetRef: string;
  intentEvidenceRef: string;
  quote: PublicQuoteView;
  requirements: RfqCaseFields;
  evidenceCatalog: string[];
  nowIso: string;
}): { packet: HandoffPacket; digest: string } {
  if (input.targetRef.trim() === "" || input.intentEvidenceRef.trim() === "") {
    throw new RfqError("validation", "移交需要目标系统引用与客户意向证据引用（不能为空）");
  }
  const packet: HandoffPacket = {
    packet_version: "0.1.0",
    handoff_id: `hnd_${randomUUID()}`,
    origin: {
      kind: "manual_quote",
      quote_id: input.quoteId,
      revision: input.revision,
      ...(input.releaseId !== undefined ? { release_id: input.releaseId } : {}),
    },
    target_ref: input.targetRef,
    intent_evidence_ref: input.intentEvidenceRef,
    quote: input.quote,
    requirements: input.requirements,
    evidence_catalog: input.evidenceCatalog,
    created_at: input.nowIso,
  };
  return { packet, digest: packetDigest(packet) };
}

/** packet_digest：包内容的规范摘要（回执必须绑定它，防重放/换包）。 */
export function packetDigest(packet: HandoffPacket): string {
  return rfqContentDigest(packet);
}

/** 人工提交回执（OWNER_RECORDED：操作者自述已提交给目标系统）。 */
export function recordOwnerRecorded(repo: RfqRepository, handoffId: string, actor: string): RfqHandoffRow {
  const existing = repo.getHandoff(handoffId);
  if (existing === undefined) throw new RfqError("not_found", `未知移交 ${handoffId}`);
  if (existing.status !== "PACKET_READY") {
    throw new RfqError("approval_stale", `移交 ${handoffId} 状态为 ${existing.status}，不能记录 OWNER_RECORDED`);
  }
  const updated: RfqHandoffRow = { ...existing, status: "OWNER_RECORDED", updated_at: new Date().toISOString() };
  repo.updateHandoffStatus(handoffId, "OWNER_RECORDED", actor);
  return updated;
}

/** 目标系统回执验证（首版 fail-closed：无目标系统凭据查询/签名回执通道）。 */
export function verifyTargetReceipt(): never {
  throw new RfqError(
    "unsupported_term",
    "目标系统回执验证尚未接入（TARGET_VERIFIED 需要 issuer/audience/handoff_id/packet_digest 绑定校验）；不接受模型自填 verified=true",
  );
}
