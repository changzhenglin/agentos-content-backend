import { describe, it, expect } from "vitest";
import { parseTrackId } from "../../src/content/track-id.js";

describe("track-id", () => {
  it("parses self/qq/netease/kugou", () => {
    expect(parseTrackId("self:t123")).toEqual({ provider: "self", id: "t123" });
    expect(parseTrackId("qq:xyz")).toEqual({ provider: "qq", id: "xyz" });
    expect(parseTrackId("netease:n1")).toEqual({ provider: "netease", id: "n1" });
    expect(parseTrackId("kugou:k1")).toEqual({ provider: "kugou", id: "k1" });
  });

  it("unknown prefix → NO_RESULT", () => {
    expect(() => parseTrackId("foo:bar")).toThrow(/NO_RESULT/);
  });

  it("missing colon → NO_RESULT", () => {
    expect(() => parseTrackId("selft123")).toThrow(/NO_RESULT/);
  });

  it("empty id → NO_RESULT", () => {
    expect(() => parseTrackId("self:")).toThrow(/NO_RESULT/);
  });
});
