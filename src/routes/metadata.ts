// metadata.ts — metadata kind 业务 handler。
// 调 getMetadata，null → no_result；否则 ok。
// spec §5.5：单轨元数据。

import type { ContentDb } from "../content/db.js";
import type { CapabilityMode, ErrorCode } from "../envelope.js";
import type { DrmCtx } from "../policy/drm-ctx.js";
import { emitToolCall } from "../audit/audit-events.js";
import { getMetadata } from "../content/self-hosted.js";

export async function metadataBusiness(
  db: ContentDb,
  trackId: string,
  ctx?: DrmCtx,
) {
  const business = await getMetadata(db, trackId);
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
      kind: "content_metadata",
      target: trackId,
      actor: ctx.actor,
      traceId: ctx.traceId,
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
