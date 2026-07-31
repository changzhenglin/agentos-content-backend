// lyrics.ts — lyrics kind 业务 handler。
// 调 getLyrics（含独立版权校验），透传 outcome。
// backendType=self_hosted（third_party lyrics 未授权由 selectPath BLOCKED，
//   路由层不调本 handler；M2d 前 lyrics 均 self_hosted）。
// spec §5.3 + I5：lyrics 独立版权校验。blocked 时 errorCode=COPYRIGHT_RESTRICTED。

import type { ContentDb } from "../content/db.js";
import type { CapabilityMode, ErrorCode } from "../envelope.js";
import type { DrmCtx } from "../policy/drm-ctx.js";
import { emitToolCall } from "../audit/audit-events.js";
import { getLyrics } from "../content/lyrics.js";

export async function lyricsBusiness(
  db: ContentDb,
  trackId: string,
  ctx?: DrmCtx,
) {
  const r = await getLyrics(db, trackId);
  // ok 路径 emit tool_call audit（fold codex P2：drm 由 index.ts handle() 中央 guard，
  // business 不内联 drm 块；lyrics 独立版权 blocked 不在此 emit——由 selectPath/getLyrics 决定）
  if (ctx?.auditSink && r.outcome === "ok") {
    await emitToolCall(ctx.auditSink, {
      kind: "content_lyrics",
      target: trackId,
      actor: ctx.actor,
      traceId: ctx.traceId,
    });
  }
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
