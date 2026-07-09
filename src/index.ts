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
import { loadEnv, assertProdEnv, type Env } from "./env.js";
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
import { authorizeBackendType } from "./auth/caller-auth-matrix.js";
import { parseDeviceCapability, capabilityFilter } from "./policy/capability-filter.js";
import { fetchThirdParty } from "./content/third-party-adapter.js";
import { selectPath } from "./content/path-select.js";
import { parseTrackId, type Provider } from "./content/track-id.js";
import { createStubSecretStore, type SecretStore } from "./auth/secret-store-stub.js";
import { createTokenVerifier } from "./auth/jwt-verify.js";
import { createOpsLookupClient } from "./auth/ops-lookup.js";
import { createTokenVerifyHook } from "./auth/token-verify-hook.js";

// P1.1 inbound caller 白名单：HTTP inbound 仅接受 cloud-ext external caller。
// content-backend principal 仅用于内部 fetchThirdParty→resolveHandle（不经 HTTP inbound），
// 故 HTTP 伪造 X-Caller-Identity: content-backend / ops-platform / unknown / 缺失
// 一律归一化为 anonymous → 不在 ALLOW_MATRIX → receiveAndAuthorize 拒收 caller_not_allowed。
// 防御 silent bypass：HTTP 伪造 content-backend + ^backend:foo 不再 authorized。
const INBOUND_ALLOWED_CALLERS = ["cloud-ext", "device-hub"] as const;
function normalizeInboundCaller(raw: unknown): string {
  return typeof raw === "string" && (INBOUND_ALLOWED_CALLERS as readonly string[]).includes(raw)
    ? raw
    : "anonymous";
}

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
  /** #2: env overrides（测试注入 mock IAM/ops host；CLI 不传走 process.env）。 */
  env?: Partial<Env>;
}

/**
 * M2d: 从 STUB_SECRETS_PATH fixture JSON 加载 stub secrets（spawn env 传，D9 e2e 用）。
 * JSON 形如 { "^backend:qq-token_v1": { "token": "...", "token_type": "bearer" } }。
 * 加载失败（文件不存在/JSON 解析错）→ 空对象（安全 fail，third_party resolve 会 handle_not_found）。
 */
