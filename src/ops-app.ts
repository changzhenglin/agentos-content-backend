// ops-app.ts — App2 ops-facing fastify（port 3002）。
// /content_policy/push：mTLS（非 CN-only，D1=A 加强版）+ audience + envelope shape + actor 绑定（fold codex P2）。
//
// mTLS 校验逻辑（brief 约束，不变）：
//   TLS 层 rejectUnauthorized:true 隐式校验 chain/validity/EKU clientAuth（OpenSSL purpose 检查）；
//   mtlsVerify 再校验 tls.authorized + cert.subjectaltname 含 expectedSan。
// EKU clientAuth 由 TLS 层 OpenSSL purpose 强制（rejectUnauthorized:true）；app 层不重复校验避免死代码
//   （Node X509Certificate.keyUsage 返回 KeyUsage 扩展位，非 EKU OID 数组，app 层 EKU 检查实为 no-op）。
// 适配 selfsigned 5.x / fastify https：服务端需自身 key/cert（TLS server 身份），tlsOpts 扩展 key/cert 字段（必要支撑②）。
//
// 403 拒绝路径 emit audit unauthorized（emitUnauthorized，复用 tool_call event_type 不扩 enum）。
// error body 统一 {error_code, message}（fold devex I3）。
// actor 绑定 mTLS caller（不信 self-declared，fold codex P2）。
import Fastify, { type FastifyInstance } from "fastify";
import type { ContentDb } from "./content/db.js";
import type { PolicyEnvelope, PolicyStore } from "./policy/policy-store.js";
import { createPolicyStore } from "./policy/policy-store.js";
import type { AuditSink } from "./audit/audit-sink.js";
import { emitConfigApply, emitUnauthorized } from "./audit/audit-events.js";

export interface TlsOpts {
  // 服务端自身 TLS 身份（key/cert）+ 校验 client cert 的 CA
  key: string;
  cert: string;
  ca: string;
  requestCert: boolean;
  rejectUnauthorized: boolean;
}

export interface BuildOpsAppOpts {
  db: ContentDb;
  auditSink: AuditSink;
  tlsOpts?: TlsOpts;
  policyStore?: PolicyStore;
  expectedSan?: string; // 期望 peer cert SAN（D1 非 CN-only）
  adminToken?: string; // T7 用
  operatorToken?: string;
}

function errBody(code: string, message: string) {
  return { error_code: code, message };
}

