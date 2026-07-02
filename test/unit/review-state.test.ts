// review-state.test.ts — 审核状态机 3 转移单测（解 plan-eng I2：test body 全完整非空体）。
//
// pg-mem + drizzle-orm@0.36 query builder 不可用（见 src/content/db.ts 注释 +
// schema.test.ts 记录），故 brief 的 db.query/findMany/db.insert 路径在 pg-mem
// 无法执行。按 brief 指示对齐 T5 ContentDb port 模式（pg-mem adapters.createPg()
// .Pool.query 参数化 SQL），transition 入参为 ContentDb——生产由 T7 注入 pg Pool，
// 测试由 pg-mem 注入。语义与 brief 一致（3 转移 + tracks published projection）。

import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import type { ContentDb } from "../../src/content/db.js";
import { transition } from "../../src/review/state-machine.js";

const INGEST_DDL = `CREATE TABLE ingest (
  id text PRIMARY KEY,
  track_id text NOT NULL,
  source text NOT NULL,
  raw_metadata text NOT NULL,
  audio_object_key text,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamp NOT NULL DEFAULT now()
)`;

const REVIEW_DDL = `CREATE TABLE review (
  id text PRIMARY KEY,
  ingest_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  at timestamp NOT NULL DEFAULT now()
)`;

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

function setup(): ContentDb {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  const db: ContentDb = {
    async query(text: string, params?: unknown[]) {
      return pool.query(text, params as any[]);
    },
  };
  pool.query(INGEST_DDL);
  pool.query(REVIEW_DDL);
  pool.query(TRACKS_DDL);
  return db;
}

async function seedIngest(
  db: ContentDb,
  opts: {
    id: string;
    trackId: string;
    source: string;
    rawMetadata: string;
    audioObjectKey?: string | null;
    state: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      opts.id,
      opts.trackId,
      opts.source,
      opts.rawMetadata,
      opts.audioObjectKey ?? null,
      opts.state,
    ],
  );
}

async function seedTrack(
  db: ContentDb,
  opts: {
    trackId: string;
    title: string;
    artist: string;
    durationMs: number;
    audioObjectKey: string;
    format: string;
    bitrate: number;
    license: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      opts.trackId,
      opts.title,
      opts.artist,
      opts.durationMs,
      opts.audioObjectKey,
      opts.format,
      opts.bitrate,
      opts.license,
    ],
  );
}

async function tracksCount(db: ContentDb): Promise<number> {
  const { rows } = await db.query("SELECT count(*)::int AS c FROM tracks");
  return Number(rows[0].c);
}

async function ingestState(
  db: ContentDb,
  id: string,
): Promise<string | null> {
  const { rows } = await db.query("SELECT state FROM ingest WHERE id = $1", [
    id,
  ]);
  return rows[0] ? String(rows[0].state) : null;
}

const META = JSON.stringify({
  title: "A",
  artist: "B",
  durationMs: 1000,
  format: "mp3",
  bitrate: 128000,
  license: "CC",
});

describe("review state machine", () => {
  it("pending→approved inserts into tracks", async () => {
    const db = setup();
    await seedIngest(db, {
      id: "i1",
      trackId: "self:t1",
      source: "self_hosted",
      rawMetadata: META,
      audioObjectKey: "obj/key",
      state: "pending",
    });
    await transition(db, "i1", "approve", "user:admin");
    // approved → tracks published projection 插入一行
    expect(await tracksCount(db)).toBe(1);
    expect(await ingestState(db, "i1")).toBe("approved");
  });

  it("approved→revoked removes from tracks", async () => {
    const db = setup();
    await seedIngest(db, {
      id: "i1",
      trackId: "self:t1",
      source: "self_hosted",
      rawMetadata: META,
      audioObjectKey: "obj/key",
      state: "approved",
    });
    await seedTrack(db, {
      trackId: "self:t1",
      title: "A",
      artist: "B",
      durationMs: 1000,
      audioObjectKey: "obj/key",
      format: "mp3",
      bitrate: 128000,
      license: "CC",
    });
    expect(await tracksCount(db)).toBe(1);
    await transition(db, "i1", "revoke", "user:admin");
    // revoked → takedown，tracks 删除
    expect(await tracksCount(db)).toBe(0);
    expect(await ingestState(db, "i1")).toBe("revoked");
  });

  it("rejected→pending (resubmit)", async () => {
    const db = setup();
    await seedIngest(db, {
      id: "i1",
      trackId: "self:t1",
      source: "self_hosted",
      rawMetadata: "{}",
      state: "rejected",
    });
    await transition(db, "i1", "resubmit", "user:op");
    expect(await ingestState(db, "i1")).toBe("pending");
  });
});
