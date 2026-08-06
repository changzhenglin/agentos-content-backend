// token-verify-route.e2e.test.ts — #2 Task 6 集成测试：buildServer wire token-verify preHandler。
//
// 验证 T5 createTokenVerifyHook 经 buildServer 挂载到 5 路由后，终端用户 token 校验 +
// 设备绑定校验在 preHandler 阶段生效（先于 route handler inline receiveAndAuthorize）。
//
// Mock 方式：真实 http.createServer 起 IAM JWKS + ops lookup 两个本地 server
// （同 T3/T4 测试模式；undici MockAgent 在 Node 25 拦不到 jose 的 node:http.get，
//  也拦不到 global fetch 的真实 DNS，故用真实本地 server）。
//
// Fold-9 修正：await buildServer(...) + env 嵌套在 opts.env 内（非 as any flat）。
// Fold-10 修正：sim 偏离声明见 src/index.ts 挂载处注释。
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK } from "jose";
import { buildServer } from "../../src/index.js";
import { createTestDb, seedTrack, type SeedTrack } from "./helpers.js";
import { createPolicyStore } from "../../src/policy/policy-store.js";
import { createAuditSink } from "../../src/audit/audit-sink.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KID = "route-kid-1";
let privKeyObject: any; // KeyObject 签发用（同 jwt-verify.test.ts 模式）
let pubJwk: any;
let iamServer: http.Server;
let opsServer: http.Server;
let iamUrl: string;
let opsUrl: string;
let auditDir: string;
let auditPath: string;

const baseTrack: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo",
  album: "Dawn",
  duration_ms: 1000,
  audio_object_key: "self:t1:v1",
  format: "mp3",
  bitrate: 128000,
  license: "CC",
};

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  privKeyObject = privateKey;
  pubJwk = await exportJWK(publicKey);
  pubJwk.kid = KID;
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  // IAM JWKS server（返 pubJwk）
  iamServer = http.createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [pubJwk] }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  // ops lookup server（按 device_id 路由 bound true/false）
  opsServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const deviceId = url.searchParams.get("device_id") ?? "";
    if (deviceId === "d-1") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ bound: true, role: "owner", device_group_id: "g-1" }),
      );
      return;
    }
    if (deviceId === "d-9") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bound: false }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await Promise.all([
    new Promise<void>((r) => iamServer.listen(0, "127.0.0.1", () => r())),
    new Promise<void>((r) => opsServer.listen(0, "127.0.0.1", () => r())),
  ]);
  iamUrl = `http://127.0.0.1:${(iamServer.address() as AddressInfo).port}`;
  opsUrl = `http://127.0.0.1:${(opsServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  iamServer.close();
  opsServer.close();
});

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), "t6-audit-"));
  auditPath = join(auditDir, "audit.jsonl");
});

afterEach(() => {
  rmSync(auditDir, { recursive: true, force: true });
});

async function signToken(sub = "u-1"): Promise<string> {
  return new SignJWT({ sub, scope: "content:read", jti: "jti-route-1" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer("agentos-iam")
    .setAudience("content-backend")
    .setExpirationTime("900s")
    .sign(privKeyObject);
}

function envOverrides() {
  return {
    iamJwksUrl: iamUrl,
    iamJwtIssuer: "agentos-iam",
    iamJwtAudience: "content-backend",
    opsLookupUrl: opsUrl,
    opsLookupToken: "tok",
    capabilityMode: "mock",
  };
}

describe("token-verify 路由集成（buildServer wire）", () => {
  it("v2 有效 token + bound → /content_query 200（preHandler 放行，业务正常）", async () => {
    const db = createTestDb();
    await seedTrack(db, baseTrack);
    const policyStore = createPolicyStore(db);
    const auditSink = createAuditSink(auditPath);
    const app = await buildServer({
      env: envOverrides(),
      db,
      policyStore,
      auditSink,
      actor: "anonymous-service",
    });
    const token = await signToken();
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: { "x-caller-identity": "device-hub", "x-trace-id": "t-200" },
      payload: {
        version: 2,
        kind: "content_query",
        query: { keywords: ["Sunrise"] },
        user_token: token,
        device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.completion_state).toBe("DONE");
    expect(body.backend_type).toBe("self_hosted");
  });

  it("bound=false → 403 DEVICE_NOT_BOUND（preHandler 拒收，不进 handler）", async () => {
    const db = createTestDb();
    await seedTrack(db, baseTrack);
    const policyStore = createPolicyStore(db);
    const auditSink = createAuditSink(auditPath);
    const app = await buildServer({
      env: envOverrides(),
      db,
      policyStore,
      auditSink,
      actor: "anonymous-service",
    });
    const token = await signToken();
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: { "x-caller-identity": "device-hub", "x-trace-id": "t-403" },
      payload: {
        version: 2,
        kind: "content_query",
        query: { keywords: ["Sunrise"] },
        user_token: token,
        device_id: "d-9",
      },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error_code).toBe("DEVICE_NOT_BOUND");
  });
});

describe("I2 unskip 回归守护：5 码响应过全量契约校验（状态码不被 AJV 转 500）", () => {
  it("无效签名 token → 401 INVALID_TOKEN（非 500）", async () => {
    const db = createTestDb();
    await seedTrack(db, baseTrack);
    const app = await buildServer({
      env: envOverrides(), db,
      policyStore: createPolicyStore(db),
      auditSink: createAuditSink(auditPath),
      actor: "anonymous-service",
    });
    const token = await signToken();
    const tampered = token.slice(0, -8) + "deadbeef"; // 破坏签名
    const r = await app.inject({
      method: "POST", url: "/content_query",
      headers: { "x-caller-identity": "device-hub", "x-trace-id": "t-i2-401" },
      payload: {
        version: 2, kind: "content_query", query: { keywords: ["Sunrise"] },
        user_token: tampered, device_id: "d-1",
      },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error_code).toBe("INVALID_TOKEN");
    expect(r.json().completion_state).toBe("BLOCKED");
  });

  it("非法 version envelope → 400 INVALID_ENVELOPE（非 500；fold Eng C1：{garbage:true} 触发 v1 匿名短路不可用，version:3 才是 parse 失败形状）", async () => {
    const db = createTestDb();
    await seedTrack(db, baseTrack);
    const app = await buildServer({
      env: envOverrides(), db,
      policyStore: createPolicyStore(db),
      auditSink: createAuditSink(auditPath),
      actor: "anonymous-service",
    });
    const r = await app.inject({
      method: "POST", url: "/content_query",
      headers: { "x-caller-identity": "device-hub", "x-trace-id": "t-i2-400" },
      payload: { version: 3, kind: "content_query", query: { keywords: ["Sunrise"] } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_code).toBe("INVALID_ENVELOPE");
  });
});
