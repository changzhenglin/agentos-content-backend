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
import cookiePlugin from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { resolve } from "node:path";
import type { ContentDb, TransactionalContentDb } from "./content/db.js";
import { wrapPgPool } from "./db/transaction.js";
import type { PolicyEnvelope, PolicyStore } from "./policy/policy-store.js";
import { createPolicyStore } from "./policy/policy-store.js";
import type { AuditSink } from "./audit/audit-sink.js";
import { emitConfigApply, emitUnauthorized } from "./audit/audit-events.js";
import { createSession, requireRole } from "./auth/session.js";
import {
  validateRawMetadata,
  ingestCreate,
  ingestTransitionAndAudit,
} from "./admin/ingest.js";
import { presignUrl } from "./storage/presign.js";
import { createS3 } from "./storage/s3-client.js";
import {
  renderLogin,
  renderTracksList,
  renderIngestForm,
  renderAudio,
  renderQueuePage,
  renderDetailPage,
  renderDetailMain,
  renderTransitionError,
} from "./admin/views.js";

export interface TlsOpts {
  // 服务端自身 TLS 身份（key/cert）+ 校验 client cert 的 CA
  key: string;
  cert: string;
  ca: string;
  requestCert: boolean;
  rejectUnauthorized: boolean;
}

export interface BuildOpsAppOpts {
  db: TransactionalContentDb;
  auditSink?: AuditSink; // I2 fix: 可选——CLI 默认 env.auditSinkPath 空串不 wire sink
  tlsOpts?: TlsOpts;
  policyStore?: PolicyStore;
  expectedSan?: string; // 期望 peer cert SAN（D1 非 CN-only）
  adminToken?: string; // T7 用
  operatorToken?: string;
  presignFn?: (key: string) => Promise<{ url: string }>; // 试听 presign（CLI 默认 env.s3 构造；未配置则试听区显示提示，不阻塞审核）
}

function errBody(code: string, message: string) {
  return { error_code: code, message };
}

