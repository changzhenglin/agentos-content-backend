// http-mapping.ts — completion_state → HTTP 状态码（spec §4.4）。
// DONE / DONE_WITH_CONCERNS → 200（有结果或带 concerns，仍 2xx）；
// BLOCKED / 未知 → 503（服务不可用/被阻断，5xx 兜底）。

export function httpStatus(completionState: string): number {
  return completionState === "DONE" || completionState === "DONE_WITH_CONCERNS"
    ? 200
    : 503;
}
