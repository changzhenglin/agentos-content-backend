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
  | "BACKEND_UNAVAILABLE";

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
 * completion_state 映射（spec §4.4）：
 * - real + ok → DONE（无 error_code）
 * - no_result → DONE_WITH_CONCERNS + NO_RESULT
 * - blocked → BLOCKED + COPYRIGHT_RESTRICTED
 * - unavailable → BLOCKED + BACKEND_UNAVAILABLE
 *
 * 注意：outcome 决定 completion_state；capability_mode 仅影响 real 判定。
 * 非 real capability_mode + ok 的组合按 brief 不出现（real 路径才 ok），
 * 故 ok 一律 DONE（不按 capability_mode 分叉，与 brief 逻辑一致）。
 */
function completionState(
  capabilityMode: CapabilityMode,
  outcome: Outcome,
): { completion_state: CompletionState; error_code?: ErrorCode } {
  if (outcome === "ok") return { completion_state: "DONE" };
  if (outcome === "no_result")
    return { completion_state: "DONE_WITH_CONCERNS", error_code: "NO_RESULT" };
  if (outcome === "blocked")
    return { completion_state: "BLOCKED", error_code: "COPYRIGHT_RESTRICTED" };
  // unavailable
  return { completion_state: "BLOCKED", error_code: "BACKEND_UNAVAILABLE" };
}

/**
 * wrapEnvelope：业务字段 + envelope 元数据。
 * business 字段展开到顶层（与 content-contract schema envelope 形状一致）。
 */
export function wrapEnvelope(
  business: object,
  kind: Kind,
  backendType: BackendType,
  capabilityMode: CapabilityMode,
  outcome: Outcome,
): Envelope {
  const cs = completionState(capabilityMode, outcome);
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
