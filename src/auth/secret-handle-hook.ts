// secret-handle-hook.ts — X-Secret-Handle header audit hook（M2c，不解析 `^backend:`）。
// 读 per-call opaque handle → audit emit tool_call target=secret_handle。
// 实际 `^backend:` 解析 defer M2d third_party_api adapter（本 hook 只记录不解析）。
// fold codex P1: hook 不阻塞业务——audit emit 失败只 log，不 throw（content API 不受影响）。
// fold CEO I2/codex P2: backend hook 不校验来源域（只记录），来源域校验归 cloud-ext 单点（injectSecretHandleHeader 检查 ^cloud:）；
//   M2d 解析侧补 backend caller auth 校验。剩余风险显式记录：backend 单点不防御，安全靠 cloud-ext。
import type { AuditSink } from "../audit/audit-sink.js";
import { emitUnauthorized } from "../audit/audit-events.js";
import { ALLOW_MATRIX } from "./caller-auth-matrix.js";

/**
 * 若 handle 非空，emit tool_call audit event（target=secret_handle:<handle>）。
 * handle 为空/undefined（self_hosted 路径）→ 不 emit。
 * actor=caller service identity（sim 用注入值，mTLS 绑定 defer M3-pre §4.5b）。
 * emit 失败 → catch-and-log，不阻塞 content API（fold codex P1）。
 *
 * 向后兼容入口（M2c 既有）；receiveAndAuthorize 内部 authorized 路径复用本函数，
 * 传入截断后的 handle（F5：统一 12 字符，对齐 M2c injectSecretHandleHeader）。
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

export interface AuthorizeResult {
  authorized: boolean;
  reason?: string;
}

/**
 * 从 handle 提取 source 域前缀（含冒号），如 "^backend:qq:token_v1" → "^backend:"。
 * 与 secret-store-stub.sourceDomain 同语义（不 import 仅为避免循环依赖时改签名；
 * secret-store-stub 未导出该 helper，故此处局部复用同逻辑——矩阵单一源已由 ALLOW_MATRIX 保证）。
 */
function sourceDomain(handle: string): string {
  const idx = handle.indexOf(":");
  return idx > 0 ? handle.slice(0, idx + 1) : "";
}

/**
 * receiveAndAuthorize（Task 2，plan REVIEW FOLD 修订）：
 *  - handle 为空（self_hosted 路径）→ authorized true，不 audit。
 *  - caller×source 矩阵校验两层（concern A 语义）：
 *    * caller_not_allowed：caller 不在 ALLOW_MATRIX（如 anonymous，principal 未识别）。
 *    * source_not_allowed：caller 在矩阵但 handle source 不在其允许行。
 *  - 匹配 → authorized true + audit tool_call target=secret_handle:<handle.slice(0,12)>（F5 截断统一 12）。
 *  - 不匹配 → authorized false + reason + audit unauthorized（emitUnauthorized，reason 进 traceId 语义）。
 *  - audit emit 失败 catch-and-log 不阻塞（M2c 既有；emitUnauthorized 内部已 guard sink undefined）。
 *
 * 矩阵单一源（F2/P3.8）：import ALLOW_MATRIX，不内联拷贝。
 */
export async function receiveAndAuthorize(opts: {
  handle: string | undefined;
  caller: string;
  auditSink: AuditSink | undefined;
  traceId: string | undefined;
}): Promise<AuthorizeResult> {
  const { handle, caller, auditSink, traceId } = opts;
  // self_hosted 路径：无 handle 不校验、不 audit
  if (!handle) return { authorized: true };

  // F5 截断统一 12（对齐 M2c injectSecretHandleHeader）
  const auditedHandle = handle.slice(0, 12);
  const target = `secret_handle:${auditedHandle}`;

  // concern A 两层校验
  const allowedSources = ALLOW_MATRIX[caller];
  if (!allowedSources) {
    // caller 不在矩阵（principal 未识别，如 anonymous）→ caller_not_allowed
    await emitUnauthorized(auditSink, {
      caller,
      reason: "caller_not_allowed",
      target,
    }).catch((e) =>
      console.warn("[secret-handle-hook] audit unauthorized emit failed:", e),
    );
    return { authorized: false, reason: "caller_not_allowed" };
  }

  const source = sourceDomain(handle);
  if (!allowedSources.includes(source)) {
    // caller 在矩阵但 source 不在其允许行 → source_not_allowed
    await emitUnauthorized(auditSink, {
      caller,
      reason: "source_not_allowed",
      target,
    }).catch((e) =>
      console.warn("[secret-handle-hook] audit unauthorized emit failed:", e),
    );
    return { authorized: false, reason: "source_not_allowed" };
  }

  // authorized：复用 emitSecretHandleAudit（向后兼容），传截断 handle 保 F5 一致
  await emitSecretHandleAudit(auditSink, auditedHandle, caller, traceId);
  return { authorized: true };
}
