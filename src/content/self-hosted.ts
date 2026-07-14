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
  // match: schema $defs/match（track_id/title/artist/album/isrc，isrc 省略当 null）
  match: { track_id: string; title: string; artist: string; isrc?: string };
  // track: schema track.schema（title/artist/album/duration_ms，additionalProperties false）
  track: {
    title: string;
    artist: string;
    duration_ms: number;
    album?: string | null;
  };
}

export interface MetadataResult {
  track_id: string;
  title: string;
  artist: string;
  duration_ms: number;
  // album/cover_url 省略当 null（schema 这些字段 type string，null 不符）
  album?: string;
  cover_url?: string;
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
 * escape ILIKE 通配符（\ % _）→ 字面量，配合 Postgres ILIKE default escape（\，codex/opus Minor fold）。
 * 防 keywords 含 %/_ 被当通配符扩大匹配范围（非 SQL 注入，已参数化 $1）。
 * 用 default escape（\）而非显式 ESCAPE 子句：pg-mem 不支持 ESCAPE 语法，但 default \ escape
 * pg-mem + 生产 Postgres 都支持（Postgres ILIKE default ESCAPE '\'）。
 * 顺序：先 \ （→\\）再 %/ _，防 \ 被二次 escape。
 */
function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * queryTracks：Postgres ILIKE 全文（简化：仅 keywords[0]，title OR artist）。
 * intent=lyric → lyrics.text ILIKE join tracks（D10' 歌词搜，不改 contract）。
 * 无 intent/其他 intent → title OR artist ILIKE（既有，向后兼容）。
 * spec §5.1 query → {candidates:[]}
 */
export async function queryTracks(
  db: ContentDb,
  keywords: string[],
  intent?: string,
): Promise<{ candidates: QueryCandidate[] }> {
  if (!keywords.length) {
    const { rows } = await db.query(
      "SELECT track_id, title, artist, album FROM tracks ORDER BY published_at DESC LIMIT 50",
    );
    return { candidates: rows as unknown as QueryCandidate[] };
  }
  const pat = `%${escapeLikePattern(keywords[0])}%`;
  // D10' lyrics ILIKE 扩：intent=lyric → lyrics.text ILIKE 找 track_id
  // codex P1 fold: DISTINCT ON (t.track_id) 去重 lyrics 多行 join 致重复；
  // ORDER BY 必含 DISTINCT ON 列（Postgres 要求）。
  // codex/opus Minor fold: escapeLikePattern escape 通配符（\ % _）+ Postgres ILIKE default escape（\），
  // 防 keywords 含 %/_ 扩大匹配；pg-mem 不支持 ESCAPE 子句，用 default \ escape（生产 Postgres 同）
  if (intent === "lyric") {
    const { rows } = await db.query(
      "SELECT DISTINCT ON (t.track_id) t.track_id, t.title, t.artist, t.album FROM tracks t JOIN lyrics l ON l.track_id = t.track_id WHERE l.text ILIKE $1 ORDER BY t.track_id, t.published_at DESC LIMIT 50",
      [pat],
    );
    return { candidates: rows as unknown as QueryCandidate[] };
  }
  // 既有：title/artist ILIKE
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
  // matchPart: track_id + title + artist + isrc（省略 null，schema isrc type string）
  const matchPart: MatchResult["match"] = {
    track_id: t.track_id,
    title: t.title,
    artist: t.artist,
  };
  if (t.isrc != null) matchPart.isrc = t.isrc;
  // trackPart: 只 schema track.schema 允许字段（title/artist/album/duration_ms）
  const trackPart: MatchResult["track"] = {
    title: t.title,
    artist: t.artist,
    duration_ms: t.duration_ms,
  };
  if (t.album != null) trackPart.album = t.album;
  return { match: matchPart, track: trackPart };
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
  const result: MetadataResult = {
    track_id: String(row.track_id),
    title: String(row.title),
    artist: String(row.artist),
    duration_ms: Number(row.duration_ms),
  };
  // album/cover_url 省略当 null（schema 这些字段 type string）
  if (row.album != null) result.album = String(row.album);
  if (row.cover_url != null) result.cover_url = String(row.cover_url);
  return result;
}