function loadStubSecrets(path: string): Record<string, { token: string; token_type: "bearer" | "query_param"; expiry?: string; audience?: string }> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.warn(`[index] failed to load stub secrets from ${path}:`, e);
    return {};
  }
}

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
  // #2: env 移入 buildServer（原模块顶层 const env = loadEnv() 迁此），opts.env 优先注入测试 mock。
  // CLI 入口不传 opts，独立 loadEnv 取 port（见文件末尾 CLI 块）。
  const env = loadEnv(opts.env ?? {});
  assertProdEnv(env);

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
  // CLI/spawn 路径：env.stubSecretsPath 非空时 load fixture JSON 构 stub store（D9 e2e 用，
  // P1.3 方案 A——spawn env 传 STUB_SECRETS_PATH，backend 启动 load 构 stub store）。
  // 既有 in-process e2e 未传 secretStore 且 env.stubSecretsPath 空（vitest 不设该 env）→ 默认空 stub，不回归。
  const secretStore: SecretStore =
    opts.secretStore ??
    (env.stubSecretsPath
      ? createStubSecretStore(loadStubSecrets(env.stubSecretsPath))
      : createStubSecretStore({}));
  // M2d: providerBaseUrl 默认从 env（PROVIDER_BASE_URL_<PROVIDER> 解析）；opts 优先（in-process e2e 用）。
  const providerBaseUrl: Record<string, string> = opts.providerBaseUrl ?? env.providerBaseUrl;
  const ctx: DrmCtx = { policyStore, auditSink, actor };

  // #2 T6: wire token-verify preHandler（T5 createTokenVerifyHook + T3 verifier + T4 lookup）。
  // SIM 偏离声明（spec D7 / Fold-10）：preHandler（token-verify，content 层终端用户校验）
  // 在 route handler 内 inline receiveAndAuthorize（transport 层 caller×source 矩阵）之前执行——
  // 与 spec §2 理想 caller-first 相反。sim 阶段接受偏离：capability_mode=mock 下无 mTLS，
  // caller header 可伪造，caller-first 无真实安全意义；真序由 mTLS #6 enforced。
  // 不重构现有 inline receiveAndAuthorize（surgical，②类必要支撑仅挂 preHandler）。
  //
  // 守卫：iamJwksUrl 空时（sim/dev 无 IAM）不构造 verifier——createTokenVerifier 内
  // new URL(jwksUrl) 对空串抛 TypeError。sim 无 IAM 时 token-verify 关闭（v1/匿名请求不受影响，
  // 既有测试不设 iamJwksUrl 故不回归）；prod 由 assertProdEnv 强制 iamJwksUrl 非空。
  // #2 T6 fix-2（Minor）：non-mock capabilityMode 下 iamJwksUrl 空 → silent bypass 加 warn，
  // 提醒生产环境漏配 token-verify；capabilityMode=mock 时不 warn（sim 诚实声明）。
  if (!env.iamJwksUrl && env.capabilityMode !== "mock") {
    console.warn(
      "[index] iamJwksUrl empty → token-verify disabled (non-mock capabilityMode)",
    );
  }
  let tokenVerifyHook: ReturnType<typeof createTokenVerifyHook> | undefined;
  if (env.iamJwksUrl) {
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
    tokenVerifyHook = createTokenVerifyHook({
      verifyToken: tokenVerifier,
      lookupBinding: opsLookupClient,
      auditSink,
      capabilityMode: env.capabilityMode,
    });
  }

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

  app.post("/content_query", { preHandler: tokenVerifyHook }, async (req, reply) => {
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = normalizeInboundCaller(req.headers["x-caller-identity"]);
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
    const btAuthz = authorizeBackendType(caller, backendType);
    if (!btAuthz.authorized) {
      const envelope = wrapEnvelope({}, "content_query", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    // T2 capability-filter（query 只筛 kind）
    const capHeader = req.headers["x-device-capability"] as string | undefined;
    const capability = parseDeviceCapability(capHeader);
    const capDec = await capabilityFilter({ capability, kind: "content_query", policyStore });
    if (capDec.blocked) {
      const envelope = wrapEnvelope({}, "content_query", "self_hosted", "unavailable", "blocked", capDec.errorCode);
      return reply.code(403).send(envelope);
    }
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
  app.post("/content_match", { preHandler: tokenVerifyHook }, async (req, reply) => {
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = normalizeInboundCaller(req.headers["x-caller-identity"]);
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_match", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const body = req.body as any;
    const provider = (body.provider as Provider) || "self";
    const { backendType, providerHandle } = await resolveProviderPath("content_match", provider);
    const btAuthz = authorizeBackendType(caller, backendType);
    if (!btAuthz.authorized) {
      const envelope = wrapEnvelope({}, "content_match", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    // T2 capability-filter（match 只筛 kind）
    const capHeader = req.headers["x-device-capability"] as string | undefined;
    const capability = parseDeviceCapability(capHeader);
    const capDec = await capabilityFilter({ capability, kind: "content_match", policyStore });
    if (capDec.blocked) {
      const envelope = wrapEnvelope({}, "content_match", "self_hosted", "unavailable", "blocked", capDec.errorCode);
      return reply.code(403).send(envelope);
    }
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
  app.post("/content_stream", { preHandler: tokenVerifyHook }, async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = normalizeInboundCaller(req.headers["x-caller-identity"]);
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_stream", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const { provider } = parseTrackId(tid);
    const { backendType, providerHandle } = await resolveProviderPath("content_stream", provider);
    const btAuthz = authorizeBackendType(caller, backendType);
    if (!btAuthz.authorized) {
      const envelope = wrapEnvelope({}, "content_stream", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    // T2 A1: stream 先查 tracks format/bitrate 再 capability-filter（使 format/bitrate 降级生效）
    const capHeader = req.headers["x-device-capability"] as string | undefined;
    const capability = parseDeviceCapability(capHeader);
    const { rows: trackRows } = await db.query(
      "SELECT format, bitrate FROM tracks WHERE track_id = $1 LIMIT 1",
      [tid],
    );
    const trackFormat = trackRows[0]?.format ? String(trackRows[0].format) : undefined;
    const trackBitrate = trackRows[0]?.bitrate ? Number(trackRows[0].bitrate) : undefined;
    const capDec = await capabilityFilter({ capability, kind: "content_stream", trackFormat, trackBitrate, policyStore });
    if (capDec.blocked) {
      const envelope = wrapEnvelope({}, "content_stream", "self_hosted", "unavailable", "blocked", capDec.errorCode);
      return reply.code(403).send(envelope);
    }
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
    // T2 P2#4: degraded 覆盖 envelope（capability-filter 算出 degraded，streamBusiness 不感知）
    // review fold I1: 仅成功路径（DONE）才标降级，避免掩盖 drm block / no_result / unavailable
    if (capDec.degraded && !capDec.blocked && (envelope as any).completion_state === "DONE") {
      (envelope as any).capability_mode = "degraded";
      (envelope as any).completion_state = "DONE_WITH_CONCERNS";
    }
    reply.code(status).send(envelope);
  });
  app.post("/content_lyrics", { preHandler: tokenVerifyHook }, async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = normalizeInboundCaller(req.headers["x-caller-identity"]);
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_lyrics", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const { provider } = parseTrackId(tid);
    const { backendType, providerHandle } = await resolveProviderPath("content_lyrics", provider);
    const btAuthz = authorizeBackendType(caller, backendType);
    if (!btAuthz.authorized) {
      const envelope = wrapEnvelope({}, "content_lyrics", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    // T2 capability-filter（lyrics 只筛 kind）
    const capHeader = req.headers["x-device-capability"] as string | undefined;
    const capability = parseDeviceCapability(capHeader);
    const capDec = await capabilityFilter({ capability, kind: "content_lyrics", policyStore });
    if (capDec.blocked) {
      const envelope = wrapEnvelope({}, "content_lyrics", "self_hosted", "unavailable", "blocked", capDec.errorCode);
      return reply.code(403).send(envelope);
    }
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
  app.post("/content_metadata", { preHandler: tokenVerifyHook }, async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const secretHandle = (req.headers["x-secret-handle"] as string) || undefined;
    const caller = normalizeInboundCaller(req.headers["x-caller-identity"]);
    const traceId = (req.headers["x-trace-id"] as string) || undefined;
    const authz = await receiveAndAuthorize({ handle: secretHandle, caller, auditSink, traceId });
    if (!authz.authorized) {
      const envelope = wrapEnvelope({}, "content_metadata", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    const { provider } = parseTrackId(tid);
    const { backendType, providerHandle } = await resolveProviderPath("content_metadata", provider);
    const btAuthz = authorizeBackendType(caller, backendType);
    if (!btAuthz.authorized) {
      const envelope = wrapEnvelope({}, "content_metadata", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
    // T2 capability-filter（metadata 只筛 kind）
    const capHeader = req.headers["x-device-capability"] as string | undefined;
    const capability = parseDeviceCapability(capHeader);
    const capDec = await capabilityFilter({ capability, kind: "content_metadata", policyStore });
    if (capDec.blocked) {
      const envelope = wrapEnvelope({}, "content_metadata", "self_hosted", "unavailable", "blocked", capDec.errorCode);
      return reply.code(403).send(envelope);
    }
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
  // #2 T6 fix-1（Important）：原 `statusCode < 400` 跳过范围过宽——既有错误码
  // （AUTH_FAILED/COPYRIGHT_RESTRICTED/BACKEND_UNAVAILABLE 等本在 schema enum）的服务端
  // 契约校验被一并弱化。收窄为：仅 5 新 ErrorCode
  // （INVALID_TOKEN/DEVICE_NOT_BOUND/JWKS_UNAVAILABLE/LOOKUP_UNAVAILABLE/INVALID_ENVELOPE，
  // 不在 schema enum，需架构 delta 方可扩，本 task 不触）的 ≥400 响应跳过，
  // 避失败响应被 AJV 转 500；其余（含既有错误码 + 2xx）仍强校验契约。
  const NEW_TOKEN_VERIFY_CODES = new Set([
    "INVALID_TOKEN",
    "DEVICE_NOT_BOUND",
    "JWKS_UNAVAILABLE",
    "LOOKUP_UNAVAILABLE",
    "INVALID_ENVELOPE",
  ]);
  app.addHook("onSend", async (_req, _reply, payload) => {
    if (typeof payload !== "string") {
      return payload;
    }
    let skip = false;
    if (_reply.statusCode >= 400) {
      try {
        const body = JSON.parse(payload);
        if (
          typeof body?.error_code === "string" &&
          NEW_TOKEN_VERIFY_CODES.has(body.error_code)
        ) {
          skip = true; // 5 新码不在 schema enum，跳过避 500
        }
      } catch {
        // 非 JSON payload，不跳过，走正常 validate
      }
    }
    if (!skip) {
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
// M2d: listen 端口从 env.port 读（PORT env，default 3001；D9 e2e spawn 传动态端口避免冲突）。
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  // CLI 不接 opts，独立 loadEnv 取 port（buildServer 内 env 是局部的）。
  const cliEnv = loadEnv();
  const app = await buildServer();
  app.listen({ port: cliEnv.port, host: "0.0.0.0" });
}
