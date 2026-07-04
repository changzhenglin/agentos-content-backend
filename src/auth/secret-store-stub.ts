// secret-store-stub.ts — sim secret store（M3-pre §4.6 接口对齐，真 store runtime defer M3-pre SDD）。
// 接口按 plan REVIEW FOLD 修订（codex C2 + eng F2 + codex P2.6）：
//  - Secret 扩 expiry?/audience?（M3-pre 兼容，adapter 真用 token_type 选 bearer/query_param）
//  - resolveHandle 返 typed Result（不 throw stringly error）
//  - resolveHandle 第三参 expectedProvider：handle 形如 ^backend:qq:token_v1，
//    provider 段为 `:` 分隔的第 2 段（index 1）；传则必须一致，否则 provider_binding_mismatch
//    防 providerHandle[provider] 指向错误 provider 的 handle 致跨 provider 凭证泄漏
//  - 矩阵单一源：import ALLOW_MATRIX（不内联）
//
// sim 用内存 map；真 store 换外部 store（接口不变，defer M3-pre SDD）。
// 残余风险：caller 身份在 mTLS 绑定前视为不可信（spec defer M3-pre §4.5b），
// inbound route 只接受固定 cloud-ext external caller（codex C1）。

import { ALLOW_MATRIX } from "./caller-auth-matrix.js";

export interface Secret {
  token: string;
  token_type: "bearer" | "query_param";
  /** ISO 8601 过期时间（可选，真 store 提供；sim 可省） */
  expiry?: string;
  /** 凭证受众/目标服务（可选，防 token 滥用） */
  audience?: string;
}

/** resolveHandle 失败原因（typed Result，不 throw stringly） */
export type ResolveError =
  | "caller_not_allowed"
  | "source_not_allowed"
  | "provider_binding_mismatch"
  | "handle_not_found";

export type ResolveResult =
  | { ok: true; secret: Secret }
  | { ok: false; error: ResolveError };

export interface SecretStore {
  resolveHandle(
    handle: string,
    caller: string,
    expectedProvider?: string,
  ): Promise<ResolveResult>;
}

/** 从 handle 提取 source 域前缀（含冒号），如 "^backend:qq:token_v1" → "^backend:" */
function sourceDomain(handle: string): string {
  const idx = handle.indexOf(":");
  return idx > 0 ? handle.slice(0, idx + 1) : "";
}

/**
 * 从 handle 提取 provider 段（`:` 分隔的第 2 段，index 1）。
 * handle 形如 `^backend:qq:token_v1` → "qq"。
 * 无 provider 段（如 `^cloud:foo`，split 后 length<3）→ 返回 undefined。
 */
function providerSegment(handle: string): string | undefined {
  const parts = handle.split(":");
  // 期望至少 3 段：source 前缀 + provider + 余下；source 前缀以 `:` 结束所以 split 第一段是 "^backend"
  if (parts.length < 3) return undefined;
  return parts[1];
}

export function createStubSecretStore(
  secrets: Record<string, Secret>,
): SecretStore {
  return {
    async resolveHandle(handle, caller, expectedProvider) {
      // 1) caller 校验：caller 必须在 ALLOW_MATRIX（anonymous 不在 → caller_not_allowed）
      const allowed = ALLOW_MATRIX[caller];
      if (!allowed) {
        return { ok: false, error: "caller_not_allowed" };
      }
      // 2) source 域校验：handle 的 source 前缀必须在 caller 允许行
      const source = sourceDomain(handle);
      if (!allowed.includes(source)) {
        return { ok: false, error: "source_not_allowed" };
      }
      // 3) provider binding 校验（codex P2.6）：传 expectedProvider 时必须与 handle 内 provider 段一致
      if (expectedProvider !== undefined) {
        const hp = providerSegment(handle);
        if (hp !== expectedProvider) {
          return { ok: false, error: "provider_binding_mismatch" };
        }
      }
      // 4) handle 存在性
      const s = secrets[handle];
      if (!s) {
        return { ok: false, error: "handle_not_found" };
      }
      return { ok: true, secret: s };
    },
  };
}
