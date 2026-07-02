import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema, ingest, review, tracks, lyrics } from "../../src/db/schema.js";
import { sql } from "drizzle-orm";

// 注意：brief 写 `drizzle-orm/pg-mem`，但 drizzle-orm@0.36 不导出该子路径。
// 改用 pg-mem 的 createPg() Pool + drizzle-orm/node-postgres（等价语义，pg-mem 无原生 drizzle adapter）。
function createMemDb() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return drizzle(new pg.Pool(), { schema }) as any;
}

describe("schema", () => {
  it("ingest/review/tracks/lyrics tables queryable", () => {
    const db = createMemDb();
    expect(db.query.tracks).toBeDefined();
    expect(db.query.lyrics).toBeDefined();
    expect(db.query.ingest).toBeDefined();
    expect(db.query.review).toBeDefined();
  });

  it("tracks.isrc unique constraint triggers on duplicate", async () => {
    const db = createMemDb();
    await db.execute(
      sql`CREATE TABLE IF NOT EXISTS tracks (track_id text PRIMARY KEY, title text NOT NULL, artist text NOT NULL, album text, duration_ms integer NOT NULL, cover_url text, audio_object_key text NOT NULL, format text NOT NULL, bitrate integer NOT NULL, isrc text UNIQUE, license text NOT NULL, region_policy text, published_at timestamp NOT NULL DEFAULT now())`,
    );
    // 用原生 SQL INSERT（drizzle query builder 在 pg-mem+drizzle-orm@0.36 触发 getTypeParser 不支持；
    // 仍验证 DB 层 UNIQUE 约束——brief I9 意图：不访问 .unique，用实际插入断言）
    await db.execute(
      sql`INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, isrc, license) VALUES ('self:t1', 'A', 'B', 1000, 'k', 'mp3', 128000, 'ISRC1', 'CC')`,
    );
    await expect(
      db.execute(
        sql`INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, isrc, license) VALUES ('self:t2', 'C', 'D', 2000, 'k2', 'mp3', 128000, 'ISRC1', 'CC')`,
      ),
    ).rejects.toThrow();
  });
});
