/**
 * 以 access token 为键的客户端缓存：token 变化（续期/重授权）时创建新客户端，
 * 同一 token 复用 MCP 会话。只比较 token 字符串，不记录/打印 token。
 */
import type { StoredAdapterToken } from "./token-store.js";

export class TokenBoundClientCache<T> {
  private client: T | undefined;
  private token: string | undefined;

  async get(
    token: StoredAdapterToken,
    create: (token: StoredAdapterToken) => Promise<T>,
  ): Promise<T> {
    if (this.client !== undefined && this.token === token.access_token) return this.client;
    const next = await create(token);
    this.client = next;
    this.token = token.access_token;
    return next;
  }

  clear(): void {
    this.client = undefined;
    this.token = undefined;
  }
}
