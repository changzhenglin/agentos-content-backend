import { describe, it, expect } from "vitest";
import { objectKey, parseObjectKey, presignTtl } from "../../src/storage/presign.js";

describe("presign", () => {
  it("objectKey <provider>:<tid>:v<version>", () => {
    expect(objectKey("self", "t123", 1)).toBe("self:t123:v1");
  });

  it("parseObjectKey reverses", () => {
    expect(parseObjectKey("self:t123:v1")).toEqual({
      provider: "self",
      trackId: "t123",
      version: 1,
    });
  });

  it("parseObjectKey rejects malformed keys", () => {
    expect(() => parseObjectKey("self:t123:1")).toThrow();
    expect(() => parseObjectKey("self:t123")).toThrow();
    expect(() => parseObjectKey("self:t123:v1:extra")).toThrow();
    expect(() => parseObjectKey(":t123:v1")).toThrow();
  });

  it("TTL default 3600, range 300-86400", () => {
    expect(presignTtl()).toBe(3600);
    expect(presignTtl(300)).toBe(300);
    expect(presignTtl(86400)).toBe(86400);
    expect(() => presignTtl(100)).toThrow();
    expect(() => presignTtl(100000)).toThrow();
    expect(() => presignTtl(299)).toThrow();
    expect(() => presignTtl(86401)).toThrow();
  });
});
