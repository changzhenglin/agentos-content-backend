// AUTO-GENERATED from schemas/content-contract.schema.json — do not edit. Run `pnpm gen` to regenerate.
export type AgentOSContentContract = {
  [k: string]: unknown;
} & {
  kind: "content_query" | "content_match" | "content_stream" | "content_lyrics" | "content_metadata";
  version: number;
  backend_type: "platform_backend" | "third_party_api" | "self_hosted";
  capability_mode: "real" | "mock" | "unavailable" | "degraded";
  completion_state: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
  error_code?: "NO_RESULT" | "AUTH_FAILED" | "REGION_RESTRICTED" | "COPYRIGHT_RESTRICTED" | "BACKEND_UNAVAILABLE";
  query?: Query;
  candidates?: Candidate[];
  match?: Match;
  track?: AgentOSMusicTrack;
  stream_id?: number;
  track_id?: string;
  url?: string;
  auth?: Auth;
  format?: "mp3" | "aac" | "flac";
  bitrate?: number;
  expires_at?: string;
  lines?: LyricLine[];
  title?: string;
  artist?: string;
  album?: string;
  duration_ms?: number;
  cover_url?: string;
  runtime_mode?: AgentOSRuntimeMode;
};
/**
 * Single source of truth for runtime_mode enum (Theme B, codex P2#7). Referenced by content-contract.schema.json + scenario-trace.schema.json via $ref; C header include/agentos/protocols/runtime_mode.h mirrors these string values (drift test enforces).
 */
export type AgentOSRuntimeMode = "local-runtime" | "remote-service";

export interface Query {
  intent?: string;
  keywords: string[];
  fuzzy?: boolean;
}
export interface Candidate {
  track_id: string;
  title: string;
  artist: string;
  album?: string;
  confidence?: number;
}
export interface Match {
  track_id?: string;
  title: string;
  artist: string;
  album?: string;
  isrc?: string;
}
/**
 * Music track shape (title/artist/album/duration_ms). 当前为音乐内容特化（Theme G B-3）。content 通用化（支持 video 等）时此 shape 须重审/迁移回 music 层，见 Theme G spec §7 架构债披露。
 */
export interface AgentOSMusicTrack {
  title: string;
  artist: string;
  album?: string;
  duration_ms: number;
}
export interface Auth {
  token: string;
  token_type: "bearer" | "query_param";
  expires_at: string;
}
export interface LyricLine {
  timestamp_ms: number;
  text: string;
}
