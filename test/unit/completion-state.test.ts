import { describe, it, expect } from "vitest";
import { wrapEnvelope } from "../../src/envelope.js";

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

  it("blocked → BLOCKED COPYRIGHT_RESTRICTED", () => {
    const r = wrapEnvelope(
      {},
      "content_lyrics",
      "self_hosted",
      "unavailable",
      "blocked",
    );
    expect(r.completion_state).toBe("BLOCKED");
    expect(r.error_code).toBe("COPYRIGHT_RESTRICTED");
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
});
