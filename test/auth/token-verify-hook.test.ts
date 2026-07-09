// token-verify-hook.test.ts — #2 T5 token-verify-hook preHandler 单测。
// fastify inject + mock deps（非真实 http）。Fold-8：断言 error_code 非 error。
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { createTokenVerifyHook } from "../../src/auth/token-verify-hook.js";
import type { TokenVerifier } from "../../src/auth/jwt-verify.js";
import type { OpsLookupClient } from "../../src/auth/ops-lookup.js";

function makeApp(deps: {
  verifyToken: Partial<TokenVerifier>;
  lookupBinding: Partial<OpsLookupClient>;
  capabilityMode?: string;
}) {
  const app = Fastify();
  const hook = createTokenVerifyHook({
    verifyToken: deps.verifyToken as TokenVerifier,
    lookupBinding: deps.lookupBinding as OpsLookupClient,
    auditSink: undefined,
    capabilityMode: deps.capabilityMode ?? "mock",
  });
  app.post("/content_query", { preHandler: hook }, async (req, reply) => {
    return reply.send({ ok: true, endUser: req.endUser });
  });
  return app;
}

describe("token-verify-hook preHandler", () => {
  it("v1 envelope（无 version）→ 匿名短路 endUser=null", async () => {
    const app = makeApp({ verifyToken: {}, lookupBinding: {} });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: { kind: "content_query", request: {} },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().endUser).toBeNull();
  });

  it("v2 user_token=null → 匿名短路 endUser=null", async () => {
    const app = makeApp({ verifyToken: {}, lookupBinding: {} });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: {
        version: 2,
        kind: "content_query",
        request: {},
        user_token: null,
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().endUser).toBeNull();
  });

  it("v2 有效 token + bound=true → endUser 注入 {id,deviceId,role}", async () => {
    const app = makeApp({
      verifyToken: {
        verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 999 }),
      },
      lookupBinding: {
        lookupDeviceBinding: async () => ({
          bound: true,
          role: "owner",
          device_group_id: "g-1",
        }),
      },
    });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: {
        version: 2,
        kind: "content_query",
        request: {},
        user_token: "t",
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().endUser).toEqual({ id: "u-1", deviceId: "d-1", role: "owner" });
  });

  it("JWT 无效 → 401 + error_code INVALID_TOKEN", async () => {
    const { VerifyError } = await import("../../src/auth/jwt-verify.js");
    const app = makeApp({
      verifyToken: {
        verifyUserToken: async () => {
          throw new VerifyError(401, "bad sig");
        },
      },
      lookupBinding: {},
    });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: {
        version: 2,
        kind: "content_query",
        request: {},
        user_token: "t",
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error_code).toBe("INVALID_TOKEN");
  });

  it("JWKS 不可用 → 503 + error_code JWKS_UNAVAILABLE", async () => {
    const { VerifyError } = await import("../../src/auth/jwt-verify.js");
    const app = makeApp({
      verifyToken: {
        verifyUserToken: async () => {
          throw new VerifyError(503, "down");
        },
      },
      lookupBinding: {},
    });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: {
        version: 2,
        kind: "content_query",
        request: {},
        user_token: "t",
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error_code).toBe("JWKS_UNAVAILABLE");
  });

  it("bound=false → 403 + error_code DEVICE_NOT_BOUND", async () => {
    const app = makeApp({
      verifyToken: {
        verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 9 }),
      },
      lookupBinding: {
        lookupDeviceBinding: async () => ({ bound: false }),
      },
    });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: {
        version: 2,
        kind: "content_query",
        request: {},
        user_token: "t",
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error_code).toBe("DEVICE_NOT_BOUND");
  });

  it("lookup 不可用 → 503 + error_code LOOKUP_UNAVAILABLE", async () => {
    const { LookupError } = await import("../../src/auth/ops-lookup.js");
    const app = makeApp({
      verifyToken: {
        verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 9 }),
      },
      lookupBinding: {
        lookupDeviceBinding: async () => {
          throw new LookupError(503, "down");
        },
      },
    });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: {
        version: 2,
        kind: "content_query",
        request: {},
        user_token: "t",
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error_code).toBe("LOOKUP_UNAVAILABLE");
  });

  it("version=3 → 400 + error_code INVALID_ENVELOPE", async () => {
    const app = makeApp({ verifyToken: {}, lookupBinding: {} });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: { version: 3, kind: "x", request: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_code).toBe("INVALID_ENVELOPE");
  });

  it("region/entitlement capability_mode=mock 放行（不 reject）", async () => {
    const app = makeApp({
      verifyToken: {
        verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 9 }),
      },
      lookupBinding: {
        lookupDeviceBinding: async () => ({
          bound: true,
          role: "member",
          device_group_id: "g",
        }),
      },
      capabilityMode: "mock",
    });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      body: {
        version: 2,
        kind: "content_query",
        request: {},
        user_token: "t",
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(200);
  });
});
