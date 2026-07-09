import { describe, it, expect } from "vitest";
import { loadEnv, assertProdEnv } from "../src/env.js";

describe("env token-verify 扩展", () => {
  it("loadEnv 读 IAM/OPS env + 默认值", () => {
    const e = loadEnv({
      iamJwksUrl: "http://iam:3000",
      iamJwtIssuer: "agentos-iam",
      iamJwtAudience: "content-backend",
      opsLookupUrl: "http://ops:3000",
      opsLookupToken: "secret-token",
      capabilityMode: "mock",
    });
    expect(e.iamJwksUrl).toBe("http://iam:3000");
    expect(e.iamJwtIssuer).toBe("agentos-iam");
    expect(e.iamJwtAudience).toBe("content-backend");
    expect(e.opsLookupUrl).toBe("http://ops:3000");
    expect(e.opsLookupToken).toBe("secret-token");
    expect(e.capabilityMode).toBe("mock");
  });

  it("loadEnv env 覆盖默认值", () => {
    const old = { ...process.env };
    process.env.IAM_JWKS_URL = "http://x:1";
    process.env.IAM_JWT_ISSUER = "iss";
    process.env.IAM_JWT_AUDIENCE = "aud";
    process.env.OPS_LOOKUP_URL = "http://y:2";
    process.env.OPS_LOOKUP_TOKEN = "t";
    process.env.CAPABILITY_MODE = "mock";
    const e = loadEnv();
    expect(e.iamJwksUrl).toBe("http://x:1");
    expect(e.iamJwtIssuer).toBe("iss");
    expect(e.iamJwtAudience).toBe("aud");
    expect(e.opsLookupUrl).toBe("http://y:2");
    expect(e.opsLookupToken).toBe("t");
    expect(e.capabilityMode).toBe("mock");
    process.env = old;
  });

  it("loadEnv 无 override 无 env 时默认值（空串 / 约定常量）", () => {
    const old = { ...process.env };
    delete process.env.IAM_JWKS_URL;
    delete process.env.IAM_JWT_ISSUER;
    delete process.env.IAM_JWT_AUDIENCE;
    delete process.env.OPS_LOOKUP_URL;
    delete process.env.OPS_LOOKUP_TOKEN;
    delete process.env.CAPABILITY_MODE;
    const e = loadEnv();
    expect(e.iamJwksUrl).toBe("");
    expect(e.opsLookupUrl).toBe("");
    expect(e.opsLookupToken).toBe("");
    expect(e.iamJwtIssuer).toBe("agentos-iam");
    expect(e.iamJwtAudience).toBe("content-backend");
    expect(e.capabilityMode).toBe("mock");
    process.env = old;
  });

  it("assertProdEnv: 非 production 直接返回（不抛）", () => {
    const old = { ...process.env };
    delete process.env.NODE_ENV;
    const e = loadEnv();
    expect(() => assertProdEnv(e)).not.toThrow();
    process.env = old;
  });

  it("assertProdEnv: production 缺必配项抛错", () => {
    const old = { ...process.env };
    process.env.NODE_ENV = "production";
    const e = loadEnv(); // 默认空串 → 缺三项
    expect(() => assertProdEnv(e)).toThrow(/prod env missing: IAM_JWKS_URL, OPS_LOOKUP_URL, OPS_LOOKUP_TOKEN/);
    process.env = old;
  });

  it("assertProdEnv: production 全配齐不抛（但 capabilityMode!=mock warn 不抛）", () => {
    const old = { ...process.env };
    process.env.NODE_ENV = "production";
    const e = loadEnv({
      iamJwksUrl: "http://iam:3000",
      opsLookupUrl: "http://ops:3000",
      opsLookupToken: "t",
      capabilityMode: "real",
    });
    expect(() => assertProdEnv(e)).not.toThrow();
    process.env = old;
  });
});
