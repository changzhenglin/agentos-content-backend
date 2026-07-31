// drm-guard.ts — 中央 drm check + audit（fold codex P2，业务函数不重复 drm 块）。
// copyright 优先于 availability（spec §5.2）；fail-closed（policy store 故障→BLOCKED）；空集 allow。
// 纯函数 + DrmCtx 注入，不绑 fastify。handle() 在调 business fn 前调；
// 返回 blocked→handle 直接返 BLOCKED envelope 不调 business fn。
import type { DrmCtx } from "./drm-ctx.js";
import { checkDrm, type DrmDecision } from "./drm-rule-engine.js";
import { getRegion } from "./region-config.js";
import { emitToolCall } from "../audit/audit-events.js";
import type { ErrorCode, Kind } from "../envelope.js";

export interface DrmBlocked {
  blocked: true;
  errorCode: ErrorCode;
}
export interface DrmAllow {
  blocked: false;
}

/**
 * kind 调用前调；返回 blocked→handle 直接返 BLOCKED envelope 不调 business fn。
 * - block policy → COPYRIGHT_RESTRICTED（403）
 * - region_restrict 命中（requestRegion≠backendRegion）→ REGION_RESTRICTED（403）
 * - 空集 / allow → 放行
 * - policy store 故障 → fail-closed BACKEND_UNAVAILABLE（503）
 * blocked 也 emit tool_call audit（若 auditSink 存在）——drm 生效独立于 audit emit。
 *
 * audit emit 独立于 DRM 决策：try 只包 policyStore.latestPolicy + checkDrm
 * （DRM 决策判定）；emitToolCall 移出 try 单独 try/catch——audit IO 故障
 * （磁盘满等）不篡改已判定的 DRM 结果（blocked 仍返 403/region_restrict），
 * 仅 console.warn。否则 catch 会把 COPYRIGHT_RESTRICTED(403) 转成
 * BACKEND_UNAVAILABLE(503)，client 看 503 会重试（403 不会）→重试风暴+DRM 语义掩盖。
 */
export async function drmGuard(
  ctx: DrmCtx,
  kind: Kind,
  trackId: string,
  requestRegion: string,
): Promise<DrmBlocked | DrmAllow> {
  let dec: DrmDecision | null;
  try {
    const policies = await ctx.policyStore.latestPolicy();
    dec = checkDrm(
      policies,
      kind,
      trackId,
      requestRegion,
      getRegion(),
    );
  } catch {
    // fail-closed（policy store 故障）：drm 不放行。audit 不 emit（store 故障时决策未定）。
    return { blocked: true, errorCode: "BACKEND_UNAVAILABLE" };
  }
  if (dec) {
    const errorCode: ErrorCode =
      dec.action === "block" ? "COPYRIGHT_RESTRICTED" : "REGION_RESTRICTED";
    // audit emit 独立于 DRM 决策：失败不篡改已判定的 errorCode。
    if (ctx.auditSink) {
      try {
        await emitToolCall(ctx.auditSink, {
          kind,
          target: trackId,
          actor: ctx.actor,
          traceId: ctx.traceId,
        });
      } catch (e) {
        console.warn(
          `[drm-guard] audit emit fail (drm 决策保留 errorCode=${errorCode}): ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return { blocked: true, errorCode };
  }
  return { blocked: false };
}
