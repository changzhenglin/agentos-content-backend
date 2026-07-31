// server.e2e.test.ts — T7 集成：fastify server + 5 kind routes + ajv onSend validate。
//
// TDD：先写 failing test（buildServer 未实现），再实现 src/index.ts。
// 复用 T5 helpers（pg-mem ContentDb + seedTrack）+ mock presign（stream 路由 hexagonal 注入）。
// ajv onSend hook 对每个响应跑 content-contract schema validate，fail 则 throw（解 plan-eng I3）。

import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/index.js";
import {
  createTestDb,
  seedTrack,
  seedLyrics,
  type SeedTrack,
} from "./helpers.js";
import type { PresignFn } from "../../src/routes/stream.js";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import type { AuditEvent, AuditSink } from "../../src/audit/audit-sink.js";

// 复用 content-contract schema 做 client 侧断言（与 server onSend 同源）
const ajv = new Ajv({ allErrors: true, validateSchema: false });
const schema = JSON.parse(
  readFileSync("schemas/content-contract.schema.json", "utf8"),
);
ajv.addSchema(
  JSON.parse(readFileSync("schemas/track.schema.json", "utf8")),
);
ajv.addSchema(
  JSON.parse(readFileSync("schemas/runtime-mode.schema.json", "utf8")),
);
const validate = ajv.compile(schema);

const base: SeedTrack = {
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

const mockPresign: PresignFn = async (key) => ({
  url: `https://mock.s3/${key}`,
  auth: {
    token: "mock-token",
    token_type: "query_param",
    expires_at: "2026-12-31T00:00:00.000Z",
  },
});

function createCapturingAuditSink(): {
  sink: AuditSink;
  events: Array<Omit<AuditEvent, "prevHash" | "hash" | "ts">>;
} {
  const events: Array<Omit<AuditEvent, "prevHash" | "hash" | "ts">> = [];
  return {
    sink: {
      async emit(event) {
        events.push(event);
      },
    },
    events,
  };
}

describe("server e2e", () => {
  it("POST /content_query 200 + schema-valid envelope (DONE)", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: {
        "x-trace-id": "trace-server-e2e",
        "x-trace-origin": "propagated",
      },
      payload: { query: { keywords: ["Sunrise"] } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe("content_query");
    expect(body.runtime_mode).toBe("remote-service");
    expect(body.completion_state).toBe("DONE");
    expect(body.candidates).toBeInstanceOf(Array);
    expect(body.candidates[0].track_id).toBe("self:t1");
    // trace 只能走响应 header，不得进入 frozen response body。
    expect(r.headers["x-trace-id"]).toBe("trace-server-e2e");
    expect(body).not.toHaveProperty("trace_id");
    // ajv onSend 已在 server 内 validate；此处 client 侧独立确认 schema-valid
    expect(validate(body)).toBe(true);
  });

  it("GET /metrics 未配置 token → 403 fail-closed；配置后需 Bearer token", async () => {
    const db = createTestDb();
    const closed = await buildServer({ db, presign: mockPresign });
    const noToken = await closed.inject({ method: "GET", url: "/metrics" });
    expect(noToken.statusCode).toBe(403);

    const protectedApp = await buildServer({ db, presign: mockPresign, metricsToken: "metrics-secret" });
    const denied = await protectedApp.inject({ method: "GET", url: "/metrics" });
    expect(denied.statusCode).toBe(401);
    const allowed = await protectedApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer metrics-secret" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain("http_requests_total");
  });

  it("入站 trace 统一 trim 后写入响应与审计，纯空白规范化为 null", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const captured = createCapturingAuditSink();
    const app = await buildServer({ db, presign: mockPresign, auditSink: captured.sink });

    const traced = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: { "x-trace-id": "  trace-audit-inbound  " },
      payload: { query: { keywords: ["Sunrise"] } },
    });
    expect(traced.statusCode).toBe(200);
    expect(traced.headers["x-trace-id"]).toBe("trace-audit-inbound");
    expect(captured.events.at(-1)?.traceId).toBe("trace-audit-inbound");

    const blank = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: { "x-trace-id": "   " },
      payload: { query: { keywords: ["Sunrise"] } },
    });
    expect(blank.statusCode).toBe(200);
    expect(blank.headers["x-trace-id"]).toBeUndefined();
    expect(captured.events.at(-1)?.traceId).toBeNull();
  });

  it("POST /content_query no_result → 200 DONE_WITH_CONCERNS + NO_RESULT", async () => {
    const db = createTestDb();
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      payload: { query: { keywords: ["nonexistent"] } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.completion_state).toBe("DONE_WITH_CONCERNS");
    expect(body.error_code).toBe("NO_RESULT");
    expect(body.candidates).toEqual([]);
    expect(validate(body)).toBe(true);
  });

  it("POST /content_match ok → 200 + track + match", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_match",
      payload: { match: { title: "Sunrise", artist: "Foo" } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe("content_match");
    expect(body.completion_state).toBe("DONE");
    expect(body.track.title).toBe("Sunrise");
    expect(body.match.title).toBe("Sunrise");
    expect(validate(body)).toBe(true);
  });

  it("POST /content_stream ok → 200 + stream 字段 (mock presign)", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe("content_stream");
    expect(body.completion_state).toBe("DONE");
    expect(body.url).toBe("https://mock.s3/self:t1:v1");
    expect(body.auth.token).toBe("mock-token");
    expect(body.format).toBe("mp3");
    expect(body.bitrate).toBe(128000);
    expect(validate(body)).toBe(true);
  });

  it("POST /content_stream blocked (third_party 未授权) → 403 BLOCKED（I1 收窄：client-side copyright block）", async () => {
    const db = createTestDb();
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "qq:song1" },
    });
    expect(r.statusCode).toBe(403);
    const body = r.json();
    expect(body.completion_state).toBe("BLOCKED");
    expect(body.error_code).toBe("COPYRIGHT_RESTRICTED");
    expect(validate(body)).toBe(true);
  });

  it("POST /content_lyrics ok → 200 + lines", async () => {
    const db = createTestDb({ withLyrics: true });
    await seedTrack(db, base);
    await seedLyrics(db, "self:t1", [
      { line_index: 0, timestamp_ms: 0, text: "hello", lyrics_license: "CC" },
    ]);
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_lyrics",
      payload: { track_id: "self:t1" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe("content_lyrics");
    expect(body.completion_state).toBe("DONE");
    expect(body.lines).toHaveLength(1);
    expect(validate(body)).toBe(true);
  });

  it("POST /content_metadata ok → 200 + track 元数据", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_metadata",
      payload: { track_id: "self:t1" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe("content_metadata");
    expect(body.completion_state).toBe("DONE");
    expect(body.title).toBe("Sunrise");
    expect(body.artist).toBe("Foo");
    expect(validate(body)).toBe(true);
  });

  it("POST /content_metadata no_result → 200 DONE_WITH_CONCERNS", async () => {
    const db = createTestDb();
    const app = await buildServer({ db, presign: mockPresign });
    const r = await app.inject({
      method: "POST",
      url: "/content_metadata",
      payload: { track_id: "self:nope" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.completion_state).toBe("DONE_WITH_CONCERNS");
    expect(body.error_code).toBe("NO_RESULT");
    expect(validate(body)).toBe(true);
  });
});
