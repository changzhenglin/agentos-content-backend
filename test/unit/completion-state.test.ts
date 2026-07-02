import { describe, it, expect } from "vitest";
import { wrapEnvelope } from "../../src/envelope.js";
import { selectPath } from "../../src/content/path-select.js";

describe("envelope wrap（§4.4 completion_state 映射）", () => {
  it("real+ok → DONE no error_code + runtime_mode + 业务字段透传", () => {
    const r = wrapEnvelope(
      { track_id: "self:t1" },
      "content_metadata",
      "self_hosted",
      "real",
      "ok",
    );
    expect(r.kind).toBe("content_metadata");
    expect(r.version).toBe(1);
    expect(r.backend_type).toBe("self_hosted");
    expect(r.capability_mode).toBe("real");
    expect(r.completion_state).toBe("DONE");
    expect(r.error_code).toBeUndefined();
    expect(r.runtime_mode).toBe("remote-service");
    expect((r as any).track_id).toBe("self:t1");
  });

  it("real+no_result → DONE_WITH_CONCERNS NO_RESULT", () => {
    const r = wrapEnvelope({}, "content_query", "self_hosted", "real", "no_result");
    expect(r.completion_state).toBe("DONE_WITH_CONCERNS");
    expect(r.error_code).toBe("NO_RESULT");
  });

  // I1：degraded+ok（fallback self_hosted 成功）→ DONE_WITH_CONCERNS（非 DONE）
  it("degraded+ok（fallback 命中）→ DONE_WITH_CONCERNS（spec §4.4，解 I1）", () => {
    const r = wrapEnvelope(
      { candidates: [{ track_id: "self:t1" }] },
      "content_query",
      "self_hosted",
      "degraded",
      "ok",
    );
    expect(r.completion_state).toBe("DONE_WITH_CONCERNS");
    expect(r.capability_mode).toBe("degraded");
    // fallback 命中故不标 NO_RESULT，仅标 concern
    expect(r.error_code).toBeUndefined();
  });

  it("blocked → BLOCKED COPYRIGHT_RESTRICTED（errorCode 透传，解 M1）", () => {
    const r = wrapEnvelope(
      {},
      "content_lyrics",
      "self_hosted",
      "unavailable",
      "blocked",
      "COPYRIGHT_RESTRICTED",
    );
    expect(r.completion_state).toBe("BLOCKED");
    expect(r.error_code).toBe("COPYRIGHT_RESTRICTED");
  });

  // M1：authorized+provider-down → BACKEND_UNAVAILABLE，非 COPYRIGHT_RESTRICTED
  it("blocked+BACKEND_UNAVAILABLE（authorized+provider-down）→ BLOCKED BACKEND_UNAVAILABLE（解 M1）", () => {
    // selectPath 真值：third_party authorized + provider down + stream → BACKEND_UNAVAILABLE
    const path = selectPath("qq", true, "stream", false);
    expect(path.capabilityMode).toBe("unavailable");
    expect(path.errorCode).toBe("BACKEND_UNAVAILABLE");

    const r = wrapEnvelope(
      {},
      "content_stream",
      "self_hosted",
      path.capabilityMode,
      "blocked",
      path.errorCode,
    );
    expect(r.completion_state).toBe("BLOCKED");
    expect(r.error_code).toBe("BACKEND_UNAVAILABLE");
    // 关键断言：不被误标为 COPYRIGHT_RESTRICTED
    expect(r.error_code).not.toBe("COPYRIGHT_RESTRICTED");
  });

  it("unavailable → BLOCKED BACKEND_UNAVAILABLE", () => {
    const r = wrapEnvelope(
      {},
      "content_stream",
      "third_party_api",
      "unavailable",
      "unavailable",
    );
    expect(r.completion_state).toBe("BLOCKED");
    expect(r.error_code).toBe("BACKEND_UNAVAILABLE");
  });

  it("version 永远 1 + runtime_mode 永远 remote-service", () => {
    for (const outcome of ["ok", "no_result", "blocked", "unavailable"] as const) {
      const r = wrapEnvelope({}, "content_query", "self_hosted", "real", outcome);
      expect(r.version).toBe(1);
      expect(r.runtime_mode).toBe("remote-service");
    }
  });

  // 第三方 query fallback 端到端映射（degraded+ok → DONE_WITH_CONCERNS）
  it("third_party query 未授权 fallback self_hosted 命中 → degraded+ok → DONE_WITH_CONCERNS", () => {
    const path = selectPath("qq", false, "query", false);
    expect(path.capabilityMode).toBe("degraded");
    expect(path.backendType).toBe("self_hosted");
    // queryBusiness 命中后 outcome=ok，路由层用 selectPath 的 degraded 包 envelope
    const r = wrapEnvelope(
      { candidates: [{ track_id: "self:t1" }] },
      "content_query",
      path.backendType,
      path.capabilityMode,
      "ok",
      path.errorCode,
    );
    expect(r.completion_state).toBe("DONE_WITH_CONCERNS");
    expect(r.capability_mode).toBe("degraded");
    expect(r.backend_type).toBe("self_hosted");
  });
});
