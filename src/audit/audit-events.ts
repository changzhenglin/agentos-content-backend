// audit-events.ts — §8.3 matrix 五事件 helper（封装 AuditSink.emit 调用）。
// 复用 provision/revoke/config_apply/tool_call 四 event_type（D11 不扩 enum）；
// emitUnauthorized 复用 tool_call event_type（fold eng I5 / spec §6 "拒绝+audit unauthorized"）。
import type { AuditSink } from "./audit-sink.js";
import type { Kind } from "../envelope.js";

function traceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function emitProvision(
  sink: AuditSink,
  { ingestId, trackId, actor }: { ingestId: string; trackId: string; actor: string },
) {
  await sink.emit({
    eventType: "provision",
    actorType: "human",
    actor,
    target: trackId,
    traceId: traceId(),
  });
}

export async function emitRevoke(
  sink: AuditSink,
  { trackId, actor }: { trackId: string; actor: string },
) {
  await sink.emit({
    eventType: "revoke",
    actorType: "human",
    actor,
    target: trackId,
    traceId: traceId(),
  });
}

export async function emitConfigApply(
  sink: AuditSink,
  { ruleId, version, actor }: { ruleId: string; version: number; actor: string },
) {
  await sink.emit({
    eventType: "config_apply",
    actorType: "service",
    actor,
    target: ruleId,
    traceId: traceId(),
    policyVersion: version,
  });
}

export async function emitToolCall(
  sink: AuditSink,
  { kind, target, actor, streamId }: { kind: Kind; target: string; actor: string; streamId?: number },
) {
  await sink.emit({
    eventType: "tool_call",
    actorType: "service",
    actor,
    target,
    traceId: traceId(),
    streamId,
  });
}

// 403 拒绝审计：复用 tool_call event_type（不扩 enum），actor=caller，
// target=被拒资源，reason 进 traceId 语义（`traceId() + "|unauthorized:" + reason`）。
export async function emitUnauthorized(
  sink: AuditSink,
  { caller, reason, target }: { caller: string; reason: string; target: string },
) {
  await sink.emit({
    eventType: "tool_call",
    actorType: "service",
    actor: caller,
    target,
    traceId: `${traceId()}|unauthorized:${reason}`,
  });
}
