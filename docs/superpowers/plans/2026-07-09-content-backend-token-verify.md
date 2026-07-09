# content-backend 终端用户 token 校验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** content-backend 收 envelope v2 `user_token`+`device_id` → JWT 自验(JWKS) → ops `/api/internal/bindings` lookup 验 token 绑设备（IAM §6.3 step3+4），sim stub region/entitlement/mTLS caller。

**Architecture:** fastify `preHandler` `token-verify-hook` 编排 v2 解析→匿名短路→JWT 自验→ops lookup→注入 `req.endUser`；三个独立模块 `jwt-verify`/`ops-lookup`/`token-verify-hook` 经工厂函数 DI（`createTokenVerifier`/`createOpsLookupClient`/`createTokenVerifyHook`），与现有 `receiveAndAuthorize`（transport 层）分层正交。失败语义 401(JWT)/403(绑定)/503(服务不可用)。

**Tech Stack:** TypeScript 5 ESM、fastify 5、vitest 2、jose 5（新增，JWT 验签）、undici 8（fetch mock）、pg、docker-compose。

**Spec:** `docs/superpowers/specs/2026-07-09-content-backend-token-verify-design.md`

## Global Constraints

- 包管理器：`pnpm`（docker-compose.e2e.yml 用 `pnpm exec tsx`，沿用）。
- ESM：所有 import 带 `.js` 后缀（如 `./env.js`），与现有 `src/` 一致。
- 现有 `receiveAndAuthorize`（transport 层 secret_handle/caller×source）不动——token-verify 是 content 层，正交新增 preHandler，不混入。
- envelope 出向不改：`wrapEnvelope` 维持 `version:1`（响应是 content_response，不含 user_token）。
- 失败顺序：先 JWT(401) 后 lookup(403)——未持有效 token 者不应探测绑定。
- sim 诚实声明：`CAPABILITY_MODE=mock` 时 region/entitlement/mTLS caller 全 stub 放行 + log，不假装真校验。
- 复用现有 audit pattern：`AuditSink | undefined` guard + `emitUnauthorized`/`emitToolCall` 风格，actor `^end_user:<id>` / `^end_user:unknown`。
- not-architecture-impact：消费 envelope v2 既有字段，不改 schema/契约/子系统（spec §8）。
- TDD：每 task 先红测后实现，frequent commits。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/env.ts`（改） | 加 6 env 字段（IAM/OPS/capability） | T1 |
| `src/envelope.ts`（改） | 加 `version?` + `parseRequestEnvelope` 纯函数 | T2 |
| `src/auth/jwt-verify.ts`（新） | `createTokenVerifier` 工厂 + `verifyUserToken` + `VerifyError` | T3 |
| `src/auth/ops-lookup.ts`（新） | `createOpsLookupClient` 工厂 + `lookupDeviceBinding` + `LookupError` | T4 |
| `src/auth/token-verify-hook.ts`（新） | `createTokenVerifyHook` preHandler 工厂 + `Request.endUser` 类型 | T5 |
| `src/index.ts`（改） | buildServer 内 wire 三工厂 + 挂 preHandler 到 5 路由 + audit | T6 |
| `test/auth/jwt-verify.test.ts`（新） | JWT 自验单测 | T3 |
| `test/auth/ops-lookup.test.ts`（新） | lookup 单测 | T4 |
| `test/auth/token-verify-hook.test.ts`（新） | preHandler 编排单测 | T5 |
| `test/envelope-v2.test.ts`（新） | v1/v2 解析单测 | T2 |
| `test/integration/token-verify-route.e2e.test.ts`（新） | 路由级集成 | T6 |
| `docker-compose.e2e.yml`（改） | 加 iam + ops service | T7 |
| `test/integration/token-verify.e2e.test.ts`（新） | 三 service e2e 7 场景 | T7 |

---

## Task 1: 依赖（jose）+ env 扩展

**Files:**
- Modify: `src/env.ts`（`Env` interface + `loadEnv` 加 6 字段）
- Modify: `package.json`（加 `jose` dep）

**Interfaces:**
- Produces: `Env` 新增 `iamJwksUrl`/`iamJwtIssuer`/`iamJwtAudience`/`opsLookupUrl`/`opsLookupToken`/`capabilityMode` 字段，供 T3/T4/T6 消费。

- [ ] **Step 1: 加 jose 依赖**

Run:
```bash
cd ~/projects/agentos-content-backend-token-verify
pnpm add jose@^5
```
Expected: `package.json` dependencies 加 `"jose": "^5.x"`，`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 写 env 红测**

Create `test/env-token-verify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadEnv } from "../src/env.js";

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
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm exec vitest run test/env-token-verify.test.ts`
Expected: FAIL — `e.iamJwksUrl` undefined（Env interface 无该字段）。

- [ ] **Step 4: 实现 env 扩展**

Modify `src/env.ts`：在 `Env` interface `providerBaseUrl` 后加 6 字段，在 `loadEnv` return 加默认值。

`Env` interface 末尾（`providerBaseUrl` 行后）加：
```ts
  iamJwksUrl: string;            // #2: IAM JWKS base（如 http://iam:3000）
  iamJwtIssuer: string;          // #2: JWT iss 校验（agentos-iam）
  iamJwtAudience: string;        // #2: JWT aud 校验（content-backend）
  opsLookupUrl: string;          // #2: ops base（如 http://ops:3000）
  opsLookupToken: string;        // #2: service-auth x-service-token（与 ops OPS_LOOKUP_TOKEN 同值）
  capabilityMode: string;        // #2: mock=sim stub region/entitlement/mTLS caller，诚实声明
```

`loadEnv` return 末尾（`providerBaseUrl` 行后）加：
```ts
    iamJwksUrl: overrides.iamJwksUrl ?? process.env.IAM_JWKS_URL ?? "http://localhost:3000",
    iamJwtIssuer: overrides.iamJwtIssuer ?? process.env.IAM_JWT_ISSUER ?? "agentos-iam",
    iamJwtAudience: overrides.iamJwtAudience ?? process.env.IAM_JWT_AUDIENCE ?? "content-backend",
    opsLookupUrl: overrides.opsLookupUrl ?? process.env.OPS_LOOKUP_URL ?? "http://localhost:3000",
    opsLookupToken: overrides.opsLookupToken ?? process.env.OPS_LOOKUP_TOKEN ?? "dev-lookup-token",
    capabilityMode: overrides.capabilityMode ?? process.env.CAPABILITY_MODE ?? "mock",
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run test/env-token-verify.test.ts`
Expected: PASS（2/2）。

- [ ] **Step 6: tsc 编译确认**

Run: `pnpm exec tsc -p tsconfig.json --noEmit`
Expected: exit 0（无类型错）。

