// caller-auth-matrix.ts — caller×source 域允许矩阵（单一源，plan-eng-review F2 / codex P3.8）。
// secret-store-stub + secret-handle-hook 两处 import 此处，不内联拷贝（防 drift）。
// 矩阵语义：caller 服务身份 → 该 caller 被允许解析的 handle source 域前缀数组。
// 来源：M3-pre §4.6 + M2d plan REVIEW FOLD。
//
// caller principal 域分离（codex C1）：
// - cloud-ext：HTTP inbound 唯一接受的 external caller（X-Caller-Identity 白名单）
// - content-backend：仅用于内部 adapter/store 调用 resolveHandle，从不从 HTTP 接受
// - anonymous：不在任何允许行，任何 caller 未识别均映射为 anonymous → 拒收

export const ALLOW_MATRIX: Record<string, string[]> = {
  "content-backend": ["^backend:"],
  "cloud-ext": ["^cloud:"],
  "ops-platform": ["^ops:"],
  "provisioning-service": ["^device:"],
};
