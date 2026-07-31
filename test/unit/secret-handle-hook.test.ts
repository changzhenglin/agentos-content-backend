import { describe, it, expect, vi } from "vitest";
import { emitSecretHandleAudit, receiveAndAuthorize } from "../../src/auth/secret-handle-hook.js";
import type { AuditSink } from "../../src/audit/audit-sink.js";

function makeSink(events: any[]): AuditSink {
  return {
    emit: async (e) => {
      events.push(e);
    },
  };
}

describe("secret-handle-hook", () => {
  it("handle 存在 → audit emit tool_call target=secret_handle:<handle>", async () => {
    const events: any[] = [];
    const auditSink: AuditSink = { emit: async (e) => { events.push(e); } };
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
    const auditSink: AuditSink = { emit: async (e) => { events.push(e); } };
    await emitSecretHandleAudit(auditSink, undefined, "cloud-ext-service", "trace-2");
    await emitSecretHandleAudit(auditSink, "", "cloud-ext-service", "trace-3");
    expect(events).toHaveLength(0);
  });

  it("traceId 缺省 → audit 保留 null，不生成或写 unknown 占位", async () => {
    const events: any[] = [];
    const auditSink: AuditSink = { emit: async (e) => { events.push(e); } };
    await emitSecretHandleAudit(auditSink, "^cloud:x", "cloud-ext-service", undefined);
    expect(events).toHaveLength(1);
    expect(events[0].traceId).toBeNull();
  });
});

// receiveAndAuthorize（Task 2）：caller×source 矩阵校验 + audit。
// 语义对齐 plan REVIEW FOLD（concern A 两层校验 + F5 截断统一 12 + F2/P3.8 矩阵单一源）。
describe("receiveAndAuthorize", () => {
  it("cloud-ext + ^cloud:foo → authorized + audit emit tool_call target=secret_handle:^cloud:foo（<12 不截）", async () => {
    const events: any[] = [];
    const r = await receiveAndAuthorize({
      handle: "^cloud:foo",
      caller: "cloud-ext",
      auditSink: makeSink(events),
      traceId: "t1",
    });
    expect(r.authorized).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "tool_call",
      actor: "cloud-ext",
      target: "secret_handle:^cloud:foo",
      traceId: "t1",
    });
  });

  it("cloud-ext + ^backend:foo → authorized:false reason:source_not_allowed + audit unauthorized（concern A 两层）", async () => {
    const events: any[] = [];
    const r = await receiveAndAuthorize({
      handle: "^backend:foo",
      caller: "cloud-ext",
      auditSink: makeSink(events),
      traceId: "t1",
    });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("source_not_allowed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "tool_call",
      actor: "cloud-ext",
      target: "secret_handle:^backend:foo",
    });
    expect(events[0].traceId).toBe("t1");
  });

  it("anonymous + ^cloud:foo → authorized:false reason:caller_not_allowed + audit unauthorized", async () => {
    const events: any[] = [];
    const r = await receiveAndAuthorize({
      handle: "^cloud:foo",
      caller: "anonymous",
      auditSink: makeSink(events),
      traceId: "t1",
    });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("caller_not_allowed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "tool_call",
      actor: "anonymous",
      target: "secret_handle:^cloud:foo",
    });
    expect(events[0].traceId).toBe("t1");
  });

  it("无 handle（self_hosted 路径）→ authorized true + 不 audit", async () => {
    const events: any[] = [];
    const r = await receiveAndAuthorize({
      handle: undefined,
      caller: "anonymous",
      auditSink: makeSink(events),
      traceId: "t1",
    });
    expect(r.authorized).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("auditSink=undefined + 拒收 → authorized:false 不 throw（no-throw no-op audit）", async () => {
    const r = await receiveAndAuthorize({
      handle: "^backend:foo",
      caller: "cloud-ext",
      auditSink: undefined,
      traceId: "t1",
    });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("source_not_allowed");
  });

  it("F5 截断：handle >12 字符 → audit target=secret_handle: 前 12 字符", async () => {
    const events: any[] = [];
    const longHandle = "^cloud:abcdefghijklmn";
    const r = await receiveAndAuthorize({
      handle: longHandle,
      caller: "cloud-ext",
      auditSink: makeSink(events),
      traceId: "t1",
    });
    expect(r.authorized).toBe(true);
    expect(events[0].target).toBe("secret_handle:^cloud:abcde");
  });

  it("content-backend + ^backend:foo → authorized（矩阵另一行验证单一源）", async () => {
    const events: any[] = [];
    const r = await receiveAndAuthorize({
      handle: "^backend:foo",
      caller: "content-backend",
      auditSink: makeSink(events),
      traceId: "t1",
    });
    expect(r.authorized).toBe(true);
    expect(events[0].target).toBe("secret_handle:^backend:foo");
  });
});
