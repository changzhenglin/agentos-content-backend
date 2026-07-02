// lyrics.ts — lyrics kind 业务 handler。
// 调 getLyrics（含独立版权校验），透传 outcome。
// backendType=self_hosted（third_party lyrics 未授权由 selectPath BLOCKED，
//   路由层不调本 handler；M2d 前 lyrics 均 self_hosted）。
// spec §5.3 + I5：lyrics 独立版权校验。blocked 时 errorCode=COPYRIGHT_RESTRICTED。

import type { ContentDb } from "../content/db.js";
import type { CapabilityMode, ErrorCode } from "../envelope.js";
import { getLyrics } from "../content/lyrics.js";

export async function lyricsBusiness(db: ContentDb, trackId: string) {
  const r = await getLyrics(db, trackId);
  return {
    outcome: r.outcome,
    backendType: "self_hosted" as const,
    capabilityMode: "real" as CapabilityMode,
    errorCode:
      r.outcome === "blocked"
        ? ("COPYRIGHT_RESTRICTED" as ErrorCode)
        : (undefined as ErrorCode | undefined),
    business: r.business,
  };
}