export async function buildOpsApp(opts: BuildOpsAppOpts) {
  const store = opts.policyStore ?? createPolicyStore(opts.db);
  const expectedSan = opts.expectedSan ?? "localhost";

  // fastify 5 overload 选择需内联 https 字面量（node:https ServerOptions）；
  // tlsOpts 缺省时走 http overload（sim 非 mTLS 场景，如 admin UI 本地开发）。
  // 用单一 options 对象 + FastifyInstance 注解避免 app 成 overload union（.post 不可调用）。
  const fastifyOpts: Record<string, unknown> = {};
  if (opts.tlsOpts) {
    fastifyOpts.https = {
      key: opts.tlsOpts.key,
      cert: opts.tlsOpts.cert,
      ca: opts.tlsOpts.ca,
      requestCert: opts.tlsOpts.requestCert,
      rejectUnauthorized: opts.tlsOpts.rejectUnauthorized, // TLS 层隐式 chain/validity/EKU purpose 校验
    } as import("node:https").ServerOptions;
  }
  const app = Fastify(fastifyOpts as any) as unknown as FastifyInstance;

  // mTLS preHandler（D1=A 加强版：非 CN-only，校验 authorized + SAN）。
  // TLS 层 rejectUnauthorized:true 已校验 chain/validity/EKU clientAuth（OpenSSL purpose）；
  // 此处应用层复校验 authorized + SAN（defense-in-depth）。
  // EKU clientAuth enforced at TLS layer (OpenSSL purpose via rejectUnauthorized);
  // app 层不再重复校验避免死代码（Node X509Certificate.keyUsage 非 EKU OID 数组，app 层 EKU 检查实为 no-op）。
  async function mtlsVerify(req: any, reply: any) {
    const tls = req.raw?.socket;
    if (!tls?.authorized) {
      return reply
        .code(403)
        .send(errBody("MTLS_CERT_REQUIRED", "mTLS client cert required/invalid"));
    }
    const cert = tls.getPeerCertificate?.();
    if (!cert || Object.keys(cert).length === 0) {
      return reply
        .code(403)
        .send(errBody("MTLS_CERT_REQUIRED", "mTLS client cert required"));
    }
    // SAN 校验（非 CN-only）：cert.subjectaltname 形如 "DNS:localhost, IP Address:127.0.0.1"
    const san: string = cert.subjectaltname ?? "";
    if (!san.includes(expectedSan)) {
      // cert 存在 + 有 CN（callerIdentity 可取）→ audit unauthorized（fold T5 review fix #3）
      await emitUnauthorized(opts.auditSink, {
        caller: cert.subject?.CN ?? "unknown",
        reason: "san_mismatch",
        target: "content_policy",
      });
      return reply
        .code(403)
        .send(errBody("MTLS_CERT_REQUIRED", `SAN mismatch (expected ${expectedSan})`));
    }
    (req as any).callerIdentity = cert.subject?.CN ?? "unknown-service";
  }

  app.post("/content_policy/push", { preHandler: mtlsVerify }, async (req, reply) => {
    const env = req.body as PolicyEnvelope;
    const sc = env?.security_context;
    const caller = (req as any).callerIdentity;

    // envelope shape 校验（fold codex P2：不信 self-declared，校验 kind/action/target_scope + security_context 存在）
    const validActions = ["allow", "block", "region_restrict"];
    if (
      env?.kind !== "content_policy" ||
      !validActions.includes(env.payload?.action) ||
      env.payload?.target_scope !== "content_management" ||
      !sc
    ) {
      await emitUnauthorized(opts.auditSink, {
        caller,
        reason: "invalid_envelope",
        target: "content_policy",
      });
      return reply
        .code(400)
        .send(errBody("INVALID_ENVELOPE", "envelope shape invalid (security_context required)"));
    }
    // audience 校验
    if (sc.audience !== "content_backend") {
      await emitUnauthorized(opts.auditSink, {
        caller,
        reason: "audience_mismatch",
        target: "content_policy",
      });
      return reply.code(403).send(errBody("AUDIENCE_MISMATCH", "audience mismatch"));
    }
    // expiry 校验
    if (new Date(sc.expiry).getTime() < Date.now()) {
      await emitUnauthorized(opts.auditSink, {
        caller,
        reason: "envelope_expired",
        target: "content_policy",
      });
      return reply.code(403).send(errBody("ENVELOPE_EXPIRED", "envelope expired"));
    }
    // actor 绑定（fold codex P2：self-declared actor 须与 mTLS caller 一致）
    if (sc.actor !== caller) {
      await emitUnauthorized(opts.auditSink, {
        caller,
        reason: "actor_mismatch",
        target: "content_policy",
      });
      return reply
        .code(403)
        .send(errBody("UNAUTHORIZED_ACTOR", "actor does not match mTLS caller"));
    }
    const r = await store.applyPolicy(env, caller);
    if (r.applied) {
      await emitConfigApply(opts.auditSink, {
        ruleId: env.payload.rule_id,
        version: r.version,
        actor: sc.actor,
      });
    }
    return reply.code(200).send(r);
  });

  return app;
}

// CLI 入口（fold devex C1/I5：App2 可独立启动）：tsx src/ops-app.ts
// sim CA + server cert 自生成；生产由 env 传真实 cert 路径（T8 dev-start 统一编排）。
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("./env.js");
  const selfsigned = (await import("selfsigned")).default;
  const env = loadEnv();
  // sim CA（带 basicConstraints CA:TRUE）
  const ca = await selfsigned.generate([{ name: "commonName", value: "sim-ca" }], {
    algorithm: "sha256",
    extensions: [{ name: "basicConstraints", cA: true, critical: true }],
  });
  // server cert（自身 TLS 身份，SAN localhost）
  const svc = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
        { name: "extKeyUsage", serverAuth: true },
      ],
    },
  );
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: env.dbUrl });
  const db: ContentDb = {
    async query(text: string, params?: unknown[]) {
      return pool.query(text, params as any[]);
    },
  };
  const app = await buildOpsApp({
    db,
    auditSink: (await import("./audit/audit-sink.js")).createAuditSink(
      env.auditSinkPath,
    ),
    tlsOpts: {
      key: svc.private,
      cert: svc.cert,
      ca: ca.cert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    expectedSan: "localhost",
    adminToken: env.adminToken,
    operatorToken: env.operatorToken,
  });
  await app.listen({ port: env.opsPort, host: "0.0.0.0" });
  console.log(`ops-app listening :${env.opsPort} (mTLS sim CA)`);
}
