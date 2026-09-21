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
 * 已验证主体与权限（BD 设计 §7.1/§7.2/§8.2）。
 *
 * 两条硬约束，都做了**可执行**的落地：
 *
 * 1. **`VerifiedActorContext` 只能由已完成认证的服务端模块构造**。
 *    类型层面用模块私有的 `SEAL` 品牌 + 运行时 `assertVerifiedActor()` 双重保证：
 *    手写的对象字面量（哪怕用 `as` 骗过类型检查）在运行时会被拒。业务参数里传来的
 *    `merchant_id` / `actor_id` **永远不能**被当成主体——那是 UC10 要挡的事。
 * 2. **即使上下文合法，服务层仍逐次复检权限与资源归属**（BD §8.1 表：
 *    「Repository／受控存储」那行明确"不能因来自内部调用而绕过规则"）。
 *
 * 四类授权互不替代（§7.1）：页面会话 / Runtime 服务身份 / Buyer 询价凭据 / Catalog
 * OAuth。本模块只表达**第一类**（商家页面会话派生出来的主体）。
 */

/** 角色（BD §7.2）：viewer 只读；operator 处理授予范围内的商品与询价；owner 才能确认权限扩张、恢复接待与资源删除。 */
export const MERCHANT_ROLES = ["owner", "operator", "viewer"] as const;
export type MerchantRole = (typeof MERCHANT_ROLES)[number];

/**
 * 权限点。**敏感策略读取是独立权限**（§7.2 末句），不随通用状态接口返回。
 */
export const MERCHANT_PERMISSIONS = [
  "status:read",
  "products:read",
  "policy:read",
  "approvals:read",
  "operations:read",
  "alerts:ack",
  "products:import",
  "products:draft",
  "products:decide",
  "policy:draft",
  "approvals:decide",
  "broadcast:draft",
  "broadcast:decide",
  "service:pause",
  // owner 专属：开通（创建云资源——BD §7.2「权限扩张/资源删除由 owner」同族）、
  // 恢复接待、读敏感策略、删资源
  "onboarding:manage",
  "policy:read_sensitive",
  "service:resume",
  "resources:delete",
  "grants:manage",
] as const;
export type MerchantPermission = (typeof MERCHANT_PERMISSIONS)[number];

/**
 * 角色 → 权限。**恢复接待/删资源/敏感策略只给 owner**（§7.2）；
 * 暂停是安全动作，operator 即可（越晚停损失越大）。
 */
const ROLE_PERMISSIONS: Readonly<Record<MerchantRole, readonly MerchantPermission[]>> = {
  viewer: ["status:read", "products:read", "policy:read", "approvals:read", "operations:read"],
  operator: [
    "status:read",
    "products:read",
    "policy:read",
    "approvals:read",
    "operations:read",
    "alerts:ack",
    "products:import",
    "products:draft",
    "products:decide",
    "policy:draft",
    "approvals:decide",
    "broadcast:draft",
    "broadcast:decide",
    "service:pause",
  ],
  owner: [
    "status:read",
    "products:read",
    "policy:read",
    "approvals:read",
    "operations:read",
    "alerts:ack",
    "products:import",
    "products:draft",
    "products:decide",
    "policy:draft",
    "approvals:decide",
    "broadcast:draft",
    "broadcast:decide",
    "service:pause",
    "onboarding:manage",
    "policy:read_sensitive",
    "service:resume",
    "resources:delete",
    "grants:manage",
  ],
};

export function permissionsForRole(role: MerchantRole): ReadonlySet<MerchantPermission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

/** 模块私有封印：只有本模块能造出带它的对象。 */
const SEAL = Symbol("kiwi.verified-actor");

/** 认证方式（用于审计与"哪类授权"的判断，不能互替）。 */
export type ActorAuthMethod = "admin-session" | "merchant-session" | "service-identity";

export interface VerifiedActorContext {
  readonly actorId: string;
  readonly merchantId: string;
  readonly role: MerchantRole;
  readonly permissions: ReadonlySet<MerchantPermission>;
  /** 有效期（ISO 8601，带时区）。过期即拒，不复用缓存许可（§7.1 末段）。 */
  readonly expiresAt: string;
  readonly authMethod: ActorAuthMethod;
  /** 当前部署代次：切换后旧代次不能继续批准/改策略/产生新报价（§12.3）。 */
  readonly generation: number;
  readonly requestId: string;
  /** 封印：非本模块构造的对象不会有这个键。 */
  readonly [SEAL]: true;
}

export class ActorContextError extends Error {
  readonly code: "forged_context" | "expired_context";
  constructor(code: ActorContextError["code"], message: string) {
    super(message);
    this.name = "ActorContextError";
    this.code = code;
  }
}

/**
 * 构造已验证主体。**只应由完成认证的模块调用**（管理会话校验通过之后）。
 *
 * 故意不做成"接受任意入参的公共工厂"：入参只有认证层手里才有的字段，
 * 且返回值带模块私有封印。
 */
export function createVerifiedActorContext(input: {
  actorId: string;
  merchantId: string;
  role: MerchantRole;
  authMethod: ActorAuthMethod;
  generation: number;
  requestId: string;
  /** 会话到期时间（ISO 8601）。 */
  expiresAt: string;
}): VerifiedActorContext {
  return {
    actorId: requireNonEmpty(input.actorId, "actorId"),
    merchantId: requireNonEmpty(input.merchantId, "merchantId"),
    role: input.role,
    permissions: permissionsForRole(input.role),
    expiresAt: requireNonEmpty(input.expiresAt, "expiresAt"),
    authMethod: input.authMethod,
    generation: input.generation,
    requestId: requireNonEmpty(input.requestId, "requestId"),
    [SEAL]: true,
  };
}

/**
 * 运行时校验主体：**手写的 `{merchant_id: "..."}` 一律拒**。
 *
 * 这是 UC10 的第一道闸：请求正文/路径/头里的字段不能提升或改变认证主体。
 */
export function assertVerifiedActor(value: unknown, now: Date = new Date()): VerifiedActorContext {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { [SEAL]?: unknown })[SEAL] !== true
  ) {
    throw new ActorContextError(
      "forged_context",
      "actor context was not produced by the authentication layer",
    );
  }
  const context = value as VerifiedActorContext;
  const expiresAt = Date.parse(context.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) {
    throw new ActorContextError("expired_context", "actor context has expired");
  }
  return context;
}

export function hasPermission(ctx: VerifiedActorContext, permission: MerchantPermission): boolean {
  return ctx.permissions.has(permission);
}

function requireNonEmpty(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new ActorContextError("forged_context", `${field} must be non-empty`);
  return text;
}
