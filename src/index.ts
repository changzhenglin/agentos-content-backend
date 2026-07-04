// index.ts — T7：fastify HTTP server + 5 kind routes + ajv onSend validate。
//
// 路由层：调 T5 业务 handler（返回 {outcome, backendType, capabilityMode, business, errorCode?}）
// → wrapEnvelope 注入 envelope 元数据 → reply.code(httpStatus).send(envelope)。
// ajv onSend hook 对每个响应 payload 跑 content-contract schema validate，
// fail 则 throw（解 plan-eng I3：响应契约强校验，非注释/TODO）。
//
// 对 brief 的三处必要偏离（②类必要支撑 + 接口适配）：
//  1. streamBusiness 实际签名是 (db, presign: PresignFn, trackId)（stream.ts），
//     非 brief 写的 (db, s3, bucket, trackId)。buildServer 把 presignUrl(s3,bucket,key)
//     包成 PresignFn 注入（hexagonal，brief "PresignFn：T7 注入" 已暗示）。
//  2. handler 已返回 capabilityMode + errorCode（T5 解 M2 透传），路由层直接透传，
//     不用 outcome 推算 capMode（brief handle() 的推算有 bug，会覆盖 selectPath 决策）。
//  3. ContentDb port 要 {query(text, params)}（db.ts），drizzle instance 不直接暴露该签名
//     （db.ts 注释：生产由 T7 注入 pg Pool）。故 db 默认用 pg Pool 包成 ContentDb，
//     不直接用 createDb 返回的 drizzle instance（业务函数不依赖 drizzle query builder）。

import Fastify from "fastify";
import Ajv from "ajv";
import { Pool } from "pg";
import { createS3 } from "./storage/s3-client.js";
import { loadEnv } from "./env.js";
import { wrapEnvelope } from "./envelope.js";
import { httpStatus } from "./routes/http-mapping.js";
import { queryBusiness } from "./routes/query.js";
import { matchBusiness } from "./routes/match.js";
import { streamBusiness, type PresignFn } from "./routes/stream.js";
import { lyricsBusiness } from "./routes/lyrics.js";
import { metadataBusiness } from "./routes/metadata.js";
import { presignUrl } from "./storage/presign.js";
import { readFileSync } from "node:fs";
import type { ContentDb } from "./content/db.js";
import type { Kind, BackendType, CapabilityMode, Outcome, ErrorCode } from "./envelope.js";
import type { PolicyStore } from "./policy/policy-store.js";
import { createPolicyStore } from "./policy/policy-store.js";
import type { AuditSink } from "./audit/audit-sink.js";
import { createAuditSink } from "./audit/audit-sink.js";
import type { DrmCtx } from "./policy/drm-ctx.js";
import { drmGuard } from "./policy/drm-guard.js";
import { getRegion } from "./policy/region-config.js";
import { receiveAndAuthorize } from "./auth/secret-handle-hook.js";
import { fetchThirdParty } from "./content/third-party-adapter.js";
import { selectPath } from "./content/path-select.js";
import { parseTrackId, type Provider } from "./content/track-id.js";
import { createStubSecretStore, type SecretStore } from "./auth/secret-store-stub.js";

// ajv compile content-contract schema + 预加载外部 $ref（track / runtime-mode）。
// $ref 指向 https://agentos.dev/schemas/*.schema.json，按 $id 注册（解 I3：完整实现非注释）。
const contentSchema = JSON.parse(
  readFileSync("schemas/content-contract.schema.json", "utf8"),
);
const trackSchema = JSON.parse(
  readFileSync("schemas/track.schema.json", "utf8"),
);
const runtimeModeSchema = JSON.parse(
  readFileSync("schemas/runtime-mode.schema.json", "utf8"),
);
const ajv = new Ajv({ allErrors: true, validateSchema: false });
ajv.addSchema(trackSchema);
ajv.addSchema(runtimeModeSchema);
const validate = ajv.compile(contentSchema);

