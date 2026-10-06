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
 * 文件商品 → Catalog listing 发布内核（A4 桥接；设计 v0.1.2 §10.1 商品表 +
 * product-strategy rev1.1 §4.5 签名发布的最小拼接）。
 *
 * 定位：Cloud Runtime 进程内的发布**内核**，供工作台 API（owner 会话 + CSRF +
 * 本人最终确认）与后续 UI 调用。与 `kiwi merchant publish`（CLI 编排，读
 * shopping-cli 投影）互不替代：
 *   - 输入是**文件商品权威表**（products_file，A1 导入链路的同一事实源）；
 *   - 只发布**显式选定**的 SKU + 用户在预览里逐行填写的非空 category；
 *     绝不隐式全表发布，绝不编造分类；
 *   - 公开投影严格复用 `canonicalizeCatalogListing` 白名单：name-only 公开
 *     元数据，**不含价格/库存/底价/私有规则/联系方式/owner token**，也不把
 *     major-unit Number 伪装成 exact 金额；
 *   - preview 只读（唯一网络动作是 Catalog 公开绑定状态 GET），冻结 payload、
 *     产品快照 digest、已验证绑定身份与期限后落盘不可变草稿（0600，原子写）；
 *   - commit 是**唯一**发出 publish 写的方法：重验绑定/租户/快照 digest/预览
 *     期限，任一不符拒绝并要求重新预览；逐项持久化回执，部分失败如实返回
 *     partial/pending；远端响应丢失后只以相同 frozen payload + 相同幂等键续办
 *     （幂等键派生自 bindingId+payload digest，与 product-publish.ts 同策略），
 *     重复/并发/重启续办都不会创建重复 listing；
 *   - 本内核绝不撤回/删除任何其他 listing，不新增自动全量同步；GET/导入/
 *     定时器绝不会走到发布写。
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentProfile } from "../config/profile.js";
import { canonicalize } from "../negotiation/jcs.js";
import { CatalogClient, type CatalogClientError } from "./catalog-client.js";
import {
  canonicalizeCatalogListing,
  resolveSignedListingContext,
  signedListingDigest,
} from "./listing-publisher.js";
import { loadProductTableSnapshot, type CloudProductRecord } from "./product-source.js";

/** 预览/草稿共同 schema 版本（内核本地文件，随破坏性变更递增）。 */
export const FILE_LISTING_PUBLICATION_SCHEMA_VERSION = "0.1";

/** canonicalizeCatalogListing 的 fresh_until 上限（30 天），本内核不放宽。 */
const MAX_FRESH_DAYS = 30;

/** 草稿 id 严格格式：flp_<epoch36>_<12hex>；路径只允许在匹配后再拼接。 */
const DRAFT_ID_PATTERN = /^flp_[a-z0-9]+_[0-9a-f]{12}$/;
/** One Runtime process owns the state directory; serialize same-draft writers across service instances. */
const draftCommitTails = new Map<string, Promise<void>>();

export class FileListingPublicationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FileListingPublicationError";
    this.code = code;
  }
}

export interface FileListingPublicationOptions {
  /** Runtime dataDir（enrollment/私钥所在；草稿与回执同存此目录下，0700/0600）。 */
  dataDir: string;
  /**
   * 商家 profile：`owner_id` 校验文件商品表租户；`merchant_public.public_url`
   * 作为 runtime origin 的缺省来源（与 CLI 发布编排同语义）。
   */
  profile: AgentProfile;
  /** 文件商品权威表路径（products_file）。 */
  productsFile: string;
  /** Catalog base URL。 */
  catalogUrl: string;
  /** 当前公网 Runtime origin（地址迁移守卫；缺省读 profile.merchant_public.public_url）。 */
  publicOrigin?: string;
  /** 测试缝。 */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** 预览有效期（毫秒；缺省 15 分钟）。 */
  previewTtlMs?: number;
  /** fresh_until 窗口（天；缺省/上限均为 30，另受商品有效期约束）。 */
  freshDays?: number;
}

