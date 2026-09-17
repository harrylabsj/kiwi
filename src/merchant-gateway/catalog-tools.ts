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
 * 商家连接器第 0 版目录工具（`kiwi_catalog_*`）。
 *
 * merchant-buddy 第 1 版设计 §3.3 / §4 执行控制与商家连接器发布计划 §3.2：
 * - 商家身份来自**已验证的 OAuth 主体**（`merchantId` 由入口从访问令牌解析，
 *   绝不来自工具参数）；目录凭据按该 merchant_id 从保管库取；
 * - 草稿是私有状态；`request_publish` **不写入 published**，只保存草稿并给出
 *   目录门户的确认入口——发布必须由商家本人在门户确认页批准；
 * - 无凭据/凭据失效时工具明确报「需要重新连接」，不返回过期数据。
 */

import type { ScopedMcpTools } from "../mcp/merchant-server.js";
import type { MerchantMcpCallResult, MerchantMcpToolDefinition } from "../mcp/merchant-tools.js";
import { CatalogSourceError } from "../discovery/catalog-source/errors.js";
import { trimTrailingSlashes } from "../net/url.js";
import type { MerchantPublicationClient } from "./catalog-publications.js";
import type { MerchantCredentialStore } from "./credential-vault.js";

const READ_TOOLS: ReadonlySet<string> = new Set([
  "kiwi_catalog_get_merchant_profile",
  "kiwi_catalog_get_publication_status",
]);
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "kiwi_catalog_save_publication_draft",
  "kiwi_catalog_request_publish",
  "kiwi_catalog_withdraw_publication",
]);

/** 工具所需 scope（读/写两类；与目录凭据 scope 同名）。 */
export function catalogToolScope(name: string): "catalog:read" | "catalog:write" {
  return WRITE_TOOLS.has(name) ? "catalog:write" : "catalog:read";
}

const DISPLAY_NAME_PARAM = { type: "string", description: "公开商家名称（买家可见）" } as const;
const TITLE_PARAM = { type: "string", description: "商品名（买家通过它搜索到你）" } as const;

const PUBLICATION_INPUT_SCHEMA = {
  type: "object",
  properties: {
    merchant_display_name: DISPLAY_NAME_PARAM,
    title: TITLE_PARAM,
    category: { type: "string", description: "类目（选填）" },
    summary: { type: "string", description: "公开简介（选填，买家可见）" },
    shop_platform: { type: "string", description: "店铺平台（选填，如 淘宝/京东）" },
    shop_url: { type: "string", description: "公开店铺链接（选填，http/https）" },
    faq: {
      type: "array",
      description: "公开 FAQ（选填；每项 question/answer，不得含电话或邮箱）",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
        required: ["question", "answer"],
        additionalProperties: false,
      },
    },
    expires_at: {
      type: "string",
      description: "资料有效期（选填，ISO 时间；到期后不再出现在搜索中）",
    },
  },
  required: ["merchant_display_name", "title"],
  additionalProperties: false,
} as const;

const PUBLICATION_ID_SCHEMA = {
  type: "object",
  properties: {
    publication_id: { type: "string", description: "公开资料 id（发布回执中的 publication_id）" },
  },
  required: ["publication_id"],
  additionalProperties: false,
} as const;

export interface CatalogToolDeps {
  client: MerchantPublicationClient;
  credentials: MerchantCredentialStore;
  /** 目录门户地址（发布确认入口）。 */
  portalBaseUrl: string;
  toolOptions?: { maxChars?: number };
}

const DEFAULT_MAX_CHARS = 8_000;

function ok(payload: Record<string, unknown>, maxChars: number): MerchantMcpCallResult {
  const text = JSON.stringify(payload);
  return {
    content: [
      {
        type: "text",
        text: text.length > maxChars ? `${text.slice(0, maxChars)}…（结果已截断）` : text,
      },
    ],
  };
}

function fail(message: string): MerchantMcpCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function readString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  return typeof value === "string" ? value.trim() : "";
}

