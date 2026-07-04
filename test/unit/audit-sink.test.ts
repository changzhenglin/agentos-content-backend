import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { createAuditSink } from "../../src/audit/audit-sink.js";
import {
  emitProvision,
  emitRevoke,
  emitConfigApply,
  emitToolCall,
  emitUnauthorized,
} from "../../src/audit/audit-events.js";

describe("audit-sink", () => {
  const path = ".tmp-audit.jsonl";
  beforeEach(() => rmSync(path, { force: true }));
  afterEach(() => rmSync(path, { force: true }));

  it("append 两事件 + hash chain 连续", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitRevoke(sink, { trackId: "self:t1", actor: "admin" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    expect(e1.eventType).toBe("provision");
    expect(e2.eventType).toBe("revoke");
    expect(e2.prevHash).toBe(e1.hash);
    expect(e1.prevHash).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("五事件 helper 字段正确", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitRevoke(sink, { trackId: "self:t1", actor: "admin" });
    await emitConfigApply(sink, { ruleId: "r1", version: 1, actor: "ops-platform" });
    await emitToolCall(sink, {
      kind: "content_stream",
      target: "self:t1",
      actor: "cloud-ext",
      streamId: 99,
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).eventType).toBe("provision");
    expect(JSON.parse(lines[1]).eventType).toBe("revoke");
    expect(JSON.parse(lines[2]).eventType).toBe("config_apply");
    const t = JSON.parse(lines[3]);
    expect(t.eventType).toBe("tool_call");
    expect(t.streamId).toBe(99);
    expect(t.actorType).toBe("service");
  });

  it("断链检测：手动改 prevHash → verifyChain 返 false", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    // 改写第一行 prevHash 制造断链
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const tampered = { ...JSON.parse(lines[0]), prevHash: "dead" };
    writeFileSync(path, JSON.stringify(tampered) + "\n");
    const { verifyChain } = await import("../../src/audit/audit-sink.js");
    expect(verifyChain(path)).toBe(false);
  });

  it("正向：合法两事件链 verifyChain===true（fold codex P1#5/eng C1，防回归）", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitRevoke(sink, { trackId: "self:t1", actor: "admin" });
    const { verifyChain } = await import("../../src/audit/audit-sink.js");
    expect(verifyChain(path)).toBe(true);
  });

  it("emitUnauthorized（403 拒绝审计，fold eng I5）", async () => {
    const { emitUnauthorized } = await import("../../src/audit/audit-events.js");
    const sink = createAuditSink(path);
    await emitUnauthorized(sink, {
      caller: "ops-platform",
      reason: "audience_mismatch",
      target: "content_policy",
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const e = JSON.parse(lines[0]);
    expect(e.eventType).toBe("tool_call");
    expect(e.actor).toBe("ops-platform");
    expect(e.target).toBe("content_policy");
  });

  it("actorType：human vs service", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitConfigApply(sink, { ruleId: "r1", version: 1, actor: "ops-platform" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).actorType).toBe("human");
    expect(JSON.parse(lines[1]).actorType).toBe("service");
  });

  // I2 fix: CLI 默认不 wire auditSink（env.auditSinkPath 默认空串）→ emit 函数须容忍 undefined sink，
  // no-throw no-op（不崩 403/业务路径）。secret-handle-hook.emitSecretHandleAudit 已有同款 guard。
  it("emit 函数 sink=undefined → no-throw no-op（I2: CLI 默认无 auditSink 时 audit 静默）", async () => {
    await expect(emitProvision(undefined as any, { ingestId: "i1", trackId: "self:t1", actor: "admin" })).resolves.toBeUndefined();
    await expect(emitRevoke(undefined as any, { trackId: "self:t1", actor: "admin" })).resolves.toBeUndefined();
    await expect(emitConfigApply(undefined as any, { ruleId: "r1", version: 1, actor: "ops-platform" })).resolves.toBeUndefined();
    await expect(emitToolCall(undefined as any, { kind: "content_stream", target: "self:t1", actor: "cloud-ext", streamId: 99 })).resolves.toBeUndefined();
    await expect(emitUnauthorized(undefined as any, { caller: "ops-platform", reason: "audience_mismatch", target: "content_policy" })).resolves.toBeUndefined();
  });
});