export interface BuildServerOpts {
  /** ContentDb port（{query(text, params)}）。默认 pg Pool(env.dbUrl)。 */
  db?: ContentDb;
  /** S3Client，供默认 presign 使用。 */
  s3?: any;
  /** S3 bucket，供默认 presign 使用。 */
  bucket?: string;
  /** PresignFn 注入（hexagonal）。默认 (key) => presignUrl(s3, bucket, key)。 */
  presign?: PresignFn;
  /** PolicyStore 注入。默认 createPolicyStore(db)——drm fail-closed 独立于 audit（fold codex P1#6）。 */
  policyStore?: PolicyStore;
  /** AuditSink 注入（可选）。无 audit 时 drm 仍生效，仅无 audit emit。 */
  auditSink?: AuditSink;
  /** 调用方 actor 标识，用于 audit。默认 "anonymous-service"。 */
  actor?: string;
  /** M2d: secret store（third_party resolve；默认 stub 空 map，真 store defer M3-pre SDD）。 */
  secretStore?: SecretStore;
  /** M2d: mock provider endpoint map（provider→base url；真 provider 授权后换真 endpoint）。 */
  providerBaseUrl?: Record<string, string>;
}

const env = loadEnv();

interface HandlerResult {
  outcome: Outcome;
  backendType: BackendType;
  capabilityMode: CapabilityMode;
  errorCode?: ErrorCode;
  business: object;
}

/**
 * buildServer：构造 fastify app + 5 kind routes + ajv onSend validate。
 * 不 listen（inject 不需 listen）；listen 由 CLI 入口调。
 */
