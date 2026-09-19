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
 * 正式产物渲染与权限下载（设计 v0.1.1 §9.2、§10.2、§14.2、§14.3）。
 *
 *   - 正式文件 = 固定模板对 PublicQuoteView 的确定性渲染（同输入同字节）；
 *     内容哈希在 prepare 阶段冻结并绑定批准；激活后绝不重渲染。
 *   - 首版正式文件为 UTF-8 纯文本（不可执行）；PDF 渲染器为接缝
 *     （RfqPdfRenderer）：内置 PDF 路线仅支持 ASCII 内容——中文字体嵌入与
 *     许可证是设计 §21.2 待确认项（RFQ-010），缺能力显式拒绝，绝不静默
 *     降级或以「非约束性」字样冒充法律结果。
 *   - 产物文件保存于商家私有目录（0700）；下载以 artifact_id 映射相对
 *     路径，拒绝绝对路径与 `..`；读取时校验内容摘要——文件哈希与批准
 *     摘要不一致视为产物损坏（fail-closed）。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../fs/atomic-write.js";
import { RfqError, type PublicQuoteView } from "./types.js";

/** 内置文本模板版本（模板变化即字节变化 → 必须新建 release，§14.3）。 */
export const CUSTOMER_QUOTE_TEXT_TEMPLATE = "customer-quote-text-v1";
export const CUSTOMER_QUOTE_PDF_TEMPLATE = "customer-quote-pdf-v1";

/** PDF 渲染接缝（RFQ-010：中文字体嵌入/许可证确认后替换实现）。 */
export type RfqPdfRenderer = (projection: PublicQuoteView) => string;

function money(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}￥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function taxLabel(basis: string): string {
  return basis === "INCLUSIVE" ? "含税" : "未税";
}

/**
 * 纯文本客户报价文件（确定性渲染；数据全部来自 PublicQuoteView）。
 * 不含成本/底价/内部阈值/审批凭证（§14.2 禁止项）。
 */
export function renderCustomerQuoteText(projection: PublicQuoteView): string {
  const rows = projection.lines
    .map(
      (l) =>
        `- 行 ${l.line_id} | SKU ${l.sku} | ${l.quantity} ${l.unit} | 单价 ${money(l.unit_price_minor)}（${taxLabel(l.tax_basis)}，税率 ${l.tax_rate_bps}bps） | 行优惠 ${money(l.discount_minor)}`,
    )
    .join("\n");
  return [
    `报价编号：${projection.quote_id} 版本：v${projection.revision}`,
    `客户引用：${projection.recipient_ref}（项目：${projection.client_ref}）`,
    `币种：${projection.currency}`,
    "",
    "报价明细：",
    rows,
    `运费：${money(projection.shipping.amount_minor)}（${taxLabel(projection.shipping.tax_basis)}，税率 ${projection.shipping.tax_rate_bps}bps）`,
    "",
    `未税合计：${money(projection.totals.net_minor)}`,
    `税额合计：${money(projection.totals.tax_minor)}`,
    `应付合计：${money(projection.totals.gross_minor)}`,
    "",
    `交期（已确认表达）：${projection.delivery_terms}`,
    `付款条件：${projection.payment_terms}`,
    `报价有效期至：${projection.valid_until}`,
    `数据截至时间：${projection.data_as_of}`,
    "",
    "说明：",
    `- ${projection.nonbinding_execution_boundary}`,
    "- 报价基于数据截至时间的经营事实，不代表库存预留；过期后需重新确认。",
  ].join("\n");
}

function asciiOnly(text: string): boolean {
  return [...text].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126);
}

