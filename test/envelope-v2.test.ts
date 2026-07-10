import { describe, it, expect } from "vitest";
import { parseRequestEnvelope } from "../src/envelope.js";

describe("parseRequestEnvelope v1/v2 路由", () => {
  it("v1（无 version）→ version=1, userToken=null（匿名）", () => {
    const r = parseRequestEnvelope({ kind: "content_query", request: {} });
    expect(r.version).toBe(1);
    expect(r.userToken).toBeNull();
    expect(r.deviceId).toBeUndefined();
  });

  it("v2 + user_token 非空 → version=2, userToken/device_id 取出", () => {
    const r = parseRequestEnvelope({
      version: 2,
      kind: "content_query",
      request: {},
      user_token: "eyJ.x.y",
      device_id: "dev-1",
    });
    expect(r.version).toBe(2);
    expect(r.userToken).toBe("eyJ.x.y");
    expect(r.deviceId).toBe("dev-1");
  });

  it("v2 + user_token=null → version=2, userToken=null（匿名 self_hosted public）", () => {
    const r = parseRequestEnvelope({
      version: 2,
      kind: "content_query",
      request: {},
      user_token: null,
      device_id: "dev-1",
    });
    expect(r.version).toBe(2);
    expect(r.userToken).toBeNull();
    expect(r.deviceId).toBe("dev-1");
  });

  it("version=3 → throw（不支持的版本）", () => {
    expect(() =>
      parseRequestEnvelope({ version: 3, kind: "x", request: {} }),
    ).toThrow(/unsupported version/i);
  });

  it("v2 缺 device_id → throw（schema 违例）", () => {
    expect(() =>
      parseRequestEnvelope({
        version: 2,
        kind: "x",
        request: {},
        user_token: "t",
      }),
    ).toThrow(/device_id required/i);
  });

  it("v2 缺 user_token → throw（Fold-2：user_token required）", () => {
    expect(() =>
      parseRequestEnvelope({
        version: 2,
        kind: "x",
        request: {},
        device_id: "dev-1",
      }),
    ).toThrow(/user_token required/i);
  });

  it("非对象 body → throw", () => {
    expect(() => parseRequestEnvelope("nope")).toThrow(/invalid envelope/i);
    expect(() => parseRequestEnvelope(null)).toThrow(/invalid envelope/i);
    expect(() => parseRequestEnvelope([1, 2])).toThrow(/invalid envelope/i);
  });
});
