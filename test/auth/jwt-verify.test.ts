// jwt-verify.test.ts — #2 终端用户 JWT 自验测试（Fold-3/4/5 修正版）。
// jose 5 node runtime 用 node:http.get（非 fetch），故用真实本地 http server mock JWKS，
// 而非 undici MockAgent（MockAgent 拦不到 http.get）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { SignJWT, exportJWK } from "jose";
import { createTokenVerifier, VerifyError } from "../../src/auth/jwt-verify.js";

const KID = "test-kid-1";
let privKeyObject: any; // KeyObject 签发用（Fold-5：非裸 JWK）
let pubJwk: any;
let server200: http.Server;
let server503: http.Server;
let url200: string;
let url503: string;

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privKeyObject = privateKey; // KeyObject 直接传给 SignJWT.sign
  pubJwk = await exportJWK(publicKey);
  pubJwk.kid = KID;
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  // JWKS 200 server（有效 key set）
  server200 = http.createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [pubJwk] }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  // JWKS 503 server（Fold-4：独立 host/port 避免 JWKS 缓存叠加）
  server503 = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end("down");
  });
  await Promise.all([
    new Promise<void>((r) => server200.listen(0, "127.0.0.1", () => r())),
    new Promise<void>((r) => server503.listen(0, "127.0.0.1", () => r())),
  ]);
  const a200 = server200.address() as { port: number };
  const a503 = server503.address() as { port: number };
  url200 = `http://127.0.0.1:${a200.port}`;
  url503 = `http://127.0.0.1:${a503.port}`;
});

afterAll(() => {
  server200.close();
  server503.close();
});

async function signToken(claims: object, opts: { kid?: string; issuer?: string; audience?: string; alg?: string; expiresIn?: number } = {}): Promise<string> {
  const signer = new SignJWT(claims as any)
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID })
    .setIssuedAt()
    .setSubject((claims as any).sub ?? "user-1")
    .setIssuer(opts.issuer ?? "agentos-iam")
    .setAudience(opts.audience ?? "content-backend")
    .setExpirationTime(opts.expiresIn !== undefined ? `${opts.expiresIn}s` : "900s");
  // Fold-5：sign 接收 KeyLike/CryptoKey，传 KeyObject 而非裸 JWK
  return signer.sign(privKeyObject);
}

function makeVerifier(jwksUrl = url200) {
  return createTokenVerifier({ jwksUrl, issuer: "agentos-iam", audience: "content-backend" });
}

describe("createTokenVerifier", () => {
  it("有效 token → {end_user_id, jti, exp}", async () => {
    const verifier = makeVerifier();
    const jwt = await signToken({ sub: "user-1", scope: "content:read", jti: "jti-abc" });
    const r = await verifier.verifyUserToken(jwt);
    expect(r.end_user_id).toBe("user-1");
    expect(r.jti).toBe("jti-abc");
    expect(r.exp).toBeGreaterThan(0);
  });

  it("错 issuer → VerifyError(401)", async () => {
    const verifier = makeVerifier();
    const jwt = await signToken({ sub: "u", jti: "j" }, { issuer: "wrong" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });

  it("错 audience → VerifyError(401)", async () => {
    const verifier = makeVerifier();
    const jwt = await signToken({ sub: "u", jti: "j" }, { audience: "wrong" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });

  it("过期 token → VerifyError(401)", async () => {
    const verifier = makeVerifier();
    const jwt = await signToken({ sub: "u", jti: "j" }, { expiresIn: -10 });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });

  it("unknown kid → VerifyError(401)（kid 精确路由）", async () => {
    const verifier = makeVerifier();
    const jwt = await signToken({ sub: "u", jti: "j" }, { kid: "unknown-kid" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });

  it("JWKS 503 → VerifyError(503)（独立 server 端口）", async () => {
    // Fold-4：503 用独立 host/port，verifier per-it 避免 JWKS cooldown 缓存
    const verifier = makeVerifier(url503);
    const jwt = await signToken({ sub: "u", jti: "j" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 503 });
  });

  it("非 JWT 字符串 → VerifyError(401)", async () => {
    const verifier = makeVerifier();
    await expect(verifier.verifyUserToken("not-a-jwt")).rejects.toMatchObject({ status: 401 });
  });

  it("jti/exp 缺失 → VerifyError(401)（Fold-3 新增）", async () => {
    const verifier = makeVerifier();
    // 签发一个无 jti 且 exp 正常的 token；jti 缺失应 401
    const jwt = await new SignJWT({ sub: "u" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer("agentos-iam")
      .setAudience("content-backend")
      .setExpirationTime("900s")
      .sign(privKeyObject);
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });
});