function pdfEscape(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** 内置 PDF 渲染（ASCII-only；内容超出 ASCII 显式拒绝——不伪造中文字形）。 */
export function renderCustomerQuotePdfAscii(projection: PublicQuoteView): string {
  const text = renderCustomerQuoteText(projection);
  if (!asciiOnly(text)) {
    throw new RfqError(
      "unsupported_term",
      "内置 PDF 渲染仅支持 ASCII 内容（中文字体嵌入为待确认项 RFQ-010）；请使用文本正式文件或注入支持 CJK 的渲染器",
    );
  }
  const lines = text.split("\n").map((l) => l.replaceAll(/[^\x20-\x7E]/g, ""));
  const content = [`BT`, `/F1 10 Tf`, `14 TL`, `50 780 Td`, ...lines.map((l) => `(${pdfEscape(l)}) Tj T*`), `ET`].join("\n");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return out;
}

export interface ArtifactWriteResult {
  artifact_id: string;
  content_sha256: string;
  relative_path: string;
  content_type: string;
  template_version: string;
}

export interface RfqArtifactStoreDeps {
  /** 商家私有产物根目录（数据库存相对路径；绝不存绝对路径）。 */
  root: string;
  now: () => string;
  pdfRenderer?: RfqPdfRenderer;
}

export class RfqArtifactStore {
  private readonly deps: RfqArtifactStoreDeps;

  constructor(deps: RfqArtifactStoreDeps) {
    this.deps = deps;
  }

  private static assertArtifactId(artifactId: string): void {
    if (!/^art_[0-9a-fA-F-]+$/.test(artifactId) || artifactId.includes("..")) {
      throw new RfqError("validation", "非法 artifact_id");
    }
  }

  /** 渲染并写入私有产物目录（prepare 阶段；未激活前不提供下载）。 */
  write(input: {
    artifactId: string;
    quoteId: string;
    format: "text" | "pdf";
    projection: PublicQuoteView;
  }): ArtifactWriteResult {
    const templateVersion =
      input.format === "text" ? CUSTOMER_QUOTE_TEXT_TEMPLATE : CUSTOMER_QUOTE_PDF_TEMPLATE;
    let content: string;
    let contentType: string;
    if (input.format === "text") {
      content = `${renderCustomerQuoteText(input.projection)}\n`;
      contentType = "text/plain; charset=utf-8";
    } else {
      const render = this.deps.pdfRenderer ?? renderCustomerQuotePdfAscii;
      content = render(input.projection);
      contentType = "application/pdf";
    }
    const sha = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    const relative = path.join("rfq-artifacts", `${input.quoteId}`, `${input.artifactId}.bin`);
    const absolute = path.resolve(this.deps.root, relative);
    if (!absolute.startsWith(path.resolve(this.deps.root) + path.sep)) {
      throw new RfqError("validation", "产物路径越界");
    }
    writeFileAtomic(absolute, content, { mode: 0o600 });
    return {
      artifact_id: input.artifactId,
      content_sha256: sha,
      relative_path: relative,
      content_type: contentType,
      template_version: templateVersion,
    };
  }

  /**
   * 权限读取（下载通道在调用前完成归属/登录/激活校验）：路径由服务端
   * artifact_id 映射；读取后校验内容摘要——摘要不一致 = 产物损坏/被篡改，
   * fail-closed 拒绝返回。
   */
  read(artifact: { artifact_id: string; relative_path: string; content_sha256: string }): string {
    RfqArtifactStore.assertArtifactId(artifact.artifact_id);
    const absolute = path.resolve(this.deps.root, artifact.relative_path);
    if (!absolute.startsWith(path.resolve(this.deps.root) + path.sep)) {
      throw new RfqError("validation", "产物路径越界（拒绝 ../ 与绝对路径）");
    }
    statSync(absolute); // 不存在即抛错（fail-closed）
    const content = readFileSync(absolute, "utf8");
    const sha = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    if (sha !== artifact.content_sha256) {
      throw new RfqError("validation", "产物内容摘要与批准摘要不一致（产物损坏或被篡改）");
    }
    return content;
  }

  /**
   * 未引用产物回收（有界清理；只删除本 store 命名空间内文件）。
   * olderThanMs：文件 mtime 早于该时间戳才回收（TTL，§10.4）——刚渲染的
   * 文件即使尚未入库也不立即删除；缺省 = 不看 TTL（原语义）。
   */
  cleanupUnreferenced(
    referencedRelativePaths: Set<string>,
    quoteIdPrefix: string,
    opts: { olderThanMs?: number } = {},
  ): number {
    return this.cleanupPrefix(this.prefixDir(quoteIdPrefix), "rfq-artifacts", quoteIdPrefix, referencedRelativePaths, opts.olderThanMs);
  }

  /** 全前缀扫描回收（root/rfq-artifacts 下每个 quote 前缀目录）。 */
  cleanupUnreferencedAll(referencedRelativePaths: Set<string>, opts: { olderThanMs?: number } = {}): number {
    const base = path.join(this.deps.root, "rfq-artifacts");
    let removed = 0;
    for (const prefix of readdirNames(base)) {
      removed += this.cleanupPrefix(path.join(base, prefix), "rfq-artifacts", prefix, referencedRelativePaths, opts.olderThanMs);
    }
    return removed;
  }

  private prefixDir(quoteIdPrefix: string): string {
    return path.join(this.deps.root, "rfq-artifacts", quoteIdPrefix);
  }

  private cleanupPrefix(
    dir: string,
    baseSegment: string,
    prefix: string,
    referencedRelativePaths: Set<string>,
    olderThanMs: number | undefined,
  ): number {
    let removed = 0;
    try {
      for (const name of readdirNames(dir)) {
        const absolute = path.join(dir, name);
        if (statSync(absolute).isDirectory()) continue;
        if (olderThanMs !== undefined && statSync(absolute).mtimeMs >= olderThanMs) continue;
        if (!referencedRelativePaths.has(path.join(baseSegment, prefix, name))) {
          rmFile(absolute);
          removed += 1;
        }
      }
    } catch {
      // 目录不存在 = 无可回收文件（有界清理，不抛错）。
    }
    return removed;
  }
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}

function rmFile(file: string): void {
  rmSync(file, { force: true });
}

export function ensureArtifactRoot(root: string): void {
  mkdirSync(path.join(root, "rfq-artifacts"), { recursive: true, mode: 0o700 });
}
