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

  const app = Fastify();

  // 路由层统一 handle：调 handler → wrapEnvelope（透传 capabilityMode + errorCode）→ httpStatus。
  // brief handle() 用 outcome 推算 capMode 有误（会覆盖 selectPath）；此处直接透传 handler 值。
  async function handle(
    kind: Kind,
    fn: () => Promise<HandlerResult>,
  ): Promise<{ envelope: object; status: number }> {
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
    const { envelope, status } = await handle("content_query", () =>
      queryBusiness(db, (req.body as any).query),
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_match", async (req, reply) => {
    const { envelope, status } = await handle("content_match", () =>
      matchBusiness(db, (req.body as any).match),
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_stream", async (req, reply) => {
    const { envelope, status } = await handle("content_stream", () =>
      streamBusiness(db, presign, (req.body as any).track_id),
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_lyrics", async (req, reply) => {
    const { envelope, status } = await handle("content_lyrics", () =>
      lyricsBusiness(db, (req.body as any).track_id),
    );
    reply.code(status).send(envelope);
  });
  app.post("/content_metadata", async (req, reply) => {
    const { envelope, status } = await handle("content_metadata", () =>
      metadataBusiness(db, (req.body as any).track_id),
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
