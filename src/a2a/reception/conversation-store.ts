/**
 * 商家接待会话存储（P0a）。
 *
 * 单商家实例、多买家：键为 merchantId + 可信主体 + contextId，绝不跨买家
 * 复用上下文。JSON 文件原子写；到期（默认 30 天）惰性清理。P0a 只要求
 * 单进程使用，多进程/多租户留给 P0b。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ReceptionConversation, ReceptionNeed } from "./types.js";

interface StoredConversation {
  merchantId: string;
  identity: string;
  contextId: string;
  need: ReceptionNeed;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  conversations: Record<string, StoredConversation>;
}

export interface ReceptionConversationStoreOptions {
  /** 绝对路径；父目录不存在时自动创建。 */
  file: string;
  now: () => string;
  /** 会话保留天数（D10：原文 30 天）。 */
  retentionDays?: number;
}

function keyOf(merchantId: string, identity: string, contextId: string): string {
  return JSON.stringify([merchantId, identity, contextId]);
}

export class ReceptionConversationStore {
  private readonly file: string;
  private readonly now: () => string;
  private readonly retentionDays: number;
  private state: StoreFile;

  constructor(options: ReceptionConversationStoreOptions) {
    this.file = options.file;
    this.now = options.now;
    this.retentionDays = options.retentionDays ?? 30;
    this.state = this.load();
    this.prune();
  }

  /** 读取会话；不存在或已过期返回 undefined。 */
  get(merchantId: string, identity: string, contextId: string): ReceptionConversation | undefined {
    this.prune();
    const stored = this.state.conversations[keyOf(merchantId, identity, contextId)];
    return stored === undefined ? undefined : this.toConversation(stored);
  }

  /** 写入最新需求；revision 由服务端单调递增。 */
  put(
    merchantId: string,
    identity: string,
    contextId: string,
    need: Omit<ReceptionNeed, "revision" | "updatedAt">,
  ): ReceptionConversation {
    const key = keyOf(merchantId, identity, contextId);
    const previous = this.state.conversations[key];
    const updatedAt = this.now();
    const stored: StoredConversation = {
      merchantId,
      identity,
      contextId,
      updatedAt,
      need: {
        ...need,
        revision: (previous?.need.revision ?? 0) + 1,
        updatedAt,
      },
    };
    this.state.conversations[key] = stored;
    this.save();
    return this.toConversation(stored);
  }

  private toConversation(stored: StoredConversation): ReceptionConversation {
    return {
      merchantId: stored.merchantId,
      identity: stored.identity,
      contextId: stored.contextId,
      need: stored.need,
    };
  }

  private load(): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
      if (parsed.version === 1 && typeof parsed.conversations === "object" && parsed.conversations !== null) {
        return parsed;
      }
    } catch {
      // 首次启动或坏文件：从空集开始，不阻断接待。
    }
    return { version: 1, conversations: {} };
  }

  private prune(): void {
    const cutoff = Date.parse(this.now()) - this.retentionDays * 86_400_000;
    let changed = false;
    for (const [key, stored] of Object.entries(this.state.conversations)) {
      const updated = Date.parse(stored.updatedAt);
      if (!Number.isFinite(updated) || updated < cutoff) {
        delete this.state.conversations[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
