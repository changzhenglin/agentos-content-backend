// review-tx-affinity.test.ts — Layer 2 通道亲和断言（spec §8 Layer 2）。
// 断言 ingestTransitionAndAudit 的全部语句经 tx 句柄、零 pool 旁路。
// pg-mem 3.0.14 无事务语义（spec §8 spike 实证），本层只测序列通道，回滚语义不归本层。
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import type { TransactionalContentDb } from "../../src/content/db.js";
import type { AuditSink } from "../../src/audit/audit-sink.js";
import { ingestTransitionAndAudit } from "../../src/admin/ingest.js";

// DDL 与 test/unit/review-state.test.ts 同源
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
  reason text,
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

const META = JSON.stringify({
  title: "A",
  artist: "B",
  durationMs: 1000,
  format: "mp3",
  bitrate: 128000,
  license: "CC",
});

function makeRecordingDb(): {
  db: TransactionalContentDb;
  rec: { txQueries: string[]; bypassDuringTx: string[] };
} {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  pool.query(INGEST_DDL);
  pool.query(REVIEW_DDL);
  pool.query(TRACKS_DDL);
  const rec = { txQueries: [] as string[], bypassDuringTx: [] as string[] };
  let inTx = false;
  const db: TransactionalContentDb = {
    query(text, params) {
      if (inTx) rec.bypassDuringTx.push(text);
      return pool.query(text, params as any[]);
    },
    // pg-mem 无事务语义：直通 + 句柄分离（记录需要）
    async withTransaction(fn) {
      inTx = true;
      try {
        return await fn({
          query: (text, params) => {
            rec.txQueries.push(text);
            return pool.query(text, params as any[]);
          },
        });
      } finally {
        inTx = false;
      }
    },
  };
  return { db, rec };
}

function makeCommitRecordingDb(options: { rejectCommit?: boolean } = {}): {
  db: TransactionalContentDb;
  events: string[];
} {
  const { db: inner } = makeRecordingDb();
  const events: string[] = [];
  const db: TransactionalContentDb = {
    query: (text, params) => inner.query(text, params),
    async withTransaction(fn) {
      const result = await inner.withTransaction(async (tx) => {
        const value = await fn(tx);
        events.push("callback");
        return value;
      });
      if (options.rejectCommit) throw new Error("commit-rejected");
      events.push("COMMIT");
      return result;
    },
  };
  return { db, events };
}

function makeRecordingAuditSink(events: string[]): AuditSink {
  return {
    async emit() {
      events.push("emit");
    },
  };
}

describe("事务通道亲和（Layer 2）", () => {
  it("approve：全部语句经 tx 句柄，零 pool 旁路", async () => {
    const { db, rec } = makeRecordingDb();
    await db.query(
      "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'pending')",
      ["i1", "self:t1", "admin-ui", META, "obj/k"],
    );
    rec.txQueries.length = 0; // 种子不计入
    await ingestTransitionAndAudit(db, undefined, "i1", "approve", "user:admin");
    // trackId SELECT + transition 内 fetchIngest SELECT + CAS UPDATE + review INSERT + tracks INSERT = 5 句
    //（fold Eng review C：transition() 内部自带一句 fetchIngest SELECT——spec §4.3 SQL 零改动，不得砍）
    expect(rec.txQueries.length).toBe(5);
    expect(rec.txQueries.some((q) => q.startsWith("UPDATE ingest"))).toBe(true);
    expect(rec.bypassDuringTx.length).toBe(0);
    const { rows } = await db.query("SELECT count(*)::int AS c FROM tracks");
    expect(Number(rows[0].c)).toBe(1);
  });

  it("approve：事务 callback→COMMIT 后才 emit audit", async () => {
    const { db, events } = makeCommitRecordingDb();
    await db.query(
      "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'pending')",
      ["i1", "self:t1", "admin-ui", META, "obj/k"],
    );

    await ingestTransitionAndAudit(
      db,
      makeRecordingAuditSink(events),
      "i1",
      "approve",
      "user:admin",
    );

    expect(events).toEqual(["callback", "COMMIT", "emit"]);
  });

  it("approve：COMMIT reject 时函数 reject 且零 emit", async () => {
    const { db, events } = makeCommitRecordingDb({ rejectCommit: true });
    await db.query(
      "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'pending')",
      ["i1", "self:t1", "admin-ui", META, "obj/k"],
    );

    await expect(
      ingestTransitionAndAudit(
        db,
        makeRecordingAuditSink(events),
        "i1",
        "approve",
        "user:admin",
      ),
    ).rejects.toThrow("commit-rejected");
    expect(events).toEqual(["callback"]);
  });

  it("revoke：全部语句经 tx 句柄（含 tracks DELETE）", async () => {
    const { db, rec } = makeRecordingDb();
    await db.query(
      "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'approved')",
      ["i1", "self:t1", "admin-ui", META, "obj/k"],
    );
    await db.query(
      "INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      ["self:t1", "A", "B", 1000, "obj/k", "mp3", 128000, "CC"],
    );
    rec.txQueries.length = 0;
    await ingestTransitionAndAudit(db, undefined, "i1", "revoke", "user:admin");
    expect(rec.txQueries.some((q) => q.startsWith("DELETE FROM tracks"))).toBe(true);
    expect(rec.bypassDuringTx.length).toBe(0);
    const { rows } = await db.query("SELECT count(*)::int AS c FROM tracks");
    expect(Number(rows[0].c)).toBe(0);
  });
});