export async function buildServer(opts: BuildServerOpts = {}): Promise<ReturnType<typeof Fastify>> {
  const db: ContentDb =
    opts.db ??
    (() => {
      // 生产：pg Pool 包成 ContentDb（db.ts 注释：T7 注入 pg Pool）。
      const pool = new Pool({ connectionString: env.dbUrl });
      return {
        async query(text: string, params?: unknown[]) {
          return pool.query(text, params as any[]);
        },
      };
    })();
  const s3 = opts.s3 ?? createS3(env.s3.endpoint, env.s3.region, env.s3.accessKeyId, env.s3.secretAccessKey);
  const bucket = opts.bucket ?? env.s3.bucket;
  const presign: PresignFn =
    opts.presign ?? ((key: string) => presignUrl(s3, bucket, key));

  // fold codex P1#6：policyStore 默认始终注入（不依赖 auditSink）——drm fail-closed 独立于 audit。
  // 既有 e2e 未传 policyStore 时用默认 store（空集 policy→allow），行为不回归；
  // drm 默认生效（空集 allow），生产路径注入 auditSink 即有 audit emit。
  const policyStore: PolicyStore = opts.policyStore ?? createPolicyStore(db);
  // CLI 路径默认从 env.auditSinkPath wire createAuditSink（opts.auditSink 优先注入测试用），
  // 否则 X-Secret-Handle audit hook 在 CLI 模式 no-op（Task 1 遗漏 wiring，e2e surfacing 补）。
  const auditSink: AuditSink | undefined =
    opts.auditSink ?? (env.auditSinkPath ? createAuditSink(env.auditSinkPath) : undefined);
  const actor = opts.actor ?? "anonymous-service";
  // M2d: secretStore 默认空 stub（third_party resolve 在无 secret 时返 handle_not_found→AUTH_FAILED，
  // 生产注入真 store；真 store runtime defer M3-pre SDD）。
  const secretStore: SecretStore = opts.secretStore ?? createStubSecretStore({});
  const providerBaseUrl: Record<string, string> = opts.providerBaseUrl ?? {};
  const ctx: DrmCtx = { policyStore, auditSink, actor };

  const app = Fastify();

  // 路由层统一 handle：调 drmGuard 前置 → blocked 直接返 BLOCKED envelope 不调 business fn
  // （fold codex P2：中央 guard，5 business functions 不内联 drm 块）→
  // 调 handler → wrapEnvelope（透传 capabilityMode + errorCode）→ httpStatus。
  // trackId：stream/lyrics/metadata 传真实 track_id；query/match 无 track_id 字段，
  // 传占位 ""（T2 checkDrm 是 sim 全 kind 全 track 命中，block policy 仍命中；空集 allow）。
  // requestRegion：从请求头 X-Region 提取（默认 getRegion()=backendRegion）——
  // 解 T8-blocker：ctx.requestRegion 从未注入→requestRegion==backendRegion→
  // region_restrict 永不命中。改由 route handler 提取 X-Region 传 handle→drmGuard，
  // T8 sim 闭环可发 X-Region: us（backend=cn）触发 region_restrict block。
  async function handle(
    kind: Kind,
    fn: () => Promise<HandlerResult>,
    trackId: string,
    requestRegion: string,
  ): Promise<{ envelope: object; status: number }> {
    const guard = await drmGuard(ctx, kind, trackId, requestRegion);
    if (guard.blocked) {
      const envelope = wrapEnvelope(
        {},
        kind,
        "self_hosted",
        "unavailable",
        "blocked",
        guard.errorCode,
      );
      return {
        envelope,
        status: httpStatus(envelope.completion_state, envelope.error_code),
      };
    }
    const r = await fn();
    const envelope = wrapEnvelope(
      r.business,
      kind,
      r.backendType,
      r.capabilityMode,
      r.outcome,
      r.errorCode,
    );
    return { envelope, status: httpStatus(envelope.completion_state, envelope.error_code) };
  }

  /**
   * M2d: fetchThirdParty 返 ThirdPartyResult（outcome="done"|"blocked"），
   * handle() 期望 HandlerResult（Outcome="ok"|"no_result"|"blocked"|"unavailable"）。
   * 映射："done"→"ok"；"blocked"→"blocked"；其余字段直传。
   */
  function toHandlerResult(r: {
    outcome: "done" | "blocked";
    backendType: "third_party_api";
    capabilityMode: "real" | "unavailable";
    errorCode?: string;
    business: Record<string, unknown>;
  }): HandlerResult {
    return {
      outcome: r.outcome === "done" ? "ok" : r.outcome,
      backendType: r.backendType,
      capabilityMode: r.capabilityMode,
      errorCode: r.errorCode as ErrorCode | undefined,
      business: r.business,
    };
  }

  /**
   * M2d: provider 路径解析（fold eng F4 参数源明确）。
   * - provider：query/match 从 body.provider（默认 self）；stream/lyrics/metadata 从 track_id 解析
   * - authorized：latestPolicy 中存在 rule_id===provider 且 action==="allow" 的 rule（option A：rule_id=provider 约定）
   * - providerAvailable：process.env.PROVIDER_AVAILABLE !== "false"（sim 默认 true，真 health check defer 授权后）
   * - providerHandle：从 authorized rule 的 envelope.payload.auth_config?.token_ref 取（单段 ^backend:...）
   * 返回 selectPath 决策 + providerHandle（third_party 分支用）。
   */
  async function resolveProviderPath(
    kind: Kind,
    provider: Provider,
  ): Promise<{
    backendType: BackendType;
    providerHandle: string;
  }> {
    // self provider 无需查 content_policy（selectPath 对 self 忽略 authorized/providerAvailable，
    // 固定返 self_hosted/real）——短路避免 broken policyStore 致 500（drmGuard 内部 fail-closed 503）
    if (provider === "self") {
      return { backendType: "self_hosted", providerHandle: "" };
    }
    const latest = await policyStore.latestPolicy();
    const allowRule = latest.find(
      (p) => p.action === "allow" && p.ruleId === provider,
    );
    const authorized = !!allowRule;
    const providerAvailable = process.env.PROVIDER_AVAILABLE !== "false";
    const providerHandle =
      (allowRule?.envelope.payload.auth_config?.token_ref as string | undefined) ??
      "";
    const capKind = kind.replace("content_", "") as
      | "query"
      | "match"
      | "stream"
      | "lyrics"
      | "metadata";
    const path = selectPath(provider, authorized, capKind, providerAvailable);
    return { backendType: path.backendType, providerHandle };
  }

  app.post("/content_query", async (req, reply) => {
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = (req.headers["x-caller-identity"] as string) || "anonymous";
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    // M2d: receiveAndAuthorize 替换 emitSecretHandleAudit（caller×source 矩阵校验）
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_query", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const body = req.body as any;
    const provider = (body.provider as Provider) || "self";
    const { backendType, providerHandle } = await resolveProviderPath("content_query", provider);
    const { envelope, status } = await handle(
      "content_query",
      () => backendType === "third_party_api"
        ? fetchThirdParty({
            kind: "content_query",
            request: body.query ?? {},
            providerHandle,
            provider,
            store: secretStore,
            caller: "content-backend",
            providerBaseUrl: providerBaseUrl[provider] ?? "",
          }).then(toHandlerResult)
        : queryBusiness(db, body.query, ctx),
      "", // query 无 track_id，占位 ""（block policy 全 kind 全 track 命中；空集 allow）
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_match", async (req, reply) => {
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = (req.headers["x-caller-identity"] as string) || "anonymous";
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_match", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const body = req.body as any;
    const provider = (body.provider as Provider) || "self";
    const { backendType, providerHandle } = await resolveProviderPath("content_match", provider);
    const { envelope, status } = await handle(
      "content_match",
      () => backendType === "third_party_api"
        ? fetchThirdParty({
            kind: "content_match",
            request: body.match ?? {},
            providerHandle,
            provider,
            store: secretStore,
            caller: "content-backend",
            providerBaseUrl: providerBaseUrl[provider] ?? "",
          }).then(toHandlerResult)
        : matchBusiness(db, body.match, ctx),
      "", // match 无 track_id，占位 ""
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_stream", async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = (req.headers["x-caller-identity"] as string) || "anonymous";
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_stream", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const { provider } = parseTrackId(tid);
    const { backendType, providerHandle } = await resolveProviderPath("content_stream", provider);
    const { envelope, status } = await handle(
      "content_stream",
      () => backendType === "third_party_api"
        ? fetchThirdParty({
            kind: "content_stream",
            request: { track_id: tid },
            providerHandle,
            provider,
            store: secretStore,
            caller: "content-backend",
            providerBaseUrl: providerBaseUrl[provider] ?? "",
          }).then(toHandlerResult)
        : streamBusiness(db, presign, tid, ctx),
      tid,
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_lyrics", async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = (req.headers["x-caller-identity"] as string) || "anonymous";
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_lyrics", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const { provider } = parseTrackId(tid);
    const { backendType, providerHandle } = await resolveProviderPath("content_lyrics", provider);
    const { envelope, status } = await handle(
      "content_lyrics",
      () => backendType === "third_party_api"
        ? fetchThirdParty({
            kind: "content_lyrics",
            request: { track_id: tid },
            providerHandle,
            provider,
            store: secretStore,
            caller: "content-backend",
            providerBaseUrl: providerBaseUrl[provider] ?? "",
          }).then(toHandlerResult)
        : lyricsBusiness(db, tid, ctx),
      tid,
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_metadata", async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = (req.headers["x-caller-identity"] as string) || "anonymous";
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_metadata", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const { provider } = parseTrackId(tid);
    const { backendType, providerHandle } = await resolveProviderPath("content_metadata", provider);
    const { envelope, status } = await handle(
      "content_metadata",
      () => backendType === "third_party_api"
        ? fetchThirdParty({
            kind: "content_metadata",
            request: { track_id: tid },
            providerHandle,
            provider,
            store: secretStore,
            caller: "content-backend",
            providerBaseUrl: providerBaseUrl[provider] ?? "",
          }).then(toHandlerResult)
        : metadataBusiness(db, tid, ctx),
      tid,
      requestRegion,
    );
    reply.code(status).send(envelope);
  });

  // ajv onSend validate（解 plan-eng I3，完整实现非注释）：
  // 对每个 string payload（JSON 序列化后）跑 content-contract schema validate，
  // fail 则 throw → fastify 转 500（响应契约违规不应返回给客户端）。
  app.addHook("onSend", async (_req, _reply, payload) => {
    if (typeof payload === "string") {
      const body = JSON.parse(payload);
      if (!validate(body)) {
        throw new Error(
          `content-contract validate fail: ${JSON.stringify(validate.errors)}`,
        );
      }
    }
    return payload;
  });

  return app;
}

// CLI 入口：node --import tsx src/index.ts 或 tsx src/index.ts。
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app = await buildServer();
  app.listen({ port: 3001 });
}
