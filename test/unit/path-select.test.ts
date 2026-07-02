import { describe, it, expect } from "vitest";
import { selectPath } from "../../src/content/path-select.js";

describe("path-select truth table", () => {
  it("self → self_hosted/real (regardless of authorized/available)", () => {
    expect(selectPath("self", false, "stream", false)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "real",
    });
    expect(selectPath("self", true, "stream", true)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "real",
    });
  });

  it("third_party query/match unauthorized → self_hosted/degraded (fallback)", () => {
    expect(selectPath("qq", false, "query", false)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "degraded",
    });
    expect(selectPath("netease", false, "match", false)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "degraded",
    });
  });

  it("third_party stream/lyrics/metadata unauthorized → BLOCKED backend_type=attempted(self_hosted) COPYRIGHT_RESTRICTED", () => {
    expect(selectPath("qq", false, "stream", false)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "unavailable",
      errorCode: "COPYRIGHT_RESTRICTED",
    });
    expect(selectPath("kugou", false, "lyrics", false)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "unavailable",
      errorCode: "COPYRIGHT_RESTRICTED",
    });
    expect(selectPath("netease", false, "metadata", false)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "unavailable",
      errorCode: "COPYRIGHT_RESTRICTED",
    });
  });

  it("third_party authorized stream provider down → BLOCKED BACKEND_UNAVAILABLE", () => {
    expect(selectPath("qq", true, "stream", false)).toEqual({
      backendType: "self_hosted",
      capabilityMode: "unavailable",
      errorCode: "BACKEND_UNAVAILABLE",
    });
  });

  it("third_party authorized stream available → third_party_api/real", () => {
    expect(selectPath("qq", true, "stream", true)).toEqual({
      backendType: "third_party_api",
      capabilityMode: "real",
    });
  });
});
