// self-hosted.ts — self_hosted backend 业务函数（query/match/metadata）。
//
// 注意：brief 用 drizzle query builder（db.query.tracks.findMany/findFirst），
// 但 pg-mem + drizzle-orm@0.36 query builder 不可用（见 ./db.ts 注释），
// 故改用 ContentDb.query 参数化 SQL——生产真实 Postgres 同路径，安全且可测。
// 返回 snake_case 业务字段（与 content-contract envelope 形状一致，路由层直接 wrap）。

import type { ContentDb } from "./db.js";

export interface QueryCandidate {
  track_id: string;
  title: string;
  artist: string;
  album: string | null;
}

export interface MatchResult {
  match: { title: string; artist: string; isrc: string | null };
  track: {
    track_id: string;
    title: string;
    artist: string;
    album: string | null;
    duration_ms: number;
    cover_url: string | null;
    format: string;
    bitrate: number;
  };
}

export interface MetadataResult {
  track_id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number;
  cover_url: string | null;
}

interface TrackRow {
  track_id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number;
  cover_url: string | null;
  audio_object_key: string;
  format: string;
  bitrate: number;
  isrc: string | null;
}

function toTrack(r: Record<string, unknown>): TrackRow {
  return {
    track_id: String(r.track_id),
    title: String(r.title),
    artist: String(r.artist),
    album: r.album == null ? null : String(r.album),
    duration_ms: Number(r.duration_ms),
    cover_url: r.cover_url == null ? null : String(r.cover_url),
    audio_object_key: String(r.audio_object_key),
    format: String(r.format),
    bitrate: Number(r.bitrate),
    isrc: r.isrc == null ? null : String(r.isrc),
  };
}

/**
 * queryTracks：Postgres ILIKE 全文（简化：仅 keywords[0]，title OR artist）。
 * spec §5.1 query → {candidates:[]}
 */
export async function queryTracks(
  db: ContentDb,
  keywords: string[],
): Promise<{ candidates: QueryCandidate[] }> {
  if (!keywords.length) {
    const { rows } = await db.query(
      "SELECT track_id, title, artist, album FROM tracks ORDER BY published_at DESC LIMIT 50",
    );
    return { candidates: rows as unknown as QueryCandidate[] };
  }
  const pat = `%${keywords[0]}%`;
  const { rows } = await db.query(
    "SELECT track_id, title, artist, album FROM tracks WHERE title ILIKE $1 OR artist ILIKE $1 ORDER BY published_at DESC LIMIT 50",
    [pat],
  );
  return { candidates: rows as unknown as QueryCandidate[] };
}

/**
 * matchTrack：isrc 精确（优先）或 title 精确。
 * spec §5.2 match → {match, track} 或 null。
 * isrc 唯一索引（schema tracks_isrc_uk）保证 isrc 命中唯一。
 */
export async function matchTrack(
  db: ContentDb,
  match: { title: string; artist: string; isrc?: string },
): Promise<MatchResult | null> {
  let row: Record<string, unknown> | undefined;
  if (match.isrc) {
    const { rows } = await db.query("SELECT * FROM tracks WHERE isrc = $1 LIMIT 1", [
      match.isrc,
    ]);
    row = rows[0];
  } else {
    const { rows } = await db.query(
      "SELECT * FROM tracks WHERE title = $1 LIMIT 1",
      [match.title],
    );
    row = rows[0];
  }
  if (!row) return null;
  const t = toTrack(row);
  return {
    match: { title: t.title, artist: t.artist, isrc: t.isrc },
    track: {
      track_id: t.track_id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration_ms: t.duration_ms,
      cover_url: t.cover_url,
      format: t.format,
      bitrate: t.bitrate,
    },
  };
}

/**
 * getMetadata：Postgres 查询单轨元数据。
 * spec §5.5 metadata → {track_id, title, artist, album, duration_ms, cover_url} 或 null。
 */
export async function getMetadata(
  db: ContentDb,
  trackId: string,
): Promise<MetadataResult | null> {
  const { rows } = await db.query(
    "SELECT track_id, title, artist, album, duration_ms, cover_url FROM tracks WHERE track_id = $1 LIMIT 1",
    [trackId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    track_id: String(row.track_id),
    title: String(row.title),
    artist: String(row.artist),
    album: row.album == null ? null : String(row.album),
    duration_ms: Number(row.duration_ms),
    cover_url: row.cover_url == null ? null : String(row.cover_url),
  };
}
