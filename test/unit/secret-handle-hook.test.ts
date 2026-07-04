import { describe, it, expect, vi } from "vitest";
import { emitSecretHandleAudit } from "../../src/auth/secret-handle-hook.js";
import type { AuditSink } from "../../src/audit/audit-sink.js";

describe("secret-handle-hook", () => {
  it("handle 存在 → audit emit tool_call target=secret_handle:<handle>", async () => {
    const events: any[] = [];
    const auditSink: AuditSink = { emit: async (e) => events.push(e) };
    await emitSecretHandleAudit(auditSink, "^cloud:openclaw-provider@v2", "cloud-ext-service", "trace-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "tool_call",
      actorType: "service",
      actor: "cloud-ext-service",
      target: "secret_handle:^cloud:openclaw-provider@v2",
      traceId: "trace-1",
    });
  });

  it("handle 为空/undefined → 不 audit（self_hosted 路径无 handle）", async () => {
    const events: any[] = [];
    const auditSink: AuditSink = { emit: async (e) => events.push(e) };
    await emitSecretHandleAudit(auditSink, undefined, "cloud-ext-service", "trace-2");
    await emitSecretHandleAudit(auditSink, "", "cloud-ext-service", "trace-3");
    expect(events).toHaveLength(0);
  });

  it("traceId 缺省 → 用 fallback 占位（不阻塞 audit）", async () => {
    const events: any[] = [];
    const auditSink: AuditSink = { emit: async (e) => events.push(e) };
    await emitSecretHandleAudit(auditSink, "^cloud:x", "cloud-ext-service", undefined);
    expect(events).toHaveLength(1);
    expect(events[0].traceId).toMatch(/unknown|fallback/);
  });
});