function readFaq(args: Record<string, unknown>): Array<{ question: string; answer: string }> {
  const raw = args.faq;
  if (!Array.isArray(raw)) return [];
  const items: Array<{ question: string; answer: string }> = [];
  for (const element of raw) {
    if (element === null || typeof element !== "object") continue;
    const question = readString(element as Record<string, unknown>, "question");
    const answer = readString(element as Record<string, unknown>, "answer");
    if (question !== "" && answer !== "") items.push({ question, answer });
  }
  return items;
}

/**
 * 构建绑定到某个已验证商家的目录工具束。
 *
 * `merchantId` 必须来自 OAuth 访问令牌（入口解析），不能来自工具入参——
 * 这是第 0 版商家之间隔离的唯一依据。
 */
export function buildCatalogTools(merchantId: string, deps: CatalogToolDeps): ScopedMcpTools {
  const maxChars = deps.toolOptions?.maxChars ?? DEFAULT_MAX_CHARS;
  const portalUrl = `${trimTrailingSlashes(deps.portalBaseUrl)}/portal/publications`;

  const credential = (): string => {
    const stored = deps.credentials.get(merchantId);
    if (stored === undefined) {
      throw new CatalogSourceError(
        "session_rejected",
        "目录凭据不可用（未连接或已过期）：请重新连接「Kiwi 商家运营」，然后在 Buddy 中重试",
      );
    }
    return stored.token;
  };

  const credentialExpiry = (): string => {
    const stored = deps.credentials.get(merchantId);
    return stored?.expiresAt ?? "";
  };

  const draftInput = (args: Record<string, unknown>) => {
    const merchantDisplayName = readString(args, "merchant_display_name");
    const title = readString(args, "title");
    const category = readString(args, "category");
    const summary = readString(args, "summary");
    const shopPlatform = readString(args, "shop_platform");
    const shopUrl = readString(args, "shop_url");
    const expiresAt = readString(args, "expires_at");
    const faq = readFaq(args);
    return {
      merchantDisplayName,
      title,
      ...(category !== "" ? { category } : {}),
      ...(summary !== "" ? { summary } : {}),
      ...(shopPlatform !== "" ? { shopPlatform } : {}),
      ...(shopUrl !== "" ? { shopUrl } : {}),
      ...(faq.length > 0 ? { faq } : {}),
      ...(expiresAt !== "" ? { expiresAt } : {}),
    };
  };

  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<MerchantMcpCallResult>
  > = {
    kiwi_catalog_get_merchant_profile: async () => {
      const stored = deps.credentials.get(merchantId);
      return ok(
        {
          merchant_id: merchantId,
          connected: stored !== undefined,
          credential_expires_at: credentialExpiry(),
          portal_url: portalUrl,
          note:
            stored === undefined
              ? "尚未连接或凭据已过期：请重新连接「Kiwi 商家运营」后再管理公开资料。"
              : "公开资料为商家声明快照（买家看到「资料可查」，不可实时询价）；发布须在目录门户确认页批准。",
        },
        maxChars,
      );
    },
    kiwi_catalog_save_publication_draft: async (args) => {
      const input = draftInput(args);
      if (input.merchantDisplayName === "" || input.title === "") {
        return fail("缺少必填字段：merchant_display_name 与 title 都是必填");
      }
      const result = await deps.client.saveDraft(credential(), input);
      return ok(
        {
          publication_id: result.publication.publication_id,
          merchant_id: result.publication.merchant_id,
          title: result.publication.title,
          status: result.publication.status,
          version: result.publication.version,
          created: result.created,
          updated: result.idempotent,
          confirm_url: portalUrl,
          note: "已保存为私有草稿（未公开，采购专家搜索不到）。发布需你在目录门户的公开资料页确认。",
        },
        maxChars,
      );
    },
    kiwi_catalog_request_publish: async (args) => {
      const input = draftInput(args);
      if (input.merchantDisplayName === "" || input.title === "") {
        return fail("缺少必填字段：merchant_display_name 与 title 都是必填");
      }
      const result = await deps.client.saveDraft(credential(), input);
      return ok(
        {
          publication_id: result.publication.publication_id,
          status: result.publication.status,
          version: result.publication.version,
          confirm_url: portalUrl,
          note:
            "草稿已保存，但**尚未发布**：请在目录门户的公开资料页核对公开预览并点击确认发布。" +
            "确认前采购专家搜索不到该商品。",
        },
        maxChars,
      );
    },
    kiwi_catalog_get_publication_status: async (args) => {
      const publicationId = readString(args, "publication_id");
      if (publicationId === "") return fail("缺少 publication_id");
      const publication = await deps.client.getPublication(credential(), publicationId);
      return ok(
        {
          publication_id: publication.publication_id,
          merchant_id: publication.merchant_id,
          title: publication.title,
          status: publication.status,
          version: publication.version,
          published_at: publication.published_at,
          updated_at: publication.updated_at,
          expires_at: publication.expires_at,
          inquiry_available: publication.inquiry_available,
        },
        maxChars,
      );
    },
    kiwi_catalog_withdraw_publication: async (args) => {
      const publicationId = readString(args, "publication_id");
      if (publicationId === "") return fail("缺少 publication_id");
      const publication = await deps.client.withdraw(credential(), publicationId);
      return ok(
        {
          publication_id: publication.publication_id,
          status: publication.status,
          version: publication.version,
          note: "已撤回：该资料不再出现在采购专家的正常搜索中。",
        },
        maxChars,
      );
    },
  };

  const tools: MerchantMcpToolDefinition[] = [
    {
      name: "kiwi_catalog_get_merchant_profile",
      description:
        "读取当前已连接商家的目录身份与连接状态（只读）。返回 merchant_id、目录凭据是否可用，以及公开资料管理入口地址。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "kiwi_catalog_save_publication_draft",
      description:
        "保存商家公开资料草稿（私有，不公开）。必填 merchant_display_name 与 title；类目/简介/店铺链接/FAQ/有效期选填。" +
        "草稿不会出现在采购专家搜索结果中；公开前置请用 kiwi_catalog_request_publish。不得填写电话、邮箱等联系方式（会被目录拒绝）。",
      inputSchema: PUBLICATION_INPUT_SCHEMA,
    },
    {
      name: "kiwi_catalog_request_publish",
      description:
        "准备发布公开资料：保存草稿并返回目录门户的确认入口。**本工具不会把资料变成已发布**——必须由商家本人在门户核对公开预览并确认发布后才生效。",
      inputSchema: PUBLICATION_INPUT_SCHEMA,
    },
    {
      name: "kiwi_catalog_get_publication_status",
      description:
        "按 publication_id 查询公开资料状态（draft/published/withdrawn）、版本与更新时间。第 0 版资料恒为不可实时询价（inquiry_available=false）。",
      inputSchema: PUBLICATION_ID_SCHEMA,
    },
    {
      name: "kiwi_catalog_withdraw_publication",
      description:
        "撤回已发布的公开资料（终态）：撤回后不再出现在采购专家搜索结果中。撤回不会删除账号或历史版本。",
      inputSchema: PUBLICATION_ID_SCHEMA,
    },
  ];

  return {
    listTools: (scopes) =>
      tools.filter((tool) => {
        if (scopes === undefined) return true;
        return scopes.includes(catalogToolScope(tool.name));
      }),
    call: async (name, args, scopes) => {
      const handler = handlers[name];
      if (handler === undefined) {
        return fail(`未知工具：${name}`);
      }
      const required = catalogToolScope(name);
      if (scopes !== undefined && !scopes.includes(required)) {
        return fail(`scope 不足：${name} 需要 ${required}，请重新连接并授予该权限`);
      }
      if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
        return fail(`工具未注册：${name}`);
      }
      try {
        return await handler(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`目录操作失败：${message}`);
      }
    },
  };
}
