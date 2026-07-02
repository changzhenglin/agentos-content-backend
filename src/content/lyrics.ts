// lyrics.ts — getLyrics 业务函数（独立版权校验，解 plan-eng I5）。
//
// spec §5.3：lyrics 独立版权校验——lyrics 表 lyrics_license 字段，
// "restricted" → outcome=blocked（COPYRIGHT_RESTRICTED）。
// 非 restricted → outcome=ok + lines。
// 无歌词行 → outcome=no_result（NO_RESULT）。
//
// 注意：tracks.license 与 lyrics.lyrics_license 是两个独立版权维度，
// tracks 层 license 通过不代表 lyrics 可发；lyrics 必须独立校验（解 I5）。
// 版权校验先于 availability（brief T4 concerns）——本函数只处理 self_hosted
// lyrics，third_party lyrics 路径由 selectPath 在路由层 BLOCKED（M2d 前不落地）。

import type { ContentDb } from "./db.js";

export interface LyricLine {
  timestamp_ms: number;
  text: string;
}

export interface LyricsOk {
  outcome: "ok";
  business: { track_id: string; lines: LyricLine[] };
}
export interface LyricsNoResult {
  outcome: "no_result";
  business: Record<string, never>;
}
export interface LyricsBlocked {
  outcome: "blocked";
  business: Record<string, never>;
}
export type LyricsOutcome = LyricsOk | LyricsNoResult | LyricsBlocked;

interface LyricsRow {
  track_id: string;
  line_index: number;
  timestamp_ms: number;
  text: string;
  lyrics_license: string;
}

/**
 * getLyrics：独立版权校验后返回歌词行。
 * restricted license → blocked；无行 → no_result；否则 ok + lines。
 */
export async function getLyrics(
  db: ContentDb,
  trackId: string,
): Promise<LyricsOutcome> {
  const { rows } = await db.query(
    "SELECT track_id, line_index, timestamp_ms, text, lyrics_license FROM lyrics WHERE track_id = $1 ORDER BY line_index ASC",
    [trackId],
  );
  if (!rows.length) {
    return { outcome: "no_result", business: {} };
  }
  const typed = rows as unknown as LyricsRow[];
  // 独立版权校验：任一行 restricted 即整轨 blocked（同轨 license 应一致，
  // 取首行；若不一致取最严——restricted 优先）
  const hasRestricted = typed.some((r) => r.lyrics_license === "restricted");
  if (hasRestricted) {
    return { outcome: "blocked", business: {} };
  }
  return {
    outcome: "ok",
    business: {
      track_id: trackId,
      lines: typed.map((r) => ({
        timestamp_ms: r.timestamp_ms,
        text: r.text,
      })),
    },
  };
}