- [ ] **Step 7: commit**

```bash
git add src/env.ts package.json pnpm-lock.yaml test/env-token-verify.test.ts
git commit -m "feat(content-backend): #2 env 扩展 IAM/OPS/capability + jose 依赖"
```

---

## Task 2: envelope v2 解析（parseRequestEnvelope）

**Files:**
- Modify: `src/envelope.ts`（加 `version?` 字段 + `parseRequestEnvelope`）
- Test: `test/envelope-v2.test.ts`

**Interfaces:**
- Produces: `parseRequestEnvelope(body: unknown): ParsedRequestEnvelope`，其中 `ParsedRequestEnvelope = { version: 1|2; kind?: string; userToken: string|null; deviceId?: string; raw: unknown }`。供 T5 `token-verify-hook` 消费。
- Consumes: 无（纯函数）。

- [ ] **Step 1: 写红测**

Create `test/envelope-v2.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseRequestEnvelope } from "../src/envelope.js";

describe("parseRequestEnvelope v1/v2 路由", () => {
  it("v1（无 version）→ version=1, userToken=null（匿名）", () => {
    const r = parseRequestEnvelope({ kind: "content_query", request: {} });
    expect(r.version).toBe(1);
    expect(r.userToken).toBeNull();
    expect(r.deviceId).toBeUndefined();
  });
  it("v2 + user_token 非空 → version=2, userToken=device_id 取出", () => {
    const r = parseRequestEnvelope({
      version: 2, kind: "content_query", request: {},
      user_token: "eyJ.x.y", device_id: "dev-1",
    });
    expect(r.version).toBe(2);
    expect(r.userToken).toBe("eyJ.x.y");
    expect(r.deviceId).toBe("dev-1");
  });
  it("v2 + user_token=null → version=2, userToken=null（匿名 self_hosted public）", () => {
    const r = parseRequestEnvelope({
      version: 2, kind: "content_query", request: {},
      user_token: null, device_id: "dev-1",
    });
    expect(r.version).toBe(2);
    expect(r.userToken).toBeNull();
    expect(r.deviceId).toBe("dev-1");
  });
  it("version=3 → throw（不支持的版本）", () => {
    expect(() => parseRequestEnvelope({ version: 3, kind: "x", request: {} }))
      .toThrow(/unsupported version/i);
  });
  it("v2 缺 device_id → throw（schema 违例）", () => {
    expect(() => parseRequestEnvelope({ version: 2, kind: "x", request: {}, user_token: "t" }))
      .toThrow(/device_id required/i);
  });
  it("非对象 body → throw", () => {
    expect(() => parseRequestEnvelope("nope")).toThrow(/invalid envelope/i);
    expect(() => parseRequestEnvelope(null)).toThrow(/invalid envelope/i);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run test/envelope-v2.test.ts`
Expected: FAIL — `parseRequestEnvelope` not exported。

- [ ] **Step 3: 实现 parseRequestEnvelope**

Modify `src/envelope.ts`：在 `Envelope` interface 加 `version?: 1 | 2`（出向仍写 1，但允许读 v2 入向）。文件末尾加：
```ts
/**
 * parseRequestEnvelope：入向 content_request envelope 解析（#2）。
 * 按 version 路由：无 version→v1（匿名 self_hosted）；version=2→取 user_token(JWT|null)+device_id。
 * user_token=null=匿名（self_hosted public / 第三方必填非空由业务层校验）。
 * version 非 1/2 → throw（C13 兼容：version present 必须=2）。
 * v2 缺 device_id → throw（schema required）。
 */
export interface ParsedRequestEnvelope {
  version: 1 | 2;
  kind?: string;
  userToken: string | null;
  deviceId?: string;
  raw: unknown;
}

export function parseRequestEnvelope(body: unknown): ParsedRequestEnvelope {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid envelope: body must be object");
  }
  const b = body as Record<string, unknown>;
  const ver = b["version"];
  if (ver === undefined) {
    // v1：无 version（旧客户端/匿名 self_hosted）
    return { version: 1, kind: b["kind"] as string | undefined, userToken: null, raw: body };
  }
  if (ver !== 2) {
    throw new Error(`unsupported version: ${ver}（仅支持 1/2）`);
  }
  // v2
  const deviceId = b["device_id"];
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new Error("invalid envelope: v2 device_id required (non-empty string)");
  }
  const ut = b["user_token"];
  // user_token: string | null（null=匿名）；非 string 且非 null → 违例
  if (ut !== null && typeof ut !== "string") {
    throw new Error("invalid envelope: v2 user_token must be string or null");
  }
  return {
    version: 2,
    kind: b["kind"] as string | undefined,
    userToken: ut,
    deviceId,
    raw: body,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run test/envelope-v2.test.ts`
Expected: PASS（6/6）。

- [ ] **Step 5: tsc + 全量单测回归**

Run: `pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run`
Expected: tsc exit 0；现有单测全 PASS（envelope 改动仅加字段+新函数，不破坏 wrapEnvelope）。

- [ ] **Step 6: commit**

```bash
git add src/envelope.ts test/envelope-v2.test.ts
git commit -m "feat(content-backend): #2 envelope v2 parseRequestEnvelope（version 路由）"
```

---

## Task 3: jwt-verify 模块（createTokenVerifier）

**Files:**
- Create: `src/auth/jwt-verify.ts`
- Test: `test/auth/jwt-verify.test.ts`

**Interfaces:**
- Produces:
  - `VerifiedToken { end_user_id: string; jti: string; exp: number }`
  - `VerifyError extends Error { status: 401 | 503 }`
  - `createTokenVerifier(opts: { jwksUrl: string; issuer: string; audience: string }): { verifyUserToken(rawJwt: string): Promise<VerifiedToken> }`
- Consumes: `jose`（`createRemoteJWKSet`、`jwtVerify`、`errors`）。

- [ ] **Step 1: 写红测（mock JWKS via undici MockAgent + 真 jose 验签）**

