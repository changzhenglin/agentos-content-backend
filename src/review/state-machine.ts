// state-machine.ts — 审核状态机（pending/approved/rejected/revoked）。
//
// transition(ingestId, action, actor)：
//   - SELECT ingest → 不存在抛 NOT_FOUND
//   - UPDATE ingest.state = next（approve→approved / reject→rejected / revoke→revoked / resubmit→pending）
//   - INSERT review 记录（actor + action）
//   - approve → INSERT tracks（published projection，从 ingest.raw_metadata 解析）
//   - revoke  → DELETE tracks where track_id（takedown）
//
// 适配性偏离（②类必要支撑）：brief 入参 NodePostgresDatabase + drizzle query builder
// （db.query.ingest.findFirst / db.update / db.insert / db.delete），但 pg-mem +
// drizzle-orm@0.36 query builder 不可用（见 src/content/db.ts 注释 + schema.test.ts
// 记录）。按 brief 指示对齐 T5 ContentDb port（{query(text, params)}），生产由 T7
// 注入 pg Pool，测试由 pg-mem 注入。参数化 SQL 在 pg-mem 与真实 Postgres 同路径，
// 安全且可测。语义与 brief 完全一致。
// 2026-08-06 事务化：入参放宽 Queryable，由 withTransaction 包裹调用（spec §4.3）；SQL 与语义零改动。

import { randomUUID } from "node:crypto";
import type { Queryable } from "../content/db.js";

export type ReviewAction = "approve" | "reject" | "revoke" | "resubmit";

const NEXT_STATE: Record<ReviewAction, string> = {
  approve: "approved",
  reject: "rejected",
  revoke: "revoked",
  resubmit: "pending",
};

// 合法转换矩阵（spec §3.5 防御层；UI 按钮显隐是第一层）
const ALLOWED: Record<string, ReviewAction[]> = {
  pending: ["approve", "reject"],
  approved: ["revoke"],
  rejected: ["resubmit"],
  revoked: ["resubmit"],
};

interface IngestRow {
  id: string;
  track_id: string;
  raw_metadata: string;
  audio_object_key: string | null;
  state: string;
}

async function fetchIngest(
  db: Queryable,
  ingestId: string,
): Promise<IngestRow | null> {
  const { rows } = await db.query(
    "SELECT id, track_id, raw_metadata, audio_object_key, state FROM ingest WHERE id = $1 LIMIT 1",
    [ingestId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    track_id: String(r.track_id),
    raw_metadata: String(r.raw_metadata),
    audio_object_key: r.audio_object_key == null ? null : String(r.audio_object_key),
    state: String(r.state),
  };
}

export async function transition(
  db: Queryable,
  ingestId: string,
  action: ReviewAction,
  actor: string,
  reason?: string,
): Promise<void> {
  const i = await fetchIngest(db, ingestId);
  if (!i) throw new Error("NOT_FOUND");

  if (!ALLOWED[i.state]?.includes(action)) {
    throw new Error("INVALID_TRANSITION");
  }

  const next = NEXT_STATE[action];

  // CAS：带旧状态条件，并发 approve/reject 只有一个成功（UPDATE 行锁串行化）。
  // RETURNING 证明 UPDATE 所有权：命中方得 rows，miss 方得空数组——
  // 同动作并发下 miss 方重读会看到赢家写入的状态（伪命中），故不可用重读比对。
  // pg-mem 已实证支持 UPDATE...RETURNING（命中 rows=[...]，miss rows=[]）。
  const cas = await db.query(
    "UPDATE ingest SET state = $1 WHERE id = $2 AND state = $3 RETURNING id",
    [next, ingestId, i.state],
  );
  if (cas.rows.length === 0) throw new Error("INVALID_TRANSITION");

  const reviewId = randomUUID();
  await db.query(
    "INSERT INTO review (id, ingest_id, actor, action, reason) VALUES ($1,$2,$3,$4,$5)",
    [reviewId, ingestId, actor, action, reason ?? null],
  );

  if (action === "approve") {
    const meta = JSON.parse(i.raw_metadata) as {
      title?: string;
      artist?: string;
      album?: string;
      durationMs?: number;
      coverUrl?: string;
      format?: string;
      bitrate?: number;
      isrc?: string;
      license?: string;
      regionPolicy?: string;
    };
    await db.query(
      `INSERT INTO tracks (track_id, title, artist, album, duration_ms, cover_url, audio_object_key, format, bitrate, isrc, license, region_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        i.track_id,
        meta.title ?? "",
        meta.artist ?? "",
        meta.album ?? null,
        meta.durationMs ?? 0,
        meta.coverUrl ?? null,
        i.audio_object_key ?? "",
        meta.format ?? "mp3",
        meta.bitrate ?? 0,
        meta.isrc ?? null,
        meta.license ?? "",
        meta.regionPolicy ?? null,
      ],
    );
  }

  if (action === "revoke") {
    await db.query("DELETE FROM tracks WHERE track_id = $1", [i.track_id]);
  }
}