export interface FileListingSelection {
  /** 明确选定的 SKU（文件商品表主键）。 */
  sku: string;
  /** 用户在预览里逐行显式填写的非空分类；内核不做任何猜测或补全。 */
  category: string;
}

export interface FileListingPreviewItem {
  sku: string;
  category: string;
  status: "ready";
  /** 冻结的 canonical 公开 payload（canonicalizeCatalogListing 输出，只读展示）。 */
  listing: Record<string, unknown>;
  listing_digest: string;
  /** 冻结的发布幂等键（派生自 bindingId+digest；重复/续办恒同键）。 */
  idempotency_key: string;
}

export interface FileListingPreview {
  schema_version: string;
  draft_id: string;
  /** 提交时的 expectedDigest。 */
  digest: string;
  created_at: string;
  expires_at: string;
  /** 冻结时的文件商品表快照 digest；commit 复验。 */
  products_digest: string;
  binding: {
    agent_id: string;
    merchant_id: string;
    binding_id: string;
    key_id: string;
    runtime_origin: string;
  };
  items: FileListingPreviewItem[];
}

export interface FileListingReceiptItem {
  sku: string;
  /** succeeded=已确认；failed=Catalog 稳定拒绝（错误码可展示）；pending=结果未知（可续办）。 */
  status: "succeeded" | "failed" | "pending";
  listing_id?: string;
  /** 稳定错误码（远端码或本地通用码）；绝不含原始错误文本/URL/凭据。 */
  code?: string;
}

export interface FileListingCommitResult {
  draft_id: string;
  digest: string;
  status: "succeeded" | "partial" | "failed" | "pending";
  succeeded: number;
  failed: number;
  pending: number;
  results: FileListingReceiptItem[];
}

export interface FileListingDraftView {
  draft: FileListingPreview | undefined;
  receipts: FileListingReceiptItem[];
  found: boolean;
}

interface StoredDraft extends FileListingPreview {
  kind: "file_listing_publication";
}

interface StoredReceipts {
  schema_version: string;
  draft_id: string;
  updated_at: string;
  /** sku → 回执；attempts 仅内部续办观察用，不进对外投影。 */
  items: Record<string, { status: FileListingReceiptItem["status"]; listing_id?: string; code?: string; attempts: number }>;
}

function requireNonEmptyText(value: unknown, field: string, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FileListingPublicationError(code, `${field} 必须是非空文本`);
  }
  return value;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 预览 digest：对冻结内容做 JCS 规范化后整体摘要（digest 字段自身不入摘要）。 */
function previewDigest(draft: Omit<StoredDraft, "digest">): string {
  return `sha256:${sha256Hex(canonicalize(draft))}`;
}

/** dataDir 与 enrollment/私钥同级同规：0700 普通目录，软链/宽松权限直接拒绝。 */
function assertPrivateDir(dir: string, what: string): void {
  // lstat（非 stat）：软链自身不满足 isDirectory，直接拒绝。
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {
    throw new FileListingPublicationError(
      "DATA_DIR_PERMISSIONS",
      `${what} 必须是权限为 0700 的真实目录（拒绝软链/宽松权限）`,
    );
  }
}

/** 草稿/回执文件：0600 普通文件；已存在的软链或宽松权限拒绝读/写。 */
function assertPrivateFile(file: string, what: string): void {
  if (!existsSync(file)) return;
  const stats = lstatSync(file);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw new FileListingPublicationError(
      "DRAFT_FILE_PERMISSIONS",
      `${what} 必须是权限为 0600 的普通文件（拒绝软链/宽松权限）`,
    );
  }
}

function publicationDir(dataDir: string, segment: "drafts" | "receipts"): string {
  if (!existsSync(dataDir)) {
    throw new FileListingPublicationError("DATA_DIR_MISSING", "Runtime dataDir 不存在：无法存取发布草稿");
  }
  assertPrivateDir(dataDir, "Runtime dataDir");
  const root = path.join(dataDir, "listing-publication");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivateDir(root, "发布目录 listing-publication");
  const dir = path.join(root, segment);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir, `发布目录 ${segment}`);
  return dir;
}