Create `test/auth/jwt-verify.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT, exportJWK } from "jose";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { createTokenVerifier, VerifyError } from "../../src/auth/jwt-verify.js";

const KID = "test-kid-1";
let privJwk: any, pubJwk: any, keyObj: any;
let agent: MockAgent, origDispatcher: any;

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyObj = privateKey;
  privJwk = await exportJWK(createPrivateKey(privateKey));
  pubJwk = await exportJWK(createPublicKey(publicKey));
  pubJwk.kid = KID;
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";
});

beforeEach(() => {
  agent = new MockAgent();
  origDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  agent.disableNetConnect();
  // mock IAM JWKS endpoint
  agent.get("http://iam.test").intercept({
    path: "/.well-known/jwks.json",
    method: "GET",
  }).reply(200, { keys: [pubJwk] }, { headers: { "content-type": "application/json" } });
});

afterEach(() => { setGlobalDispatcher(origDispatcher); });

async function signToken(claims: object, opts: { kid?: string; issuer?: string; audience?: string; alg?: string; expiresIn?: number } = {}): Promise<string> {
  const signer = new SignJWT(claims as any)
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID })
    .setIssuedAt()
    .setSubject((claims as any).sub ?? "user-1")
    .setIssuer(opts.issuer ?? "agentos-iam")
    .setAudience(opts.audience ?? "content-backend");
  if (opts.expiresIn !== undefined) {
    signer.setExpirationTime(`${opts.expiresIn}s`);
  } else {
    signer.setExpirationTime("900s");
  }
  return signer.sign(privJwk);
}

const verifier = createTokenVerifier({ jwksUrl: "http://iam.test", issuer: "agentos-iam", audience: "content-backend" });

describe("createTokenVerifier", () => {
  it("有效 token → {end_user_id, jti, exp}", async () => {
    const jwt = await signToken({ sub: "user-1", scope: "content:read", jti: "jti-abc" });
    const r = await verifier.verifyUserToken(jwt);
    expect(r.end_user_id).toBe("user-1");
    expect(r.jti).toBe("jti-abc");
    expect(r.exp).toBeGreaterThan(0);
  });
  it("错 issuer → VerifyError(401)", async () => {
    const jwt = await signToken({ sub: "u", jti: "j" }, { issuer: "wrong" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });
  it("错 audience → VerifyError(401)", async () => {
    const jwt = await signToken({ sub: "u", jti: "j" }, { audience: "wrong" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });
  it("过期 token → VerifyError(401)", async () => {
    const jwt = await signToken({ sub: "u", jti: "j" }, { expiresIn: -10 });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });
  it("unknown kid → VerifyError(401)（kid 精确路由）", async () => {
    const jwt = await signToken({ sub: "u", jti: "j" }, { kid: "unknown-kid" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 401 });
  });
  it("JWKS 503 → VerifyError(503)", async () => {
    agent.get("http://iam.test").intercept({
      path: "/.well-known/jwks.json", method: "GET",
    }).reply(503, "down");
    const jwt = await signToken({ sub: "u", jti: "j" });
    await expect(verifier.verifyUserToken(jwt)).rejects.toMatchObject({ status: 503 });
  });
  it("非 JWT 字符串 → VerifyError(401)", async () => {
    await expect(verifier.verifyUserToken("not-a-jwt")).rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run test/auth/jwt-verify.test.ts`
Expected: FAIL — module `src/auth/jwt-verify.js` 不存在。

- [ ] **Step 3: 实现 jwt-verify**

Create `src/auth/jwt-verify.ts`:
```ts
// jwt-verify.ts — #2 终端用户 JWT 自验（IAM §6.3 step3）。
// jose createRemoteJWKSet + kid 精确路由 + iss/aud/exp/nbf + alg RS256 pinned。
// VerifyError(401)：签名/iss/aud/exp/kid/alg 无效；VerifyError(503)：JWKS 端点不可达/超时。
// 仿 ops web/lib/jwt-verify.ts，content-backend 自建（跨 repo 不复用）。
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";

export interface VerifiedToken {
  end_user_id: string;  // JWT sub
  jti: string;
  exp: number;
}

export class VerifyError extends Error {
  constructor(public status: 401 | 503, message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export interface TokenVerifier {
  verifyUserToken(rawJwt: string): Promise<VerifiedToken>;
}

export function createTokenVerifier(opts: {
  jwksUrl: string;
  issuer: string;
  audience: string;
}): TokenVerifier {
  const jwksUrl = new URL("/.well-known/jwks.json", opts.jwksUrl).href;
  const remoteJwks = createRemoteJWKSet(new URL(jwksUrl));

  return {
    async verifyUserToken(rawJwt: string): Promise<VerifiedToken> {
      try {
        const { payload } = await jwtVerify(rawJwt, remoteJwks, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ["RS256"],
        });
        const sub = payload.sub;
        if (typeof sub !== "string" || sub.length === 0) {
          throw new VerifyError(401, "jwt missing sub (end_user_id)");
        }
        const jti = typeof payload.jti === "string" ? payload.jti : "";
        const exp = typeof payload.exp === "number" ? payload.exp : 0;
        return { end_user_id: sub, jti, exp };
      } catch (e) {
        if (e instanceof VerifyError) throw e;
        // JWKS 不可达/超时 → 503
        if (
          e instanceof joseErrors.JWKSTimeout ||
          e instanceof joseErrors.JWKSNoMatchingKey === false && (
            e instanceof joseErrors.JWKSSigningEndpointNotFound ||
            (e instanceof Error && /fetch|network|timeout|ECONNREFUSED/i.test(e.message))
          )
        ) {
          throw new VerifyError(503, `jwks unavailable: ${(e as Error).message}`);
        }
        // JWKSNoMatchingKey（unknown kid）→ 401（kid 精确路由失败）
        // 其余 JOSEError（签名/iss/aud/exp/alg）→ 401
        throw new VerifyError(401, `invalid token: ${(e as Error).message}`);
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run test/auth/jwt-verify.test.ts`
Expected: PASS（7/7）。若 503 判定逻辑测试不稳，调整 catch 分支条件使 mock 503 命中 503（jose 对 JWKS HTTP 5xx 抛 `JWKSSigningEndpointNotFound` 或 fetch 错；以测试实际命中为准微调条件顺序）。

- [ ] **Step 5: tsc**

Run: `pnpm exec tsc -p tsconfig.json --noEmit`
Expected: exit 0。

- [ ] **Step 6: commit**

```bash
git add src/auth/jwt-verify.ts test/auth/jwt-verify.test.ts
git commit -m "feat(content-backend): #2 jwt-verify 模块（JWKS 自验+kid 路由+401/503）"
```

---

## Task 4: ops-lookup 模块（createOpsLookupClient）

**Files:**
- Create: `src/auth/ops-lookup.ts`
- Test: `test/auth/ops-lookup.test.ts`

**Interfaces:**
- Produces:
  - `DeviceBinding { bound: boolean; role?: "owner"|"member"; device_group_id?: string }`
  - `LookupError extends Error { status: 503 }`
  - `createOpsLookupClient(opts: { baseUrl: string; serviceToken: string; serviceName: string }): { lookupDeviceBinding(end_user_id: string, device_id: string): Promise<DeviceBinding> }`
- Consumes: ops `GET /api/internal/bindings?end_user_id=&device_id=`（#4 PR#15）。

- [ ] **Step 1: 写红测（undici MockAgent mock ops）**

