// drm-ctx.ts — DrmCtx 共享类型（fold eng M2，不放 stream.ts 避免跨路由耦合）。
// auditSink 可选——drm fail-closed 不依赖 audit（fold codex P1#6）。
import type { PolicyStore } from "./policy-store.js";
import type { AuditSink } from "../audit/audit-sink.js";
import type { Kind } from "../envelope.js";

export interface DrmCtx {
  policyStore: PolicyStore;
  auditSink?: AuditSink; // 可选：无 audit 时 drm 仍生效，仅无 audit emit
  actor: string;
  requestRegion?: string;
  traceId?: string | null;
}
