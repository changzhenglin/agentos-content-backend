// envelope.ts — 路由层统一 wrap（解 plan-eng C1/I10）。
// handler 只返回业务字段 + outcome，路由层调 wrapEnvelope 注入
// kind/version/backend_type/capability_mode/completion_state/error_code/runtime_mode。
//
// 注意：brief 写 `import type { Kind } from "./content-contract.js"`，但
// generated/content-contract.ts 只导出 AgentOSContentContract（无 Kind alias），
// 故此处内联 kind 字面量联合（与 contract §3.1 一致）。

export type Kind =
  | "content_query"
  | "content_match"
  | "content_stream"
  | "content_lyrics"
  | "content_metadata";

export type BackendType = "self_hosted" | "third_party_api";
export type CapabilityMode = "real" | "degraded" | "unavailable";
export type Outcome = "ok" | "no_result" | "blocked" | "unavailable";
export type CompletionState =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "BLOCKED"
  | "NEEDS_CONTEXT";
export type ErrorCode =
  | "NO_RESULT"
  | "COPYRIGHT_RESTRICTED"
  | "REGION_RESTRICTED"
  | "BACKEND_UNAVAILABLE"
  | "AUTH_FAILED"
  | "CAPABILITY_UNSUPPORTED";

export interface Envelope {
  kind: Kind;
  version: 1;
  backend_type: BackendType;
  capability_mode: CapabilityMode;
  completion_state: CompletionState;
  error_code?: ErrorCode;
  runtime_mode: "remote-service";
  [k: string]: unknown;
}

/**
 * completion_state 映射（spec §4.4 normative）：
 * - real + ok → DONE（无 error_code）
 * - real + no_result → DONE_WITH_CONCERNS + NO_RESULT
 * - degraded + ok（fallback self_hosted 成功）→ DONE_WITH_CONCERNS（可选 NO_RESULT；
 *   fallback 命中故不标 NO_RESULT，仅标 concern）
 * - degraded + fallback 失败 → BLOCKED + COPYRIGHT_RESTRICTED/BACKEND_UNAVAILABLE
 * - blocked → BLOCKED + errorCode（透传自 selectPath：COPYRIGHT_RESTRICTED 或 BACKEND_UNAVAILABLE）
 * - unavailable → BLOCKED + BACKEND_UNAVAILABLE
 *
 * 注意：ok 按 capabilityMode 分叉——real→DONE，degraded→DONE_WITH_CONCERNS
 * （解 I1：degraded+ok 不再一律 DONE，fallback 结果带 concern）。
 * blocked 的 errorCode 由 handler 透传 selectPath.errorCode（解 M1：不再硬编码
 * COPYRIGHT_RESTRICTED，使 authorized+provider-down 的 BACKEND_UNAVAILABLE 路径不被误标）。
 */
function completionState(
  capabilityMode: CapabilityMode,
  outcome: Outcome,
  errorCode?: ErrorCode,
): { completion_state: CompletionState; error_code?: ErrorCode } {
  if (outcome === "ok") {
    return capabilityMode === "degraded"
      ? { completion_state: "DONE_WITH_CONCERNS" }
      : { completion_state: "DONE" };
  }
  if (outcome === "no_result")
    return { completion_state: "DONE_WITH_CONCERNS", error_code: "NO_RESULT" };
  if (outcome === "blocked")
    return {
      completion_state: "BLOCKED",
      // errorCode 透传自 selectPath（COPYRIGHT_RESTRICTED / BACKEND_UNAVAILABLE）；
      // 兜底 COPYRIGHT_RESTRICTED（lyrics license blocked 等未带 errorCode 的情形）
      error_code: errorCode ?? "COPYRIGHT_RESTRICTED",
    };
  // unavailable
  return { completion_state: "BLOCKED", error_code: "BACKEND_UNAVAILABLE" };
}

/**
 * wrapEnvelope：业务字段 + envelope 元数据。
 * business 字段展开到顶层（与 content-contract schema envelope 形状一致）。
 * errorCode 由 handler 透传自 selectPath（解 M2：handler 返回 capabilityMode + errorCode，
 * T7 路由层无需 re-derive）。
 */
/**
 * ParsedRequestEnvelope：入向 content_request envelope 解析结果（#2）。
 * 按 version 路由：无 version→v1（匿名 self_hosted）；version=2→取 user_token(JWT|null)+device_id。
 * 供 T5 token-verify-hook 消费。
 *
 * 注：出向 Envelope 维持 version:1（spec §3.4），本接口仅用于入向解析，
 * 不污染响应类型（M1）。
 */
export interface ParsedRequestEnvelope {
  version: 1 | 2;
  kind?: string;
  userToken: string | null;
  deviceId?: string;
  raw: unknown;
}

/**
 * parseRequestEnvelope：入向 content_request envelope 解析（#2）。
 * 按 version 路由：无 version→v1（匿名 self_hosted）；version=2→取 user_token(JWT|null)+device_id。
 * user_token=null=匿名（self_hosted public / 第三方必填非空由业务层校验）。
 * version 非 1/2 → throw（C13 兼容：version present 必须=2）。
 * v2 缺 device_id → throw（schema required）。
 * v2 缺 user_token → throw（Fold-2：user_token required，即使为 null 也须显式传）。
 */
export function parseRequestEnvelope(body: unknown): ParsedRequestEnvelope {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid envelope: body must be object");
  }
  const b = body as Record<string, unknown>;
  const ver = b["version"];
  if (ver === undefined) {
    // v1：无 version（旧客户端/匿名 self_hosted）
    return {
      version: 1,
      kind: b["kind"] as string | undefined,
      userToken: null,
      raw: body,
    };
  }
  if (ver !== 2) {
    throw new Error(`unsupported version: ${ver}（仅支持 1/2）`);
  }
  // v2
  if (
    !("device_id" in b) ||
    typeof b["device_id"] !== "string" ||
    (b["device_id"] as string).length === 0
  ) {
    throw new Error("invalid envelope: v2 device_id required (non-empty string)");
  }
  if (!("user_token" in b)) {
    throw new Error("invalid envelope: v2 user_token required (string|null)");
  }
  const ut = b["user_token"];
  if (ut !== null && typeof ut !== "string") {
    throw new Error("invalid envelope: v2 user_token must be string or null");
  }
  return {
    version: 2,
    kind: b["kind"] as string | undefined,
    userToken: ut,
    deviceId: b["device_id"] as string,
    raw: body,
  };
}

export function wrapEnvelope(
  business: object,
  kind: Kind,
  backendType: BackendType,
  capabilityMode: CapabilityMode,
  outcome: Outcome,
  errorCode?: ErrorCode,
): Envelope {
  const cs = completionState(capabilityMode, outcome, errorCode);
  return {
    kind,
    version: 1,
    backend_type: backendType,
    capability_mode: capabilityMode,
    ...cs,
    runtime_mode: "remote-service",
    ...business,
  };
}