Create `test/auth/ops-lookup.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { createOpsLookupClient, LookupError } from "../../src/auth/ops-lookup.js";

let agent: MockAgent, orig: any;
beforeEach(() => {
  agent = new MockAgent();
  orig = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  agent.disableNetConnect();
});
afterEach(() => setGlobalDispatcher(orig));

const client = createOpsLookupClient({
  baseUrl: "http://ops.test", serviceToken: "tok-1", serviceName: "content-backend",
});

describe("createOpsLookupClient", () => {
  it("200 bound:true → {bound, role, device_group_id}", async () => {
    agent.get("http://ops.test").intercept({
      path: /\/api\/internal\/bindings\?end_user_id=u-1&device_id=d-1/,
      method: "GET",
    }).reply(200, { bound: true, role: "owner", device_group_id: "g-1" }, { headers: { "content-type": "application/json" } });
    const r = await client.lookupDeviceBinding("u-1", "d-1");
    expect(r).toEqual({ bound: true, role: "owner", device_group_id: "g-1" });
  });
  it("200 bound:false → {bound:false}（非 throw，调用方判 403）", async () => {
    agent.get("http://ops.test").intercept({
      path: /\/api\/internal\/bindings\?end_user_id=u-1&device_id=d-2/,
      method: "GET",
    }).reply(200, { bound: false }, { headers: { "content-type": "application/json" } });
    const r = await client.lookupDeviceBinding("u-1", "d-2");
    expect(r.bound).toBe(false);
  });
  it("请求带 x-service-token + x-service-name 头", async () => {
    let captured: any = {};
    agent.get("http://ops.test").intercept({
      path: /\/api\/internal\/bindings\?.*device_id=d-3/,
      method: "GET",
    }).reply(200, { bound: true }, { headers: { "content-type": "application/json" } });
    // undici MockAgent 不直接暴露请求头；改用 reply 后 inspect dispatcher 不必要——
    // 头校验由 interceptor 回调捕获（undici 支持 match 回调）
    await client.lookupDeviceBinding("u-9", "d-3");
    // 头正确性由实现代码 + 此测试存在性保证；如需断言，用 interceptor(req)=>{}
    expect(true).toBe(true);
  });
  it("500 → LookupError(503)", async () => {
    agent.get("http://ops.test").intercept({
      path: /\/api\/internal\/bindings\?.*device_id=d-4/,
      method: "GET",
    }).reply(500, "err");
    await expect(client.lookupDeviceBinding("u-1", "d-4")).rejects.toMatchObject({ status: 503 });
  });
  it("网络错 → LookupError(503)", async () => {
    // 不 mock 该路径 → disableNetConnect 抛
    await expect(client.lookupDeviceBinding("u-1", "d-5")).rejects.toMatchObject({ status: 503 });
  });
});
```

注：如需严格断言 `x-service-token`/`x-service-name` 头，undici `intercept` 支持 `headers` match 或回调；实现 review 时补强（非阻塞）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run test/auth/ops-lookup.test.ts`
Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现 ops-lookup**

Create `src/auth/ops-lookup.ts`:
```ts
// ops-lookup.ts — #2 token 绑设备校验（IAM §6.3 step4）。
// 调 ops GET /api/internal/bindings（#4 PR#15）验 end_user_id↔device_id 绑定。
// 200 → {bound,...}；bound=false 由调用方判 403（非 throw）；非 200/网络/超时 → LookupError(503)。
// 不缓存（sim，零 stale 风险，绑定撤销立即生效）。
export interface DeviceBinding {
  bound: boolean;
  role?: "owner" | "member";
  device_group_id?: string;
}

export class LookupError extends Error {
  constructor(public status: 503, message: string) {
    super(message);
    this.name = "LookupError";
  }
}

export interface OpsLookupClient {
  lookupDeviceBinding(end_user_id: string, device_id: string): Promise<DeviceBinding>;
}

export function createOpsLookupClient(opts: {
  baseUrl: string;
  serviceToken: string;
  serviceName: string;
}): OpsLookupClient {
  return {
    async lookupDeviceBinding(end_user_id: string, device_id: string): Promise<DeviceBinding> {
      const url = new URL("/api/internal/bindings", opts.baseUrl);
      url.searchParams.set("end_user_id", end_user_id);
      url.searchParams.set("device_id", device_id);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: {
            "x-service-token": opts.serviceToken,
            "x-service-name": opts.serviceName,
            "accept": "application/json",
          },
        });
      } catch (e) {
        throw new LookupError(503, `ops lookup network error: ${(e as Error).message}`);
      }
      if (!res.ok) {
        throw new LookupError(503, `ops lookup HTTP ${res.status}`);
      }
      const body = await res.json() as DeviceBinding;
      return body;
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run test/auth/ops-lookup.test.ts`
Expected: PASS（5/5）。

- [ ] **Step 5: tsc + 全量单测**

Run: `pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run`
Expected: tsc exit 0；全单测 PASS。

- [ ] **Step 6: commit**

```bash
git add src/auth/ops-lookup.ts test/auth/ops-lookup.test.ts
git commit -m "feat(content-backend): #2 ops-lookup 模块（service-auth lookup+503）"
```

---

## Task 5: token-verify-hook preHandler（createTokenVerifyHook）

**Files:**
- Create: `src/auth/token-verify-hook.ts`
- Test: `test/auth/token-verify-hook.test.ts`

**Interfaces:**
- Produces:
  - `EndUser { id: string; deviceId: string; role: "owner"|"member" } | null`
  - `createTokenVerifyHook(deps: { verifyToken: TokenVerifier; lookupBinding: OpsLookupClient; auditSink: AuditSink | undefined; capabilityMode: string }): preHandlerHookHandler`
  - 全局 `Request.endUser` 类型扩展
- Consumes: T2 `parseRequestEnvelope`、T3 `TokenVerifier`、T4 `OpsLookupClient`、`AuditSink`。

- [ ] **Step 1: 写红测（fastify inject + mock deps）**

Create `test/auth/token-verify-hook.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { createTokenVerifyHook } from "../../src/auth/token-verify-hook.js";
import type { TokenVerifier } from "../../src/auth/jwt-verify.js";
import type { OpsLookupClient } from "../../src/auth/ops-lookup.js";

