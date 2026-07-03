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
import type { DrmCtx } from "./policy/drm-ctx.js";
import { drmGuard } from "./policy/drm-guard.js";
import { getRegion } from "./policy/region-config.js";

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
  const auditSink: AuditSink | undefined = opts.auditSink;
  const actor = opts.actor ?? "anonymous-service";
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

  app.post("/content_query", async (req, reply) => {
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const { envelope, status } = await handle(
      "content_query",
      () => queryBusiness(db, (req.body as any).query, ctx),
      "", // query 无 track_id，占位 ""（block policy 全 kind 全 track 命中；空集 allow）
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_match", async (req, reply) => {
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const { envelope, status } = await handle(
      "content_match",
      () => matchBusiness(db, (req.body as any).match, ctx),
      "", // match 无 track_id，占位 ""
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_stream", async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const { envelope, status } = await handle(
      "content_stream",
      () => streamBusiness(db, presign, tid, ctx),
      tid,
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_lyrics", async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const { envelope, status } = await handle(
      "content_lyrics",
      () => lyricsBusiness(db, tid, ctx),
      tid,
      requestRegion,
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_metadata", async (req, reply) => {
    const tid = (req.body as any).track_id;
    const requestRegion = (req.headers["x-region"] as string) || getRegion();
    const { envelope, status } = await handle(
      "content_metadata",
      () => metadataBusiness(db, tid, ctx),
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
