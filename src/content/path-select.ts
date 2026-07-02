import type { Provider } from "./track-id.js";

export type CapabilityKind =
  | "query"
  | "match"
  | "stream"
  | "lyrics"
  | "metadata";

export type BackendType = "self_hosted" | "third_party_api";
export type CapabilityMode = "real" | "degraded" | "unavailable";
export type ErrorCode = "COPYRIGHT_RESTRICTED" | "BACKEND_UNAVAILABLE";

export interface SelectedPath {
  backendType: BackendType;
  capabilityMode: CapabilityMode;
  errorCode?: ErrorCode;
}

// fallback 类：未授权时降级到 self_hosted degraded
const FALLBACK_KINDS: ReadonlySet<CapabilityKind> = new Set([
  "query",
  "match",
]);

/**
 * 路径选择 truth table（spec §4.3/§4.5）。
 *
 * - self → self_hosted/real
 * - third_party query/match 未授权 → self_hosted/degraded（fallback）
 * - third_party stream/lyrics/metadata 未授权 → BLOCKED
 *   （backend_type=attempted self_hosted 非 null，schema enum 无 null，解 C2）
 * - third_party authorized provider down → BLOCKED BACKEND_UNAVAILABLE
 * - third_party authorized available → third_party_api/real（M2d 落地真实路由）
 *
 * BLOCKED 时 backendType 取 attempted（self_hosted，因本 SDD 只 self_hosted 路径），
 * capabilityMode=unavailable，errorCode 标明阻断原因。
 */
export function selectPath(
  provider: Provider,
  authorized: boolean,
  kind: CapabilityKind,
  providerAvailable: boolean,
): SelectedPath {
  if (provider === "self") {
    return { backendType: "self_hosted", capabilityMode: "real" };
  }

  // third_party（M2d 落地真实路由，本 SDD 前缀识别但 self_hosted fallback）
  if (!authorized || !providerAvailable) {
    if (FALLBACK_KINDS.has(kind)) {
      // query/match 未授权 → 降级 self_hosted
      return { backendType: "self_hosted", capabilityMode: "degraded" };
    }
    // BLOCKED：stream/lyrics/metadata 未授权或 provider down
    // backend_type 取 attempted（self_hosted，本 SDD 只 self_hosted 路径），非 null（解 C2）
    return {
      backendType: "self_hosted",
      capabilityMode: "unavailable",
      errorCode: !authorized ? "COPYRIGHT_RESTRICTED" : "BACKEND_UNAVAILABLE",
    };
  }

  // third_party authorized + available → third_party_api/real
  return { backendType: "third_party_api", capabilityMode: "real" };
}
