// test helper：pg-mem ContentDb + schema 初始化。
//
// pg-mem + drizzle-orm@0.36 query builder 不可用（见 src/content/db.ts），
// 但 pg-mem adapters.createPg().Pool.query(text, params) 支持参数化 SQL，
// 满足 ContentDb port。schema 用 raw SQL CREATE（与 schema.test.ts 一致）。

import { newDb } from "pg-mem";
import type { ContentDb, Queryable, TransactionalContentDb } from "../../src/content/db.js";

const TRACKS_DDL = `CREATE TABLE tracks (
  track_id text PRIMARY KEY,
  title text NOT NULL,
  artist text NOT NULL,
  album text,
  duration_ms integer NOT NULL,
  cover_url text,
  audio_object_key text NOT NULL,
  format text NOT NULL,
  bitrate integer NOT NULL,
  isrc text UNIQUE,
  license text NOT NULL,
  region_policy text,
  published_at timestamp NOT NULL DEFAULT now()
)`;

const LYRICS_DDL = `CREATE TABLE lyrics (
  track_id text NOT NULL,
  line_index integer NOT NULL,
  timestamp_ms integer NOT NULL,
  text text NOT NULL,
  lyrics_license text NOT NULL,
  UNIQUE (track_id, line_index)
)`;

// content_policy：ops-platform 下发策略表（M2b 消费侧），与 schema.ts 同结构
export const CONTENT_POLICY_DDL = `CREATE TABLE IF NOT EXISTS content_policy (
  id text PRIMARY KEY,
  rule_id text NOT NULL,
  action text NOT NULL,
  target_scope text NOT NULL,
  version integer NOT NULL,
  envelope text NOT NULL,
  caller_identity text NOT NULL,
  command_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  superseded_by integer
);
CREATE UNIQUE INDEX IF NOT EXISTS content_policy_cmd_uk ON content_policy(command_id);
CREATE UNIQUE INDEX IF NOT EXISTS content_policy_rule_ver_uk ON content_policy(rule_id, version);`;

// ingest/review：审核状态机依赖表（T7 admin UI e2e test fixture，②类必要支撑，
// 与 test/unit/review-state.test.ts DDL 同结构）。
export const INGEST_DDL = `CREATE TABLE IF NOT EXISTS ingest (
  id text PRIMARY KEY,
  track_id text NOT NULL,
  source text NOT NULL,
  raw_metadata text NOT NULL,
  audio_object_key text,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamp NOT NULL DEFAULT now()
)`;

export const REVIEW_DDL = `CREATE TABLE IF NOT EXISTS review (
  id text PRIMARY KEY,
  ingest_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  reason text,
  at timestamp NOT NULL DEFAULT now()
)`;

export interface SeedTrack {
  track_id: string;
  title: string;
  artist: string;
  album?: string;
  duration_ms: number;
  cover_url?: string;
  audio_object_key: string;
  format: string;
  bitrate: number;
  isrc?: string;
  license: string;
}

export function createTestDb(opts: { withLyrics?: boolean; withIngest?: boolean } = {}): TransactionalContentDb {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  const db: TransactionalContentDb = {
    async query(text: string, params?: unknown[]) {
      return pool.query(text, params as any[]);
    },
    // pg-mem 3.0.14 无事务语义（spec §8 spike 实证：ROLLBACK 不撤销、事务内写立即可见）——
    // 直通实现仅满足 SQL 序列测试；回滚语义由 Layer 1 fake pool 契约 + Layer 3 真 pg 担当。
    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn({
        query: (text: string, params?: unknown[]) => pool.query(text, params as any[]),
      });
    },
  };
  // 同步建表（pool.query 在 pg-mem 同步执行）
  pool.query(TRACKS_DDL);
  if (opts.withLyrics) pool.query(LYRICS_DDL);
  pool.query(CONTENT_POLICY_DDL);
  // T7 admin UI e2e 需 ingest/review 表（默认建，review-state 单测各自建不影响）
  if (opts.withIngest !== false) {
    pool.query(INGEST_DDL);
    pool.query(REVIEW_DDL);
  }
  return db;
}

export async function seedTrack(db: ContentDb, t: SeedTrack): Promise<void> {
  await db.query(
    `INSERT INTO tracks (track_id, title, artist, album, duration_ms, cover_url, audio_object_key, format, bitrate, isrc, license) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      t.track_id,
      t.title,
      t.artist,
      t.album ?? null,
      t.duration_ms,
      t.cover_url ?? null,
      t.audio_object_key,
      t.format,
      t.bitrate,
      t.isrc ?? null,
      t.license,
    ],
  );
}

export async function seedLyrics(
  db: ContentDb,
  trackId: string,
  lines: { line_index: number; timestamp_ms: number; text: string; lyrics_license: string }[],
): Promise<void> {
  for (const l of lines) {
    await db.query(
      `INSERT INTO lyrics (track_id, line_index, timestamp_ms, text, lyrics_license) VALUES ($1,$2,$3,$4,$5)`,
      [trackId, l.line_index, l.timestamp_ms, l.text, l.lyrics_license],
    );
  }
}
