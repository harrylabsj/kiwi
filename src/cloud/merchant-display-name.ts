import type { DatabaseSync, StatementSync } from "node:sqlite";

export const MERCHANT_DISPLAY_NAME_PLACEHOLDER = "待设置商家名称";

export function normalizeMerchantDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= 80 && name !== MERCHANT_DISPLAY_NAME_PLACEHOLDER
    ? name : undefined;
}

/** 工作台显示名可随时修改；进入授权后独立保留原名片预览的名称。 */
export class MerchantDisplayNameStore {
  private readonly read: StatementSync;
  private readonly write: StatementSync;

  constructor(db: DatabaseSync, private readonly merchantId: string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_display_names (
        merchant_id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        public_preview_name TEXT
      )
    `);
    this.read = db.prepare("SELECT display_name, public_preview_name FROM merchant_display_names WHERE merchant_id = ?");
    this.write = db.prepare(`
      INSERT INTO merchant_display_names (merchant_id, display_name, public_preview_name) VALUES (?, ?, ?)
      ON CONFLICT (merchant_id) DO UPDATE SET display_name = excluded.display_name,
        public_preview_name = COALESCE(excluded.public_preview_name, merchant_display_names.public_preview_name)
    `);
  }

  current(): string | undefined {
    return this.read.get(this.merchantId)?.["display_name"] as string | undefined;
  }

  publicPreview(): string | undefined {
    return (this.read.get(this.merchantId)?.["public_preview_name"] as string | null | undefined) ?? undefined;
  }

  save(name: string, updatePublicPreview: boolean): void {
    this.write.run(this.merchantId, name, updatePublicPreview ? name : null);
  }
}
