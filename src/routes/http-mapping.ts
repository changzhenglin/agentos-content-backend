// http-mapping.ts — completion_state + error_code → HTTP 状态码（spec §4.4 + I1 收窄）。
// DONE / DONE_WITH_CONCERNS → 200（有结果或带 concerns，仍 2xx）；
// BLOCKED + COPYRIGHT_RESTRICTED/REGION_RESTRICTED → 403（client-side block，内容受限/地区受限）；
// BLOCKED + BACKEND_UNAVAILABLE/AUTH_FAILED/无 errorCode → 503（server-side unavailable，5xx 兜底）。
//
// 注：errorCode 取值对齐 content-contract.schema.json:13 ErrorCode enum（schema 既有，
// 含 AUTH_FAILED/REGION_RESTRICTED）。envelope.ts 既有 TS type 缺这两个（M2a 遗留），
// T6 Step 1 扩 TS type 对齐 schema 后可去 as any；本签名用 string 兼容，不改 schema 不改 enum。

const CLIENT_BLOCK = new Set(["COPYRIGHT_RESTRICTED", "REGION_RESTRICTED"]);

export function httpStatus(completionState: string, errorCode?: string): number {
  if (completionState === "DONE" || completionState === "DONE_WITH_CONCERNS") return 200;
  // BLOCKED：按 errorCode 拆 4xx/5xx
  if (errorCode && CLIENT_BLOCK.has(errorCode)) return 403;
  return 503;
}