/** 原子写 0600：同目录临时文件 + rename（与商品表提交同纪律）；已存在为软链/宽权限则拒绝。 */
function writeAtomic(file: string, value: unknown, what: string): void {
  assertPrivateFile(file, what);
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** fresh_until：不晚于 freshDays 窗口，也不晚于商品有效期；秒精度 +00:00。 */
function computeFreshUntil(nowMs: number, validUntil: string, freshDays: number): string {
  const validMs = Date.parse(validUntil);
  const windowMs = nowMs + Math.min(freshDays, MAX_FRESH_DAYS) * 86_400_000;
  const freshMs = Math.min(windowMs, Number.isFinite(validMs) ? validMs : windowMs);
  return new Date(Math.floor(freshMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** 与 product-publish.ts 完全同源的幂等键策略（bindingId + payload digest）。 */
function listingIdempotencyKey(bindingId: string, listingDigest: string): string {
  return `kiwi-listing:${sha256Hex(`${bindingId}:${listingDigest}`)}`;
}

/**
 * Catalog 确定性拒绝码白名单（与 product-publish.ts 的商家指引词汇一致）。
 * 远端错误码是运行时字符串，**绝不原样反射**：白名单之外一律归并为通用码。
 */
const KNOWN_REMOTE_CODES = new Set([
  "LISTINGS_CAPACITY_EXCEEDED",
  "LISTINGS_ENTITLEMENT_SUSPENDED",
  "LISTINGS_ACCOUNT_NOT_READY",
  "LISTINGS_GOVERNANCE_HOLD",
]);

function remoteReceiptCode(remoteCode: string | undefined): string | undefined {
  return remoteCode !== undefined && KNOWN_REMOTE_CODES.has(remoteCode) ? remoteCode : "LISTING_PUBLISH_REJECTED";
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createFileListingPublicationService(options: FileListingPublicationOptions): {
  preview: (selections: readonly FileListingSelection[]) => Promise<FileListingPreview>;
  commit: (draftId: string, expectedDigest: string) => Promise<FileListingCommitResult>;
  getDraft: (draftId: string) => Promise<FileListingDraftView>;
} {
  const now = options.now ?? (() => new Date());
  const previewTtlMs = options.previewTtlMs ?? 15 * 60_000;
  const freshDays = Math.min(options.freshDays ?? MAX_FRESH_DAYS, MAX_FRESH_DAYS);
  if (!Number.isFinite(previewTtlMs) || previewTtlMs <= 0) {
    throw new FileListingPublicationError("INVALID_OPTIONS", "previewTtlMs 必须是正数");
  }
  const client = new CatalogClient({ baseUrl: options.catalogUrl, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) });

  const draftPath = (draftId: string): string => {
    requireNonEmptyText(draftId, "draft_id", "INVALID_DRAFT_ID");
    if (!DRAFT_ID_PATTERN.test(draftId)) {
      throw new FileListingPublicationError("INVALID_DRAFT_ID", "draft_id 格式非法");
    }
    return path.join(publicationDir(options.dataDir, "drafts"), `${draftId}.json`);
  };

  const receiptsPath = (draftId: string): string =>
    path.join(publicationDir(options.dataDir, "receipts"), `${draftId}.receipts.json`);

  /** 只读解析当前可发布绑定；无已发布接入时 fail-closed，不回退 owner token。 */
  const requireActiveBinding = async () => {
    const context = await resolveSignedListingContext({
      dataDir: options.dataDir,
      profile: options.profile,
      catalogBaseUrl: options.catalogUrl,
      ...(options.publicOrigin !== undefined ? { runtimeOrigin: options.publicOrigin } : {}),
      client,
    });
    if (context === null) {
      throw new FileListingPublicationError(
        "LISTING_PUBLISH_NOT_CONNECTED",
        "尚未完成 Runtime 连接与名片发布；请先完成接入再发布商品",
      );
    }
    return context;
  };

  const loadTable = () => loadProductTableSnapshot(options.productsFile, options.profile.owner_id);

  async function preview(selections: readonly FileListingSelection[]): Promise<FileListingPreview> {
    if (!Array.isArray(selections) || selections.length === 0) {
      throw new FileListingPublicationError(
        "INVALID_SELECTION",
        "selections 不能为空；本内核只发布显式选定的 SKU，不做隐式全表发布",
      );
    }
    const seen = new Set<string>();
    const cleaned = selections.map((selection) => {
      const sku = requireNonEmptyText(selection?.sku, "selection.sku", "INVALID_SELECTION").trim();
      if (seen.has(sku)) {
        throw new FileListingPublicationError("INVALID_SELECTION", `selections 中存在重复 SKU：${sku}`);
      }
      seen.add(sku);
      const category = requireNonEmptyText(selection?.category, `selection.category（${sku}）`, "CATEGORY_REQUIRED").trim();
      return { sku, category };
    });

    const binding = await requireActiveBinding();
    const snapshot = loadTable();
    const nowMs = now().getTime();
    const bySku = new Map<string, CloudProductRecord>(snapshot.records.map((record) => [record.sku, record]));

    const items: FileListingPreviewItem[] = cleaned.map(({ sku, category }) => {
      const record = bySku.get(sku);
      if (record === undefined) {
        throw new FileListingPublicationError("SKU_UNKNOWN", `SKU 不在文件商品表中：${sku}`);
      }
      if (record.status !== "active") {
        throw new FileListingPublicationError("PRODUCT_PAUSED", `SKU 处于暂停状态，不可发布：${sku}`);
      }
      if (Date.parse(record.valid_until) <= nowMs) {
        throw new FileListingPublicationError("PRODUCT_EXPIRED", `SKU 有效期已过，不可发布：${sku}`);
      }
      const listing = canonicalizeCatalogListing(
        {
          listing_type: "product",
          source_product_ref: sku,
          title: record.title,
          category,
          source_revision: `file:${record.updated_at}`,
          fresh_until: computeFreshUntil(nowMs, record.valid_until, freshDays),
        },
        binding.agentId,
        binding.merchantId,
      );
      const listingDigest = signedListingDigest(listing);
      return {
        sku,
        category,
        status: "ready" as const,
        listing,
        listing_digest: listingDigest,
        idempotency_key: listingIdempotencyKey(binding.bindingId, listingDigest),
      };
    });

    const stamp = new Date(nowMs).toISOString();
    const draftId = `flp_${nowMs.toString(36)}_${randomBytes(6).toString("hex")}`;
    const base: Omit<StoredDraft, "digest"> = {
      kind: "file_listing_publication",
      schema_version: FILE_LISTING_PUBLICATION_SCHEMA_VERSION,
      draft_id: draftId,
      created_at: stamp,
      expires_at: new Date(nowMs + previewTtlMs).toISOString(),
      products_digest: snapshot.digest,
      binding: {
        agent_id: binding.agentId,
        merchant_id: binding.merchantId,
        binding_id: binding.bindingId,
        key_id: binding.keyId,
        runtime_origin: binding.runtimeOrigin,
      },
      items,
    };
    const draft: StoredDraft = { ...base, digest: previewDigest(base) };
    writeAtomic(draftPath(draftId), draft, "发布草稿");
    return deepClone(draft);
  }

  function loadDraft(draftId: string): StoredDraft {
    const file = draftPath(draftId);
    assertPrivateFile(file, "发布草稿");
    if (!existsSync(file)) {
      throw new FileListingPublicationError("DRAFT_NOT_FOUND", `发布草稿不存在：${draftId}`);
    }
    let parsed: unknown;
    try {
      parsed = readJsonFile(file);
    } catch {
      throw new FileListingPublicationError("DRAFT_CORRUPTED", "发布草稿文件损坏；请重新预览");
    }
    const draft = parsed as StoredDraft;
    if (draft?.kind !== "file_listing_publication" || draft?.draft_id !== draftId || !Array.isArray(draft?.items)) {
      throw new FileListingPublicationError("DRAFT_CORRUPTED", "发布草稿内容不合法；请重新预览");
    }
    // 完整性重验：不信任文件里的 digest 字段本身——重新计算冻结内容的 JCS
    // 摘要并比对，文件损坏/篡改后即使用旧摘要也签不出改变的 payload。
    const { digest: storedDigest, ...frozen } = draft;
    if (typeof storedDigest !== "string" || previewDigest(frozen) !== storedDigest) {
      throw new FileListingPublicationError("DRAFT_CORRUPTED", "发布草稿冻结内容与摘要不符；请重新预览");
    }
    // 逐项核对：payload 摘要、身份归属、幂等键派生链都必须与冻结绑定自洽。
    for (const item of draft.items) {
      if (signedListingDigest(item.listing) !== item.listing_digest ||
          item.listing["owner_agent_id"] !== draft.binding.agent_id ||
          item.listing["merchant_id"] !== draft.binding.merchant_id ||
          listingIdempotencyKey(draft.binding.binding_id, item.listing_digest) !== item.idempotency_key) {
        throw new FileListingPublicationError("DRAFT_CORRUPTED", "发布草稿条目与冻结身份/摘要不一致；请重新预览");
      }
    }
    return draft;
  }

  function loadReceipts(draftId: string): StoredReceipts {
    const file = receiptsPath(draftId);
    assertPrivateFile(file, "发布回执");
    if (!existsSync(file)) {
      return { schema_version: FILE_LISTING_PUBLICATION_SCHEMA_VERSION, draft_id: draftId, updated_at: "", items: {} };
    }
    try {
      const parsed = readJsonFile(file) as StoredReceipts;
      if (parsed?.draft_id !== draftId || typeof parsed?.items !== "object" || parsed.items === null) {
        throw new Error("shape");
      }
      return parsed;
    } catch {
      // 回执损坏不阻塞续办：当作无回执重放（幂等键保证远端不重复）。
      return { schema_version: FILE_LISTING_PUBLICATION_SCHEMA_VERSION, draft_id: draftId, updated_at: "", items: {} };
    }
  }

  /** 回执合并：并发/先后写同一草稿时按状态优先级收敛，后写不覆盖更优回执。 */
  function mergeReceipts(base: StoredReceipts, incoming: StoredReceipts): StoredReceipts {
    const rank: Record<FileListingReceiptItem["status"], number> = { succeeded: 3, failed: 2, pending: 1 };
    const items = { ...base.items };
    for (const [sku, entry] of Object.entries(incoming.items)) {
      const current = items[sku];
      if (current === undefined ||
          rank[entry.status] > rank[current.status] ||
          (entry.status === current.status && entry.attempts > current.attempts)) {
        items[sku] = entry;
      }
    }
    return { ...base, items };
  }

  async function commit(draftId: string, expectedDigest: string): Promise<FileListingCommitResult> {
    requireNonEmptyText(expectedDigest, "expected_digest", "DRAFT_DIGEST_MISMATCH");
    const draft = loadDraft(draftId);
    if (expectedDigest !== draft.digest) {
      throw new FileListingPublicationError("DRAFT_DIGEST_MISMATCH", "预览摘要不匹配；请以最新预览的 digest 提交");
    }
    if (Date.parse(draft.expires_at) <= now().getTime()) {
      throw new FileListingPublicationError("PREVIEW_EXPIRED", "预览已过期；请重新预览后提交");
    }
    const binding = await requireActiveBinding();
    if (
      binding.agentId !== draft.binding.agent_id ||
      binding.merchantId !== draft.binding.merchant_id ||
      binding.bindingId !== draft.binding.binding_id ||
      binding.keyId !== draft.binding.key_id ||
      binding.runtimeOrigin !== draft.binding.runtime_origin
    ) {
      throw new FileListingPublicationError(
        "BINDING_CHANGED",
        "当前绑定身份与预览冻结的绑定不一致（可能已重连/换钥/迁移地址）；请重新预览",
      );
    }
    const snapshot = loadTable();
    if (snapshot.digest !== draft.products_digest) {
      throw new FileListingPublicationError("PRODUCTS_CHANGED", "文件商品表自预览以来已变化；请基于最新商品重新预览");
    }

    const receiptsFile = receiptsPath(draftId);
    let receipts = loadReceipts(draftId);
    const results: FileListingReceiptItem[] = [];
    let succeeded = 0;
    let failed = 0;
    let pending = 0;
    for (const item of draft.items) {
      // 并发/重启续办：每项发布前重读回执并合并——同草稿的另一个 commit 已拿到
      // succeeded 的项直接复用，不重发、不覆盖更优回执。
      receipts = mergeReceipts(receipts, loadReceipts(draftId));
      const previous = receipts.items[item.sku];
      if (previous?.status === "succeeded") {
        succeeded += 1;
        results.push({ sku: item.sku, status: "succeeded", listing_id: previous.listing_id });
        continue;
      }
      const attempts = (previous?.attempts ?? 0) + 1;
      try {
        const receipt = await client.publishSignedListing(
          {
            catalogAgentId: draft.binding.agent_id,
            merchantId: draft.binding.merchant_id,
            bindingId: draft.binding.binding_id,
            idempotencyKey: item.idempotency_key,
            listingDigest: item.listing_digest,
            listing: item.listing,
          },
          binding.signingIdentity,
        );
        succeeded += 1;
        receipts.items[item.sku] = { status: "succeeded", listing_id: receipt.listingId, attempts };
        results.push({ sku: item.sku, status: "succeeded", listing_id: receipt.listingId });
      } catch (err) {
        const remoteCode = (err as Partial<CatalogClientError>)?.remoteCode;
        // remoteCode=Catalog 的确定性决定（额度/治理/校验）→ failed，且只透出
        // 白名单内的稳定码；其余（网络中断/响应不完整，无法证明未执行）→
        // pending，统一通用码。两者都绝不反射远端/原始错误文本。
        const status: FileListingReceiptItem["status"] =
          typeof remoteCode === "string" && remoteCode !== "" ? "failed" : "pending";
        const code = status === "failed" ? remoteReceiptCode(remoteCode) : "PUBLISH_UNCERTAIN";
        if (status === "failed") failed += 1;
        else pending += 1;
        receipts.items[item.sku] = { status, code, attempts };
        results.push({ sku: item.sku, status, code });
      }
      // 逐项原子落盘：进程在下一项前崩溃，已得到结果的项回执仍在盘上。
      receipts.updated_at = now().toISOString();
      writeAtomic(receiptsFile, receipts, "发布回执");
    }

    const status: FileListingCommitResult["status"] =
      succeeded === draft.items.length
        ? "succeeded"
        : succeeded > 0
          ? "partial"
          : failed > 0 && pending === 0
            ? "failed"
            : "pending";
    return { draft_id: draft.draft_id, digest: draft.digest, status, succeeded, failed, pending, results };
  }

  async function getDraft(draftId: string): Promise<FileListingDraftView> {
    let file: string;
    try {
      file = draftPath(draftId);
    } catch (err) {
      if (err instanceof FileListingPublicationError && err.code === "INVALID_DRAFT_ID") throw err;
      throw err;
    }
    if (!existsSync(file)) {
      return { draft: undefined, receipts: [], found: false };
    }
    const draft = loadDraft(draftId);
    const receipts = loadReceipts(draftId);
    return {
      draft: deepClone(draft),
      receipts: draft.items.map((item) => {
        const entry = receipts.items[item.sku];
        return entry === undefined
          ? { sku: item.sku, status: "pending" as const }
          : {
              sku: item.sku,
              status: entry.status,
              ...(entry.listing_id !== undefined ? { listing_id: entry.listing_id } : {}),
              ...(entry.code !== undefined ? { code: entry.code } : {}),
            };
      }),
      found: true,
    };
  }

  async function serializedCommit(draftId: string, expectedDigest: string): Promise<FileListingCommitResult> {
    const file = draftPath(draftId);
    const previous = draftCommitTails.get(file) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    draftCommitTails.set(file, tail);
    await previous;
    try {
      return await commit(draftId, expectedDigest);
    } finally {
      release();
      if (draftCommitTails.get(file) === tail) draftCommitTails.delete(file);
    }
  }
  return { preview, commit: serializedCommit, getDraft };
}
