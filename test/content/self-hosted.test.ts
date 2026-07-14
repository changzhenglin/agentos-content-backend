// self-hosted.test.ts — queryTracks lyrics ILIKE 扩测试（D10'）。
// 首选 pg-mem 真实表（tracks+lyrics），验真实 ILIKE+JOIN+去重。
// 若 pg-mem 不支持 DISTINCT ON 语法则回退 fake ContentDb by-pattern（见对应 case 注释）。

import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import type { ContentDb } from "../../src/content/db.js";
import { queryTracks } from "../../src/content/self-hosted.js";

/** pg-mem 真实表 ContentDb adapter：走 pg-mem Pool.query(text, params)，与生产 pg Pool 同路径。 */
function createMemContentDb(): ContentDb {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  return {
    query: async (text: string, params?: unknown[]) => {
      return pool.query(text, params);
    },
  };
}

/** 建 tracks + lyrics 表并插测试数据。 */
async function seedTables(db: ContentDb) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS tracks (track_id text PRIMARY KEY, title text NOT NULL, artist text NOT NULL, album text, duration_ms integer NOT NULL, cover_url text, audio_object_key text NOT NULL, format text NOT NULL, bitrate integer NOT NULL, isrc text UNIQUE, license text NOT NULL, region_policy text, published_at timestamp NOT NULL DEFAULT now())`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS lyrics (track_id text, line_index integer NOT NULL, timestamp_ms integer NOT NULL, text text NOT NULL, lyrics_license text NOT NULL)`,
  );
}

describe("queryTracks lyrics ILIKE 扩（D10'）", () => {
  it("无 intent → 既有 title/artist ILIKE（向后兼容）", async () => {
    const db = createMemContentDb();
    await seedTables(db);
    await db.query(
      `INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ('self:t2', '晴天', '周杰伦', 200000, 'k2', 'mp3', 128000, 'CC')`,
    );
    const r = await queryTracks(db, ["晴天"]);
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].track_id).toBe("self:t2");
    expect(r.candidates[0].title).toBe("晴天");
  });

  it("无 intent 无匹配 → candidates 空", async () => {
    const db = createMemContentDb();
    await seedTables(db);
    const r = await queryTracks(db, ["不存在的歌"]);
    expect(r.candidates).toEqual([]);
  });

  it("intent=lyric → lyrics.text ILIKE join tracks 返 candidates", async () => {
    const db = createMemContentDb();
    await seedTables(db);
    await db.query(
      `INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ('self:t1', '七里香', '周杰伦', 269000, 'k1', 'mp3', 128000, 'CC')`,
    );
    await db.query(
      `INSERT INTO lyrics (track_id, line_index, timestamp_ms, text, lyrics_license) VALUES ('self:t1', 0, 0, '雨下整夜', 'CC')`,
    );
    const r = await queryTracks(db, ["雨下整夜"], "lyric");
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].track_id).toBe("self:t1");
    expect(r.candidates[0].title).toBe("七里香");
  });

  it("intent=lyric 无匹配 → candidates 空", async () => {
    const db = createMemContentDb();
    await seedTables(db);
    await db.query(
      `INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ('self:t1', '七里香', '周杰伦', 269000, 'k1', 'mp3', 128000, 'CC')`,
    );
    await db.query(
      `INSERT INTO lyrics (track_id, line_index, timestamp_ms, text, lyrics_license) VALUES ('self:t1', 0, 0, '雨下整夜', 'CC')`,
    );
    const r = await queryTracks(db, ["不存在的歌词"], "lyric");
    expect(r.candidates).toEqual([]);
  });

  // codex P1 fold: 去重 case——一首歌多行歌词都含关键词，DISTINCT ON (t.track_id) 去重只返 1 个 track_id
  it("intent=lyric → 一首歌多行歌词匹配 DISTINCT ON 去重只返 1 个 track_id", async () => {
    const db = createMemContentDb();
    await seedTables(db);
    await db.query(
      `INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ('self:t1', '七里香', '周杰伦', 269000, 'k1', 'mp3', 128000, 'CC')`,
    );
    // 同一首歌 2 行歌词都含"雨"
    await db.query(
      `INSERT INTO lyrics (track_id, line_index, timestamp_ms, text, lyrics_license) VALUES ('self:t1', 0, 0, '雨下整夜', 'CC')`,
    );
    await db.query(
      `INSERT INTO lyrics (track_id, line_index, timestamp_ms, text, lyrics_license) VALUES ('self:t1', 1, 5000, '雨陪我等天明', 'CC')`,
    );
    const r = await queryTracks(db, ["雨"], "lyric");
    // 若无 DISTINCT ON，JOIN 会产生 2 行（每行歌词 1 行），去重后应只 1 个 track_id
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].track_id).toBe("self:t1");
  });
});
