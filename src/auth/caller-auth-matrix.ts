// caller-auth-matrix.ts — caller×source 域允许矩阵（单一源，plan-eng-review F2 / codex P3.8）。
// secret-store-stub + secret-handle-hook 两处 import 此处，不内联拷贝（防 drift）。
// 矩阵语义：caller 服务身份 → 该 caller 被允许解析的 handle source 域前缀数组。
// 来源：M3-pre §4.6 + M2d plan REVIEW FOLD。
//
// caller principal 域分离（codex C1）：
// - cloud-ext：HTTP inbound 唯一接受的 external caller（X-Caller-Identity 白名单）
// - content-backend：仅用于内部 adapter/store 调用 resolveHandle，从不从 HTTP 接受
// - anonymous：不在任何允许行，任何 caller 未识别均映射为 anonymous → 拒收

import type { BackendType } from "../envelope.js";

export const ALLOW_MATRIX: Record<string, string[]> = {
  "content-backend": ["^backend:"],
  "cloud-ext": ["^cloud:"],
  "ops-platform": ["^ops:"],
  "provisioning-service": ["^device:"],
  "device-hub": [], // M3 阶段2：self_hosted 路径无 handle，receiveAndAuthorize !handle 短路；列此行保矩阵完整
};

/**
 * caller×backend_type 允许矩阵（M3 阶段2 D7：device-hub 防越权）。
 * - cloud-ext：agent 工具，允许 self_hosted + third_party_api（链路4）
 * - device-hub：端侧网关，只允许 self_hosted（端侧不直接调 third_party provider，
 *   third_party 内容经 agent 链路4 触发；防 device-hub 伪造 provider 调用越权）
 * - 其他 caller（anonymous 等）：无任何 backend_type 允许
 */
export const ALLOWED_BACKEND_TYPES: Record<string, BackendType[]> = {
  "cloud-ext": ["self_hosted", "third_party_api"],
  "device-hub": ["self_hosted"],
};

/**
 * caller×backend_type 校验（route 层 resolveProviderPath 后调）。
 *
 * **只对 third_party_api 校验 caller**（防越权高风险：third_party 直连外部 provider）。
 * self_hosted 路径放行（与 receiveAndAuthorize !handle 短路一致——M2d 既有行为：
 * 无 handle = self_hosted = sim trust network，不校验 caller）。
 *
 * - self_hosted → authorized（不查矩阵，兼容既有无 caller 测试 + sim trust network）
 * - third_party_api → 查 ALLOWED_BACKEND_TYPES[caller]：
 *   * cloud-ext 允许（agent 链路4）
 *   * device-hub 拒（端侧不直连 provider，防越权）
 *   * anonymous/其他 拒（caller_not_allowed）
 *
 * 与 receiveAndAuthorize（caller×source）正交：receive 校验 handle 来源域，
 * 本函数校验 caller 被允许走的 backend 路径（仅 third_party）。
 */
export function authorizeBackendType(
  caller: string,
  backendType: BackendType,
): { authorized: boolean; reason?: string } {
  // self_hosted 路径放行（与 !handle 短路一致，sim trust network）
  if (backendType === "self_hosted") {
    return { authorized: true };
  }
  // third_party_api 路径校验 caller×backend_type（防越权）
  const allowed = ALLOWED_BACKEND_TYPES[caller];
  if (!allowed || !allowed.includes(backendType)) {
    return { authorized: false, reason: "backend_type_not_allowed" };
  }
  return { authorized: true };
}
