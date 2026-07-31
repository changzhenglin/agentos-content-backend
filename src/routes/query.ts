// query.ts — query kind 业务 handler。
// 调 queryTracks，返回 {outcome, backendType, capabilityMode, business}（路由层 wrap envelope）。
// spec §5.1：candidates 非空 → ok；空 → no_result。
// business 回显 query（schema content_query allOf 要求 envelope 含 query 字段）。
// self_hosted only（third_party query 未授权走 selectPath fallback degraded，
// 但 degraded 仍走 self_hosted 业务函数——M2d 前所有 query 均 self_hosted；
// capabilityMode 由路由层 selectPath 决定，handler 对 self_hosted 路径固定 real）。

import type { ContentDb } from "../content/db.js";
import type { CapabilityMode, ErrorCode } from "../envelope.js";
import type { DrmCtx } from "../policy/drm-ctx.js";
import { emitToolCall } from "../audit/audit-events.js";
import { queryTracks } from "../content/self-hosted.js";

/** query 请求形状（schema $defs/query：keywords 必需，intent/fuzzy 可选）。 */
export interface QueryRequest {
  keywords: string[];
  intent?: string;
  fuzzy?: boolean;
}

export async function queryBusiness(
  db: ContentDb,
  query: QueryRequest,
  ctx?: DrmCtx,
) {
  const result = await queryTracks(db, query.keywords, query.intent);
  const outcome = result.candidates.length ? ("ok" as const) : ("no_result" as const);
  // business 回显 query（content-contract schema content_query 要求 envelope 含 query）
  // ok 路径 emit tool_call audit（fold codex P2：drm 由 index.ts handle() 中央 guard）
  if (ctx?.auditSink && outcome === "ok") {
    await emitToolCall(ctx.auditSink, {
      kind: "content_query",
      target: query.keywords.join(" "),
      actor: ctx.actor,
      traceId: ctx.traceId,
    });
  }
  return {
    outcome,
    backendType: "self_hosted" as const,
    capabilityMode: "real" as CapabilityMode,
    errorCode: undefined as ErrorCode | undefined,
    business: { query, candidates: result.candidates },
  };
}