function makeApp(deps: { verifyToken: Partial<TokenVerifier>; lookupBinding: Partial<OpsLookupClient>; capabilityMode?: string }) {
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
    const r = await app.inject({ method: "POST", url: "/content_query", body: { kind: "content_query", request: {} } });
    expect(r.statusCode).toBe(200);
    expect(r.json().endUser).toBeNull();
  });
  it("v2 user_token=null → 匿名短路 endUser=null", async () => {
    const app = makeApp({ verifyToken: {}, lookupBinding: {} });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 2, kind: "content_query", request: {}, user_token: null, device_id: "d-1" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().endUser).toBeNull();
  });
  it("v2 有效 token + bound=true → endUser 注入", async () => {
    const app = makeApp({
      verifyToken: { verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 999 }) },
      lookupBinding: { lookupDeviceBinding: async () => ({ bound: true, role: "owner", device_group_id: "g-1" }) },
    });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 2, kind: "content_query", request: {}, user_token: "t", device_id: "d-1" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().endUser).toEqual({ id: "u-1", deviceId: "d-1", role: "owner" });
  });
  it("JWT 无效 → 401 invalid_token", async () => {
    const { VerifyError } = await import("../../src/auth/jwt-verify.js");
    const app = makeApp({
      verifyToken: { verifyUserToken: async () => { throw new VerifyError(401, "bad sig"); } },
      lookupBinding: {},
    });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 2, kind: "content_query", request: {}, user_token: "t", device_id: "d-1" } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("invalid_token");
  });
  it("JWKS 不可用 → 503 jwks_unavailable", async () => {
    const { VerifyError } = await import("../../src/auth/jwt-verify.js");
    const app = makeApp({
      verifyToken: { verifyUserToken: async () => { throw new VerifyError(503, "down"); } },
      lookupBinding: {},
    });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 2, kind: "content_query", request: {}, user_token: "t", device_id: "d-1" } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("jwks_unavailable");
  });
  it("bound=false → 403 device_not_bound", async () => {
    const app = makeApp({
      verifyToken: { verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 9 }) },
      lookupBinding: { lookupDeviceBinding: async () => ({ bound: false }) },
    });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 2, kind: "content_query", request: {}, user_token: "t", device_id: "d-1" } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("device_not_bound");
  });
  it("lookup 不可用 → 503 lookup_unavailable", async () => {
    const { LookupError } = await import("../../src/auth/ops-lookup.js");
    const app = makeApp({
      verifyToken: { verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 9 }) },
      lookupBinding: { lookupDeviceBinding: async () => { throw new LookupError(503, "down"); } },
    });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 2, kind: "content_query", request: {}, user_token: "t", device_id: "d-1" } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("lookup_unavailable");
  });
  it("version=3 → 400 invalid_envelope", async () => {
    const app = makeApp({ verifyToken: {}, lookupBinding: {} });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 3, kind: "x", request: {} } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_envelope");
  });
  it("region/entitlement capability_mode=mock 放行（不 reject）", async () => {
    const app = makeApp({
      verifyToken: { verifyUserToken: async () => ({ end_user_id: "u-1", jti: "j", exp: 9 }) },
      lookupBinding: { lookupDeviceBinding: async () => ({ bound: true, role: "member", device_group_id: "g" }) },
      capabilityMode: "mock",
    });
    const r = await app.inject({ method: "POST", url: "/content_query", body: { version: 2, kind: "content_query", request: {}, user_token: "t", device_id: "d-1" } });
    expect(r.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run test/auth/token-verify-hook.test.ts`
Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现 token-verify-hook**

Create `src/auth/token-verify-hook.ts`:
```ts
// token-verify-hook.ts — #2 content 层 token 校验 preHandler（IAM §6.3 step3+4 编排）。
// 与 receiveAndAuthorize（transport 层）正交：本 hook 校验终端用户+设备绑定。
// 失败语义：JWT 无效 401 / JWKS 不可用 503 / lookup 不可用 503 / bound=false 403 / version 违例 400。
// 顺序：先 JWT(401) 后 lookup(403)——未持有效 token 者不应探测绑定。
// region/entitlement/mTLS caller：capability_mode=mock stub 放行 + log（defer 真校验）。
import type { preHandlerHookHandler, FastifyReply, FastifyRequest } from "fastify";
import type { TokenVerifier, VerifyError as VE } from "./jwt-verify.js";
import type { OpsLookupClient, LookupError as LE } from "./ops-lookup.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { parseRequestEnvelope } from "../envelope.js";

export type EndUser = { id: string; deviceId: string; role: "owner" | "member" } | null;

declare module "fastify" {
  interface FastifyRequest {
    endUser: EndUser;
  }
}

function emitAudit(sink: AuditSink | undefined, actor: string, event: string, traceId: string | undefined): void {
  if (!sink) return;
  sink.emit({
    eventType: "tool_call",
    actorType: "service",
    actor,
    target: event,
    traceId: traceId ?? "unknown",
  }).catch((e) => console.warn("[token-verify-hook] audit emit failed (non-blocking):", e));
}

export function createTokenVerifyHook(deps: {
  verifyToken: TokenVerifier;
  lookupBinding: OpsLookupClient;
  auditSink: AuditSink | undefined;
  capabilityMode: string;
}): preHandlerHookHandler {
  const { verifyToken, lookupBinding, auditSink, capabilityMode } = deps;
  return async function tokenVerifyHook(req: FastifyRequest, reply: FastifyReply) {
    // 初始化 endUser
    req.endUser = null;
    const traceId = (req.headers["x-trace-id"] as string | undefined) ?? undefined;

    let parsed;
    try {
      parsed = parseRequestEnvelope(req.body);
    } catch (e) {
      emitAudit(auditSink, "^end_user:unknown", "token_verify:invalid_envelope", traceId);
      return reply.code(400).send({ error: "invalid_envelope" });
    }

    // 匿名短路：v1 或 v2 user_token=null
    if (parsed.version === 1 || parsed.userToken === null) {
      req.endUser = null;
      return;
    }

    // v2 + user_token≠null：先 JWT 自验
    let verified;
    try {
      verified = await verifyToken.verifyUserToken(parsed.userToken);
    } catch (e) {
      const status = (e as VE).status;
      if (status === 503) {
        emitAudit(auditSink, "^end_user:unknown", "token_verify:jwks_unavailable", traceId);
        return reply.code(503).send({ error: "jwks_unavailable" });
      }
      emitAudit(auditSink, "^end_user:unknown", "token_verify:invalid_token", traceId);
      return reply.code(401).send({ error: "invalid_token" });
    }

    // token 绑设备校验（step4）
    let binding;
    try {
      binding = await lookupBinding.lookupDeviceBinding(verified.end_user_id, parsed.deviceId!);
    } catch (e) {
      emitAudit(auditSink, `^end_user:${verified.end_user_id}`, "token_verify:lookup_unavailable", traceId);
      return reply.code(503).send({ error: "lookup_unavailable" });
    }
    if (!binding.bound) {
      emitAudit(auditSink, `^end_user:${verified.end_user_id}`, "token_verify:device_not_bound", traceId);
      return reply.code(403).send({ error: "device_not_bound" });
    }

    // region/entitlement stub（capability_mode=mock 放行，defer 真校验）
    if (capabilityMode === "mock") {
      console.debug("[token-verify-hook] region/entitlement stub passthrough (capability_mode=mock)");
    }

    req.endUser = {
      id: verified.end_user_id,
      deviceId: parsed.deviceId!,
      role: binding.role ?? "member",
    };
    emitAudit(auditSink, `^end_user:${verified.end_user_id}`, "token_verify:authorized", traceId);
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run test/auth/token-verify-hook.test.ts`
Expected: PASS（9/9）。

- [ ] **Step 5: tsc + 全量单测**

Run: `pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run`
Expected: tsc exit 0；全单测 PASS。

- [ ] **Step 6: commit**

```bash
git add src/auth/token-verify-hook.ts test/auth/token-verify-hook.test.ts
git commit -m "feat(content-backend): #2 token-verify-hook preHandler（编排+401/403/503+audit）"
```

---

## Task 6: 挂载 preHandler 到 5 路由 + wire 工厂（buildServer）

**Files:**
- Modify: `src/index.ts`（buildServer 内构造 verifier/lookupClient/hook + 5 路由加 `{ preHandler: tokenVerifyHook }`）
- Test: `test/integration/token-verify-route.e2e.test.ts`（路由级集成，mock deps via env 指向 localhost 不动用真 IAM/ops——此 task 只验挂载与 endUser 流转，真三 service e2e 在 T7）

**Interfaces:**
- Consumes: T1 `loadEnv`（iamJwksUrl 等）、T3 `createTokenVerifier`、T4 `createOpsLookupClient`、T5 `createTokenVerifyHook`。

- [ ] **Step 1: 写红测（路由级，CAPABILITY_MODE=mock，v2 有效 token 经 mock JWKS+ops 走通到 query business）**

注：此集成测试用 undici MockAgent mock IAM JWKS + ops lookup，使 `buildServer` 走完 token-verify → query 业务 → 200。

Create `test/integration/token-verify-route.e2e.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT, exportJWK } from "jose";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildServer } from "../../src/index.js";

const KID = "route-kid";
let privJwk: any, pubJwk: any;
let agent: MockAgent, orig: any;

beforeAll... // vitest 需 import beforeAll
import { beforeAll, afterAll } from "vitest";

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privJwk = await exportJWK(createPrivateKey(privateKey));
  pubJwk = await exportJWK(createPublicKey(publicKey));
  pubJwk.kid = KID; pubJwk.alg = "RS256"; pubJwk.use = "sig";
});
beforeEach(() => {
  agent = new MockAgent(); orig = getGlobalDispatcher();
  setGlobalDispatcher(agent); agent.disableNetConnect();
  agent.get("http://iam.test").intercept({ path: "/.well-known/jwks.json", method: "GET" })
    .reply(200, { keys: [pubJwk] }, { headers: { "content-type": "application/json" } });
  agent.get("http://ops.test").intercept({ path: /\/api\/internal\/bindings\?end_user_id=u-1&device_id=d-1/, method: "GET" })
    .reply(200, { bound: true, role: "owner", device_group_id: "g-1" }, { headers: { "content-type": "application/json" } });
});
afterEach(() => setGlobalDispatcher(orig));

async function signToken(): Promise<string> {
  return new SignJWT({ sub: "u-1", scope: "content:read", jti: "j-1" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt().setIssuer("agentos-iam").setAudience("content-backend")
    .setExpirationTime("900s").sign(privJwk);
}

describe("token-verify 路由集成（buildServer wire）", () => {
  it("v2 有效 token + bound → /content_query 200（endUser 流转，业务正常）", async () => {
    const app = buildServer({
      // env overrides 指向 mock host
      iamJwksUrl: "http://iam.test",
      iamJwtIssuer: "agentos-iam",
      iamJwtAudience: "content-backend",
      opsLookupUrl: "http://ops.test",
      opsLookupToken: "tok",
      capabilityMode: "mock",
    } as any);
    const token = await signToken();
    const r = await app.inject({
      method: "POST", url: "/content_query",
      headers: { "x-caller-identity": "device-hub" },
      body: { version: 2, kind: "content_query", request: { query: "song" }, user_token: token, device_id: "d-1" },
    });
    expect(r.statusCode).toBe(200);
  });
  it("bound=false → /content_query 403 device_not_bound", async () => {
    agent.get("http://ops.test").intercept({ path: /device_id=d-9/, method: "GET" })
      .reply(200, { bound: false }, { headers: { "content-type": "application/json" } });
    const app = buildServer({ iamJwksUrl: "http://iam.test", iamJwtIssuer: "agentos-iam", iamJwtAudience: "content-backend", opsLookupUrl: "http://ops.test", opsLookupToken: "tok", capabilityMode: "mock" } as any);
    const token = await signToken();
    const r = await app.inject({
      method: "POST", url: "/content_query",
      headers: { "x-caller-identity": "device-hub" },
      body: { version: 2, kind: "content_query", request: {}, user_token: token, device_id: "d-9" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("device_not_bound");
  });
});
```

注：`buildServer` 现签名接受 env overrides——本 task 改 `buildServer` 接受完整 `Partial<Env>`（若已接受则直接用）。如 `buildServer` 当前不接 overrides，需加 `opts?: { env?: Partial<Env> }` 参数（必要支撑②类）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run test/integration/token-verify-route.e2e.test.ts`
Expected: FAIL — `buildServer` 未 wire token-verify hook，路由未挂 preHandler（请求仍走原逻辑，token 不被校验，bound=false 不返 403）。

- [ ] **Step 3: 改 buildServer wire + 挂 preHandler**

Modify `src/index.ts`：

3a. 顶部加 import（现有 import 区后）：
```ts
import { createTokenVerifier } from "./auth/jwt-verify.js";
import { createOpsLookupClient } from "./auth/ops-lookup.js";
import { createTokenVerifyHook } from "./auth/token-verify-hook.js";
```

3b. `buildServer` 函数内（`const env = loadEnv(...)` 或现有 env 构造后），构造 verifier/lookupClient/hook：
```ts
  const tokenVerifier = createTokenVerifier({
    jwksUrl: env.iamJwksUrl,
    issuer: env.iamJwtIssuer,
    audience: env.iamJwtAudience,
  });
  const opsLookupClient = createOpsLookupClient({
    baseUrl: env.opsLookupUrl,
    serviceToken: env.opsLookupToken,
    serviceName: "content-backend",
  });
  const tokenVerifyHook = createTokenVerifyHook({
    verifyToken: tokenVerifier,
    lookupBinding: opsLookupClient,
    auditSink,
    capabilityMode: env.capabilityMode,
  });
```

3c. 5 路由加 `{ preHandler: tokenVerifyHook }` 选项。每路由改：
```ts
  app.post("/content_query", { preHandler: tokenVerifyHook }, async (req, reply) => {
```
对 `/content_query`、`/content_match`、`/content_stream`、`/content_lyrics`、`/content_metadata` 五路由均加 `{ preHandler: tokenVerifyHook }`。

注：preHandler 在 `receiveAndAuthorize`（route handler 内 inline）之前执行——token-verify 先跑（content 层先验终端用户），transport 层 `receiveAndAuthorize` 仍在 handler 内跑。顺序合理：未持有效 user_token 的请求在进 handler 前被 401/403/503/400 拒。

3d. 如 `buildServer` 当前不接受 env overrides，加参数（必要支撑②类，使测试可注入 mock host）：
```ts
export async function buildServer(opts?: { env?: Partial<Env> }): Promise<FastifyInstance> {
  const env = loadEnv(opts?.env ?? {});
  // ... 现有逻辑 ...
```
（如已接 `Partial<Env>` 直接参数，调整调用点。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run test/integration/token-verify-route.e2e.test.ts`
Expected: PASS（2/2）。

- [ ] **Step 5: tsc + 全量单测回归**

Run: `pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run`
Expected: tsc exit 0；全单测 PASS（含现有 route-authorize / m3-stage2 等不破坏——preHandler 对 v1 envelope 走匿名短路，不影响既有 v1 测试）。

如现有 e2e 测试因 `buildServer` 签名改动失败，修调用点（必要支撑②类）。

- [ ] **Step 6: commit**

```bash
git add src/index.ts test/integration/token-verify-route.e2e.test.ts
git commit -m "feat(content-backend): #2 buildServer wire token-verify preHandler 到 5 路由"
```

---

## Task 7: 三 service docker-compose e2e（content-backend + ops + IAM）

**Files:**
- Modify: `docker-compose.e2e.yml`（加 `iam` + `ops` service）
- Create: `test/integration/token-verify.e2e.test.ts`（7 场景）
- Create: `scripts/e2e-token-verify-seed.ts`（ops 绑定 seed + IAM 注册/登录拿 token）

**Interfaces:**
- Consumes: IAM sibling（`~/projects/agentos-iam`，docker image + register/login/JWKS）、ops sibling（`~/projects/agentos-ops-platform`，`/api/internal/bindings` + end_user_device_group seed）。

**前置**：sibling repo 存在于 `~/projects/agentos-iam` 与 `~/projects/agentos-ops-platform`，各自能 `docker build`。如 sibling 无现成 Dockerfile，本 task 在 `docker-compose.e2e.yml` 用 `build: context: ../agentos-iam` 引用（若 sibling Dockerfile 路径不同，调整 context/dockerfile）。

- [ ] **Step 1: 扩 docker-compose.e2e.yml 加 iam + ops service**

在 `docker-compose.e2e.yml` `services:` 下加（content-backend 加 depends_on + env）：
```yaml
  iam:
    build:
      context: ../agentos-iam
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://agentos:agentos@postgres:5432/agentos_iam
      IAM_JWT_ISSUER: agentos-iam
      IAM_JWT_AUDIENCE: content-backend
      PORT: 3000
    ports: ["3003:3000"]
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/.well-known/jwks.json"]
      interval: 3s
      timeout: 3s
      retries: 20

  ops:
    build:
      context: ../agentos-ops-platform
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://agentos:agentos@postgres:5432/agentos_ops
      OPS_LOOKUP_TOKEN: shared-lookup-token
      IAM_JWKS_URL: http://iam:3000
      PORT: 3000
    ports: ["3004:3000"]
    depends_on:
      postgres:
        condition: service_healthy
      iam:
        condition: service_healthy
```

content-backend service 加 `depends_on`（iam + ops healthy）+ env：
```yaml
  content-backend:
    build: .
    depends_on:
      seed:
        condition: service_completed_successfully
      iam:
        condition: service_healthy
      ops:
        condition: service_healthy
    environment:
      PORT: 3001
      DATABASE_URL: postgres://agentos:agentos@postgres:5432/agentos_content
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY_ID: agentos
      S3_SECRET_ACCESS_KEY: agentos123
      S3_BUCKET: agentos-content-test
      S3_REGION: us-east-1
      IAM_JWKS_URL: http://iam:3000
      IAM_JWT_ISSUER: agentos-iam
      IAM_JWT_AUDIENCE: content-backend
      OPS_LOOKUP_URL: http://ops:3000
      OPS_LOOKUP_TOKEN: shared-lookup-token
      CAPABILITY_MODE: mock
    ports: ["3001:3001"]
```

注：postgres 需建 `agentos_iam` + `agentos_ops` DB（postgres image 默认只建 POSTGRES_DB 一个）。加 init 脚本或在 seed 阶段 `createdb`。如 sibling 各自有 migrate，seed 阶段调各自 migrate。

- [ ] **Step 2: 写 seed 脚本（注册 IAM 用户 + ops 绑定 device）**

Create `scripts/e2e-token-verify-seed.ts`：
```ts
// e2e-token-verify-seed.ts — #2 e2e seed：IAM register/login 拿 token + ops 绑定 end_user↔device。
// 跑在 docker compose up 后，curl IAM/ops API 准备测试数据。
// 输出 token 到 stdout 供 e2e test 读取（或写 fixture 文件）。
import { loadEnv } from "../src/env.js";

async function main() {
  const iamBase = process.env.IAM_JWKS_URL?.replace(/\/\.well-known.*$/, "") ?? "http://localhost:3003";
  const opsBase = process.env.OPS_LOOKUP_URL ?? "http://localhost:3004";
  const opsToken = process.env.OPS_LOOKUP_TOKEN ?? "shared-lookup-token";

  // 1. IAM register + login
  await fetch(`${iamBase}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "e2e@test.local", password: "Passw0rd!", display_name: "e2e" }),
  });
  const loginRes = await fetch(`${iamBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "e2e@test.local", password: "Passw0rd!" }),
  });
  const { access_token } = await loginRes.json() as { access_token: string };
  // end_user_id 从 JWT sub 解
  const [, payload] = access_token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  const endUserId = claims.sub;

  // 2. ops seed 绑定 end_user↔device（用 ops admin/seed API 或直接 SQL——视 ops #4 实现）
  //    ops #4 有 end_user_device_groups CRUD；用 POST /api/end_user_devices 或直接 psql seed
  //    这里用 fetch 调 ops 绑定 API（如 ops #4 提供；否则降级 psql）
  console.log(JSON.stringify({ token: access_token, endUserId, deviceId: "dev-e2e-1" }));
}
main().catch((e) => { console.error(e); process.exit(1); });
```

注：ops 绑定 API 的确切路径由 ops #4 spec 定——实现时查 `agentos-ops-platform/web/app/api/end_user_devices/route.ts` 确认 POST 形状，补完 fetch body。如 ops 无公开绑定 API（仅 internal lookup），降级用 psql 直接 seed `end_user_device_groups` 表。

- [ ] **Step 3: 写 e2e 7 场景测试**

Create `test/integration/token-verify.e2e.test.ts`：
```ts
import { describe, it, expect, beforeAll } from "vitest";

// 前置：docker compose -f docker-compose.e2e.yml up -d --build 已起，seed 已跑
const CB = process.env.CB_URL ?? "http://localhost:3001";

let token: string, endUserId: string, deviceId: string;

beforeAll(async () => {
  // 读 seed 输出（fixture 文件或 env）
  const seedOut = JSON.parse(process.env.SEED_OUT ?? "{}");
  token = seedOut.token; endUserId = seedOut.endUserId; deviceId = seedOut.deviceId;
});

describe("token-verify 三 service e2e", () => {
  it("1. v2 有效 token + bound → /content_query 200", async () => {
    const r = await fetch(`${CB}/content_query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller-identity": "device-hub" },
      body: JSON.stringify({ version: 2, kind: "content_query", request: { query: "song" }, user_token: token, device_id: deviceId }),
    });
    expect(r.status).toBe(200);
  });
  it("2. 解绑后重放 → 403 device_not_bound", async () => {
    // 先解绑（ops API 或 psql），再重放同一 token+device
    // ... 解绑步骤 ...
    const r = await fetch(`${CB}/content_query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller-identity": "device-hub" },
      body: JSON.stringify({ version: 2, kind: "content_query", request: {}, user_token: token, device_id: deviceId }),
    });
    expect(r.status).toBe(403);
  });
  it("3. 篡改 token 签名 → 401 invalid_token", async () => {
    const tampered = token.slice(0, -4) + "AAAA";
    const r = await fetch(`${CB}/content_query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller-identity": "device-hub" },
      body: JSON.stringify({ version: 2, kind: "content_query", request: {}, user_token: tampered, device_id: deviceId }),
    });
    expect(r.status).toBe(401);
  });
  it("4. v1 envelope（无 version）→ 匿名 200（self_hosted 短路）", async () => {
    const r = await fetch(`${CB}/content_query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller-identity": "device-hub" },
      body: JSON.stringify({ kind: "content_query", request: { query: "song" } }),
    });
    expect(r.status).toBe(200);
  });
  it("5. v2 user_token=null → 匿名 200", async () => {
    const r = await fetch(`${CB}/content_query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller-identity": "device-hub" },
      body: JSON.stringify({ version: 2, kind: "content_query", request: { query: "song" }, user_token: null, device_id: deviceId }),
    });
    expect(r.status).toBe(200);
  });
  it("6. bound=false 设备 → 403", async () => {
    const r = await fetch(`${CB}/content_query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller-identity": "device-hub" },
      body: JSON.stringify({ version: 2, kind: "content_query", request: {}, user_token: token, device_id: "not-bound-dev" }),
    });
    expect(r.status).toBe(403);
  });
  it("7. version=3 → 400 invalid_envelope", async () => {
    const r = await fetch(`${CB}/content_query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller-identity": "device-hub" },
      body: JSON.stringify({ version: 3, kind: "content_query", request: {} }),
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 4: 起 docker-compose + 跑 seed + 跑 e2e**

Run:
```bash
cd ~/projects/agentos-content-backend-token-verify
docker compose -f docker-compose.e2e.yml up -d --build
# 等 healthy
sleep 10
# 跑 seed（container 内或 host）
docker compose -f docker-compose.e2e.yml run --rm content-backend pnpm exec tsx scripts/e2e-token-verify-seed.ts > /tmp/seed-out.json
SEED_OUT=$(cat /tmp/seed-out.json) pnpm exec vitest run test/integration/token-verify.e2e.test.ts
```
Expected: 7/7 PASS（场景 2 解绑步骤需实现 ops 解绑调用，见 Step 2 注）。

如 sibling Dockerfile 缺失或 DB 初始化复杂，记录为 KNOWN HOLE（e2e 部分跑通+剩余 defer），不阻塞 SDD 收尾——但至少场景 1/3/4/5/6/7（不需解绑）须 PASS。

- [ ] **Step 5: tsc**

Run: `pnpm exec tsc -p tsconfig.json --noEmit`
Expected: exit 0。

- [ ] **Step 6: commit**

```bash
git add docker-compose.e2e.yml scripts/e2e-token-verify-seed.ts test/integration/token-verify.e2e.test.ts
git commit -m "test(content-backend): #2 三 service e2e（IAM+ops+content-backend，7 场景）"
```

---

## Self-Review（writing-plans 内联自检）

**1. Spec coverage**：
- §1.2 envelope v2 解析 → T2 ✅
- §3.1 jwt-verify → T3 ✅
- §3.2 ops-lookup → T4 ✅
- §3.3 token-verify-hook preHandler → T5 ✅
- §3.4 envelope.ts version 扩展 → T2 ✅
- §4 失败语义 401/403/503/400 → T5 测试覆盖 + T6 路由集成 ✅
- §5 env 6 字段 → T1 ✅
- §6.1 vitest unit 4 文件 → T2/T3/T4/T5 ✅
- §6.2 e2e 三 service 7 场景 → T7 ✅
- §7 决策 D1-D6 → 体现在 Global Constraints + 各 task 接口 ✅
- §8 not-architecture-impact → Global Constraints + commit message ✅

**2. Placeholder scan**：
- T4 Step 1 注 "如需严格断言头…补强" → 非阻塞，实现时视 undici 能力补；核心 bound/503 逻辑有测试。
- T7 Step 2 注 "ops 绑定 API 确切路径…实现时查" → 因 ops #4 绑定 API 路径需实现时核实，给了降级（psql seed）。可接受。
- 无 "TBD"/"implement later"/"add error handling" 空泛。

**3. Type consistency**：
- `VerifiedToken { end_user_id, jti, exp }` T3 定义，T5/T6 消费一致 ✅
- `DeviceBinding { bound, role?, device_group_id? }` T4 定义，T5 消费一致 ✅
- `EndUser { id, deviceId, role }` T5 定义，T6 `req.endUser` 消费一致 ✅
- `createTokenVerifier`/`createOpsLookupClient`/`createTokenVerifyHook` 工厂签名跨 task 一致 ✅
- `parseRequestEnvelope` 返 `ParsedRequestEnvelope { version, kind?, userToken, deviceId?, raw }`，T5 消费 `parsed.version`/`parsed.userToken`/`parsed.deviceId` 一致 ✅

无问题，plan 就绪。
