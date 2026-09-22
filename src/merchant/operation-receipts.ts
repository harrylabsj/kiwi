/**
 * 内部写的操作级回执原语（P2-1 第一刀：从 feed-store / grant-store 收敛）。
 *
 * **为什么存在**：kiwi 内部写没有下游服务可问，写后不确定时只能靠**自己的**回执
 * 判定副作用是否发生。广播（feed-store）先长出这套机制，授权（grant-store）随后
 * 逐字复制了一份——同一套「写前重放判定 + 同事务落回执 + 按商家隔离查询」出现
 * 两次后，第三次再写就是事故。收敛于此，新的内部写直接复用。
 *
 * 适用条件（三条都满足才用本原语）：
 *   1. 写入是 kiwi 内部写（回执落自己的库，不问下游）；
 *   2. 效果与回执必须**同事务**（调用方在事务内先 `replay`、生效后再 `record`）；
 *   3. 一个操作作用在一个实体上（表里有实体 id 列）。
 * 反例（刻意不用）：promotion / service-control 把操作引用直接写在**权威行**上
 * （approval_ref / resume_operation_id，与状态迁移同一个 UPDATE），不需要回执表。
 *
 * 表名与实体列名只接受调用方的**代码常量**（SQL 标识符不能参数化，且 DDL 必须与
 * 既有库逐字一致）。
 */

import type { DatabaseSync } from "node:sqlite";

/** 回执标识（输入侧）。`operationKind` 与执行器工具一一对应，`requestHash`
 *  覆盖语义输入：同 operation_id 换请求内容必须冲突，字段顺序不得造成假冲突。 */
export interface OperationReceiptIntent {
  operationId: string;
  operationKind: string;
  requestHash: string;
}

/** 回执记录（查询侧）。 */
export interface OperationReceiptRecord {
  operation_kind: string;
  entity_id: string;
  response: Record<string, unknown>;
}

/** 建表 DDL（与 feed-store / grant-store 既有库逐字一致；含按商家隔离索引）。 */
export function operationReceiptsSchema(table: string, entityColumn: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  operation_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  ${entityColumn} TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${table}_owner
  ON ${table}(merchant_id, operation_id);`;
}

export class MerchantOperationReceipts {
  private readonly db: DatabaseSync;
  private readonly table: string;
  private readonly entityColumn: string;
  private readonly now: () => string;
  private readonly conflictError: (message: string) => Error;

  constructor(options: {
    db: DatabaseSync;
    table: string;
    entityColumn: string;
    now: () => string;
    /** 各 store 自己的错误类型（version_conflict），由调用方注入。 */
    conflictError: (message: string) => Error;
  }) {
    this.db = options.db;
    this.table = options.table;
    this.entityColumn = options.entityColumn;
    this.now = options.now;
    this.conflictError = options.conflictError;
  }

  /**
   * 重放判定。**必须在写之前调用，且在调用方的同一事务内**：
   * 同 operation_id + 同请求摘要 → 返回原回执（不产生第二次效果）；
   * 同 operation_id + 不同请求/商家/kind → 冲突（不静默复用）。
   * 未带 operation 时返回 undefined（非决定路径不开回执）。
   */
  replay(
    merchantId: string,
    operation: OperationReceiptIntent | undefined,
  ): OperationReceiptRecord | undefined {
    if (operation === undefined) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE operation_id=?`)
      .get(operation.operationId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    if (
      String(row["merchant_id"]) !== merchantId ||
      String(row["request_hash"]) !== operation.requestHash ||
      String(row["operation_kind"]) !== operation.operationKind
    ) {
      throw this.conflictError("operation_id was reused with a different merchant or request");
    }
    return {
      operation_kind: String(row["operation_kind"]),
      entity_id: String(row[this.entityColumn]),
      response: JSON.parse(String(row["response_json"])) as Record<string, unknown>,
    };
  }

  /** 同事务落回执（调用方须在事务内）。未带 operation 时不落（非决定路径）。 */
  record(
    merchantId: string,
    operation: OperationReceiptIntent | undefined,
    entityId: string,
    response: Record<string, unknown>,
  ): void {
    if (operation === undefined) return;
    this.db
      .prepare(
        `INSERT INTO ${this.table}
         (operation_id, merchant_id, operation_kind, ${this.entityColumn}, request_hash,
          response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.operationId,
        merchantId,
        operation.operationKind,
        entityId,
        operation.requestHash,
        JSON.stringify(response),
        this.now(),
      );
  }

  /** 对账查询：按商家隔离，用 operationId 查本次操作落的回执。 */
  get(merchantId: string, operationId: string): OperationReceiptRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE operation_id=? AND merchant_id=?`)
      .get(operationId, merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      operation_kind: String(row["operation_kind"]),
      entity_id: String(row[this.entityColumn]),
      response: JSON.parse(String(row["response_json"])) as Record<string, unknown>,
    };
  }
}
