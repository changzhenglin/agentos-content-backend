// transaction.ts — ContentDb 事务包裹（生产实现，spec §4.2）。
//
// 根治点：朴素 BEGIN/COMMIT 走 Pool.query() 连接不安全（每次 query 可能拿到不同连接）。
// wrapPgPool 用 pool.connect() 拿专用连接：BEGIN → 回调 → COMMIT（抛错→ROLLBACK）→ finally release。
// 回调内所有 query 都经同一 client；连接泄漏不可能（release 在 finally）。
// 正确性论证（行锁串行化 + CAS 重检）见 spec §5。
import type { Queryable, QueryResultRow, TransactionalContentDb } from "../content/db.js";

export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  release(): void;
}

export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  connect(): Promise<PgClientLike>;
}

export function wrapPgPool(pool: PgPoolLike): TransactionalContentDb {
  return {
    query: (text, params) => pool.query(text, params),
    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: (text, params) => client.query(text, params),
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        // 注：COMMIT 通信失败 = 事务结果未知（spec §10 known hole 4）——
        // 服务端可能已提交而响应丢失；此处不做「必然回滚」绝对断言，报错路径不 emit audit
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          // ROLLBACK 失败：不遮盖原错误，记录后靠 finally release 回收连接
          console.error("[tx] ROLLBACK failed:", rollbackErr);
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