async function loadDetail(db: ContentDb, ingestId: string) {
  const { rows } = await db.query(
    "SELECT id, track_id, state, raw_metadata, created_at FROM ingest WHERE id=$1",
    [ingestId],
  );
  if (!rows[0]) return null;
  const hist = await db.query(
    "SELECT actor, action, reason, at FROM review WHERE ingest_id=$1 ORDER BY at",
    [ingestId],
  );
  return {
    ingest: {
      id: String(rows[0].id),
      track_id: String(rows[0].track_id),
      state: String(rows[0].state),
      meta: JSON.parse(String(rows[0].raw_metadata)) as Record<string, unknown>,
    },
    history: hist.rows.map((h: any) => ({
      actor: String(h.actor),
      action: String(h.action),
      reason: h.reason == null ? null : String(h.reason),
      at: String(h.at ?? ""),
    })),
  };
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
    // M2d codex P2.1 fix：auth_config.token_ref pattern ingress 校验（reject malformed at ingress，不 persist 坏值）。
    // 对齐 AgentOS ops-config.schema.json $defs.auth_config allOf：token_source=ops_managed → ^\^ops:[a-zA-Z0-9_-]+$；
    // token_source=backend_issued → ^\^backend:[a-zA-Z0-9_-]+$。schema 在 AgentOS 仓（不引入 ajv 依赖复用），
    // inline pattern 校验 + 注释对齐 schema（schema 是 single source of truth，schema 改时此 pattern 同步）。
    const ac = env.payload?.auth_config;
    if (ac) {
      const validSources = ["ops_managed", "backend_issued"];
      const refPat =
        ac.token_source === "ops_managed"
          ? /^\^ops:[a-zA-Z0-9_-]+$/
          : ac.token_source === "backend_issued"
            ? /^\^backend:[a-zA-Z0-9_-]+$/
            : null;
      if (
        !validSources.includes(ac.token_source) ||
        refPat === null ||
        typeof ac.token_ref !== "string" ||
        !refPat.test(ac.token_ref)
      ) {
        await emitUnauthorized(opts.auditSink, {
          caller,
          reason: "invalid_envelope",
          target: "content_policy",
        });
        return reply
          .code(400)
          .send(errBody("INVALID_ENVELOPE", "auth_config.token_ref pattern invalid"));
      }
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
    // expiry 校验（fold codex P1#2：Number.isFinite 防 NaN 通过——new Date(invalid).getTime()=NaN，NaN < Date.now()=false 会放行无效 expiry）
    const expiryMs = new Date(sc.expiry).getTime();
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
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

  // ---- T7 admin UI routes（/admin/*，htmx SSR + session，fold design C1/C3）----
  // 仅当 adminToken 配置时挂载（sim 本地开发/生产；无 token 则 admin UI 不启用）
  if (opts.adminToken) {
    app.register(cookiePlugin);
    app.register(staticPlugin, {
      root: resolve(process.cwd(), "public"),
      prefix: "/public/",
    });

    // htmx form 提交 content-type: application/x-www-form-urlencoded；
    // Fastify 默认不注册该 content-type parser → 415（route handler 不执行）。
    // 手写 parser（避免引入 @fastify/formbody 依赖），解析为 key/value 对象，
    // 值均为 string（handler 内对 raw_metadata 再 JSON.parse 规范化，见下）。
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        const out: Record<string, string> = {};
        for (const pair of String(body).split("&")) {
          if (!pair) continue;
          const eq = pair.indexOf("=");
          const k = decodeURIComponent(
            (eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " "),
          );
          // 无 = 的参数值保持空串（原行为；fold wave 2 codex P2：
          // 上一版误把值取为参数名本身）
          const v = decodeURIComponent(
            (eq < 0 ? "" : pair.slice(eq + 1)).replace(/\+/g, " "),
          );
          out[k] = v;
        }
        done(null, out);
      },
    );

    // GET routes（fold design C3: login/ingests queue/ingest-detail/tracks）
    app.get("/admin/login", async (_req, reply) =>
      reply.type("text/html").send(renderLogin()),
    );
    app.get(
      "/admin/ingests",
      { preHandler: requireRole("operator") },
      async (_req, reply) => {
        const { rows } = await opts.db.query(
          "SELECT id, track_id, state, raw_metadata, created_at FROM ingest WHERE state='pending' ORDER BY created_at LIMIT 100",
        );
        const items = rows.map((r: any) => {
          let title = "";
          let artist = "";
          try {
            const meta = JSON.parse(String(r.raw_metadata ?? "{}"));
            title = meta.title != null ? String(meta.title) : "";
            artist = meta.artist != null ? String(meta.artist) : "";
          } catch {
            // raw_metadata 异常不阻塞队列渲染
          }
          return {
            id: String(r.id),
            track_id: String(r.track_id),
            state: String(r.state),
            title,
            artist,
            created_at: String(r.created_at ?? ""),
          };
        });
        return reply.type("text/html").send(renderQueuePage(items));
      },
    );
    app.get(
      "/admin/ingest/:id",
      { preHandler: requireRole("operator") },
      async (req, reply) => {
        const detail = await loadDetail(opts.db, (req.params as any).id);
        if (!detail) {
          return reply
            .code(404)
            .send({ error_code: "NOT_FOUND", message: "ingest not found" });
        }
        return reply.type("text/html").send(renderDetailPage(detail));
      },
    );
    app.get(
      "/admin/tracks",
      { preHandler: requireRole("operator") },
      async (_req, reply) => {
        const { rows } = await opts.db.query(
          "SELECT track_id, title, artist FROM tracks",
        );
        return reply.type("text/html").send(renderTracksList(rows));
      },
    );
    // 试听懒加载：presign 有过期时间，现取现用（spec §3.2）
    app.get(
      "/admin/ingest/:id/audio",
      { preHandler: requireRole("operator") },
      async (req, reply) => {
        const { rows } = await opts.db.query(
          "SELECT audio_object_key FROM ingest WHERE id=$1",
          [(req.params as any).id],
        );
        if (!rows[0]) {
          return reply
            .code(404)
            .send(errBody("NOT_FOUND", "ingest not found"));
        }
        const key =
          rows[0].audio_object_key == null
            ? null
            : String(rows[0].audio_object_key);
        if (!key) {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "无音频，仅元数据审核" }));
        }
        if (!opts.presignFn) {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "试听未配置" }));
        }
        try {
          const { url } = await opts.presignFn(key);
          return reply.type("text/html").send(renderAudio({ url }));
        } catch {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "试听获取失败，可继续审核" }));
        }
      },
    );

    // POST routes
    app.post("/admin/login", async (req, reply) => {
      const { token } = req.body as any;
      let role: "admin" | "operator" | null = null;
      if (token === opts.adminToken) role = "admin";
      else if (token === opts.operatorToken) role = "operator";
      if (!role) {
        return reply
          .code(401)
          .send({ error_code: "INVALID_TOKEN", message: "invalid token" });
      }
      const sid = createSession({ role, name: role });
      // secure: App2 mTLS https（fold design M2）；httpOnly 防 XSS 取 cookie
      reply.setCookie("sid", sid, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
      });
      return reply.type("text/html").send(renderLogin()); // htmx 可替换
    });

    // ingest 入库：admin only。成功返 JSON {id,state,trackId}（e2e 链式取 id）；
    // 400 返 HTML form partial 含错误（htmx 回填，fold design I3）。
    app.post(
      "/admin/ingest",
      { preHandler: requireRole("admin") },
      async (req, reply) => {
        let { track_id, raw_metadata, audioObjectKey } = req.body as any;
        // htmx form form-urlencoded 提交时 raw_metadata 是 JSON 字符串（Fastify 解析后）；
        // 真实浏览器路径需在此规范化为 object 再校验，否则 validateRawMetadata
        // 检 typeof !== "object" 恒 400（e2e 用 inject 传 object 绕过未触发）。
        if (typeof raw_metadata === "string") {
          try {
            raw_metadata = JSON.parse(raw_metadata);
          } catch {
            return reply
              .code(400)
              .type("text/html")
              .send(renderIngestForm(["raw_metadata invalid JSON"]));
          }
        }
        const errs = validateRawMetadata(raw_metadata);
        if (errs.length) {
          return reply
            .code(400)
            .type("text/html")
            .send(renderIngestForm(errs));
        }
        const r = await ingestCreate(
          opts.db,
          track_id,
          raw_metadata,
          audioObjectKey ?? null,
        );
        return reply.send({ id: r.id, state: r.state, trackId: r.trackId });
      },
    );

    // approve/reject/revoke：operator 门放宽（spec D5：admin+operator 可审）；
    // reason 可选（≤1000 字符）；NOT_FOUND→404 JSON（M2b fix #2 先例保持）；
    // 成功→detail-main partial（swap 锚点 #detail-main，原地刷新不嵌套整页，
    // fold T2 follow-up ③）；INVALID_TRANSITION→409 / REASON_TOO_LONG→400 返 HTML partial
    //（htmx 2.0.4 默认 4xx 不 swap，页面 head responseHandling 配置 T5 加；
    // fold codex P1-2）。
    const transitionRoute = (action: "approve" | "reject" | "revoke") =>
      app.post(
        `/admin/ingest/:id/${action}`,
        { preHandler: requireRole("operator") },
        async (req, reply) => {
          const ingestId = (req.params as any).id;
          const reasonRaw = (req.body as any)?.reason;
          const reason =
            typeof reasonRaw === "string" && reasonRaw.length > 0
              ? reasonRaw
              : undefined;
          if (reason && reason.length > 1000) {
            return reply
              .code(400)
              .type("text/html")
              .send(
                renderTransitionError({
                  message: "reason exceeds 1000 chars",
                  reason, // 回填
                  retryAction: `/admin/ingest/${ingestId}/${action}`,
                  backHref: `/admin/ingest/${ingestId}`,
                }),
              );
          }
          let trackId: string | null;
          try {
            ({ trackId } = await ingestTransitionAndAudit(
              opts.db,
              opts.auditSink,
              ingestId,
              action,
              (req as any).user.name,
              reason,
            ));
          } catch (e: any) {
            if (e?.message === "NOT_FOUND") {
              return reply
                .code(404)
                .send(errBody("NOT_FOUND", "ingest not found"));
            }
            if (e?.message === "INVALID_TRANSITION") {
              // 409：带当前状态（spec §4；fold Eng NEW-3），不提供重试（状态已变）
              const cur = await opts.db.query(
                "SELECT state FROM ingest WHERE id=$1",
                [ingestId],
              );
              const curState = cur.rows[0] ? String(cur.rows[0].state) : "unknown";
              return reply
                .code(409)
                .type("text/html")
                .send(
                  renderTransitionError({
                    message: `非法操作：当前状态为 ${curState}，不允许 ${action}`,
                    backHref: `/admin/ingest/${ingestId}`,
                  }),
                );
            }
            throw e;
          }
          const detail = await loadDetail(opts.db, ingestId);
          if (!detail) {
            return reply
              .code(404)
              .send(errBody("NOT_FOUND", "ingest not found"));
          }
          // 成功响应 = #detail-main 内部内容 partial（非整页）：
          // 详情页按钮/表单 hx-target="#detail-main"，innerHTML swap 原地刷新
          return reply.type("text/html").send(renderDetailMain(detail));
        },
      );
    transitionRoute("approve");
    transitionRoute("reject");
    transitionRoute("revoke");
  }

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
  // 事务化 port（spec §4.5）：显式适配器包裹 pg Pool（params as any[] 对齐仓内既有姿势）
  const db = wrapPgPool({
    query: (text, params) => pool.query(text, params as any[]),
    connect: async () => {
      const c = await pool.connect();
      return {
        query: (text: string, params?: unknown[]) => c.query(text, params as any[]),
        release: () => c.release(),
      };
    },
  });
  const s3 = createS3(
    env.s3.endpoint,
    env.s3.region,
    env.s3.accessKeyId,
    env.s3.secretAccessKey,
  );
  const app = await buildOpsApp({
    db,
    auditSink: env.auditSinkPath
      ? (await import("./audit/audit-sink.js")).createAuditSink(env.auditSinkPath)
      : undefined,
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
    presignFn: (key: string) =>
      presignUrl(s3, env.s3.bucket, key).then((r) => ({ url: r.url })),
  });
  await app.listen({ port: env.opsPort, host: "0.0.0.0" });
  console.log(`ops-app listening :${env.opsPort} (mTLS sim CA)`);
}
