// db.ts — ContentDb port（业务函数依赖的 DB 抽象）。
//
// 设计根因：pg-mem + drizzle-orm@0.36 的 query builder / db.execute(sql`...${param}`)
// 均触发 "query.getSQL is not a function"（schema.test.ts 已记录该限制），
// 参数化查询只有走 pg Pool.query(text, params) 才在 pg-mem 与真实 Postgres 都可用。
// 故业务函数依赖此 port（{query(text, params)}），生产由 T7 注入 pg Pool，
// 测试由 pg-mem adapters.createPg().Pool 注入。hexagonal 解耦，不绑死 drizzle。
//
// 注意：此为 T5 对 brief（NodePostgresDatabase 入参）的适配性偏离，
// brief 意图（pg-mem 可测 + 参数化安全）驱动的必要支撑（②类必要支撑）。

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface ContentDb {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}
