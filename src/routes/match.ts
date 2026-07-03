// match.ts — match kind 业务 handler。
// 调 matchTrack，null → no_result；否则 ok。
// spec §5.2：isrc/title 精确匹配。

import type { ContentDb } from "../content/db.js";
import type { CapabilityMode, ErrorCode } from "../envelope.js";
import type { DrmCtx } from "../policy/drm-ctx.js";
import { emitToolCall } from "../audit/audit-events.js";
import { matchTrack } from "../content/self-hosted.js";

export async function matchBusiness(
  db: ContentDb,
  match: { title: string; artist: string; isrc?: string },
  ctx?: DrmCtx,
) {
  const business = await matchTrack(db, match);
  if (!business) {
    return {
      outcome: "no_result" as const,
      backendType: "self_hosted" as const,
      capabilityMode: "real" as CapabilityMode,
      errorCode: undefined as ErrorCode | undefined,
      business: {},
    };
  }
  // ok 路径 emit tool_call audit（fold codex P2：drm 由 index.ts handle() 中央 guard）
  if (ctx?.auditSink) {
    await emitToolCall(ctx.auditSink, {
      kind: "content_match",
      target: `${match.title}|${match.artist}`,
      actor: ctx.actor,
    });
  }
  return {
    outcome: "ok" as const,
    backendType: "self_hosted" as const,
    capabilityMode: "real" as CapabilityMode,
    errorCode: undefined as ErrorCode | undefined,
    business,
  };
}
