// secret-handle-hook.ts — X-Secret-Handle header audit hook（M2c，不解析 `^backend:`）。
// 读 per-call opaque handle → audit emit tool_call target=secret_handle。
// 实际 `^backend:` 解析 defer M2d third_party_api adapter（本 hook 只记录不解析）。
// fold codex P1: hook 不阻塞业务——audit emit 失败只 log，不 throw（content API 不受影响）。
// fold CEO I2/codex P2: backend hook 不校验来源域（只记录），来源域校验归 cloud-ext 单点（injectSecretHandleHeader 检查 ^cloud:）；
//   M2d 解析侧补 backend caller auth 校验。剩余风险显式记录：backend 单点不防御，安全靠 cloud-ext。
import type { AuditSink } from "../audit/audit-sink.js";

/**
 * 若 handle 非空，emit tool_call audit event（target=secret_handle:<handle>）。
 * handle 为空/undefined（self_hosted 路径）→ 不 emit。
 * actor=caller service identity（sim 用注入值，mTLS 绑定 defer M3-pre §4.5b）。
 * emit 失败 → catch-and-log，不阻塞 content API（fold codex P1）。
 */
export async function emitSecretHandleAudit(
  auditSink: AuditSink | undefined,
  handle: string | undefined,
  actor: string,
  traceId: string | undefined,
): Promise<void> {
  if (!auditSink || !handle) return;
  try {
    await auditSink.emit({
      eventType: "tool_call",
      actorType: "service",
      actor,
      target: `secret_handle:${handle}`,
      traceId: traceId ?? "unknown",
    });
  } catch (e) {
    console.warn("[secret-handle-hook] audit emit failed (non-blocking):", e);
  }
}
