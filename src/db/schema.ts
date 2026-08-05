import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// ingest：source-of-truth 全状态历史（pending/approved/rejected/revoked）
export const ingest = pgTable("ingest", {
  id: text("id").primaryKey(),
  trackId: text("track_id").notNull(),
  source: text("source").notNull(),
  rawMetadata: text("raw_metadata").notNull(),
  audioObjectKey: text("audio_object_key"),
  state: text("state", {
    enum: ["pending", "approved", "rejected", "revoked"],
  })
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// review：审批动作历史（approve/reject/revoke/resubmit）
export const review = pgTable("review", {
  id: text("id").primaryKey(),
  ingestId: text("ingest_id").notNull(),
  actor: text("actor").notNull(),
  action: text("action", {
    enum: ["approve", "reject", "revoke", "resubmit"],
  }).notNull(),
  reason: text("reason"),
  at: timestamp("at").defaultNow().notNull(),
});

// tracks：published projection（仅 approved 的已发布轨道）
export const tracks = pgTable(
  "tracks",
  {
    trackId: text("track_id").primaryKey(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    durationMs: integer("duration_ms").notNull(),
    coverUrl: text("cover_url"),
    audioObjectKey: text("audio_object_key").notNull(),
    format: text("format", { enum: ["mp3", "aac", "flac"] }).notNull(),
    bitrate: integer("bitrate").notNull(),
    isrc: text("isrc"),
    license: text("license").notNull(),
    regionPolicy: text("region_policy"),
    publishedAt: timestamp("published_at").defaultNow().notNull(),
  },
  (t) => ({
    isrcUk: uniqueIndex("tracks_isrc_uk").on(t.isrc),
  }),
);

// lyrics：轨道歌词行，uniqueIndex(trackId, lineIndex)
export const lyrics = pgTable(
  "lyrics",
  {
    trackId: text("track_id").references(() => tracks.trackId),
    lineIndex: integer("line_index").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    text: text("text").notNull(),
    lyricsLicense: text("lyrics_license").notNull(),
  },
  (t) => ({
    pk: uniqueIndex("lyrics_pk").on(t.trackId, t.lineIndex),
  }),
);

// content_policy：ops-platform 下发的策略（sim 闭环，M2b 消费侧）
// unique index：command_id 幂等防重 + (rule_id, version) 防并发同 version（fold codex P1#3 竞态）
export const contentPolicy = pgTable(
  "content_policy",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id").notNull(),
    action: text("action", { enum: ["allow", "block", "region_restrict"] }).notNull(),
    targetScope: text("target_scope").notNull(),
    version: integer("version").notNull(),
    envelope: text("envelope").notNull(), // JSONB，存 PolicyEnvelope JSON
    callerIdentity: text("caller_identity").notNull(),
    commandId: text("command_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    supersededBy: integer("superseded_by"),
  },
  (t) => ({
    cmdUk: uniqueIndex("content_policy_cmd_uk").on(t.commandId),
    ruleVerUk: uniqueIndex("content_policy_rule_ver_uk").on(t.ruleId, t.version),
  }),
);

export const schema = { ingest, review, tracks, lyrics, contentPolicy };
