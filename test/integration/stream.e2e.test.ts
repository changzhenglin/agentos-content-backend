import { describe, it, expect } from "vitest";
import { createTestDb, seedTrack, type SeedTrack } from "./helpers.js";
import { streamBusiness, type PresignFn } from "../../src/routes/stream.js";
import { wrapEnvelope } from "../../src/envelope.js";
import { httpStatus } from "../../src/routes/http-mapping.js";

const base: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo",
  duration_ms: 1000,
  audio_object_key: "self:t1:v1",
  format: "mp3",
  bitrate: 128000,
  license: "CC",
};

// mock presign：返回固定 url/auth（stream e2e mock presignUrl，brief Step 4）
const mockPresign: PresignFn = async (key) => ({
  url: `https://mock.s3/${key}`,
  auth: {
    token: "mock-token",
    token_type: "query_param",
    expires_at: "2026-12-31T00:00:00.000Z",
  },
});

describe("stream e2e", () => {
  it("self track → ok + presign url + stream 字段", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await streamBusiness(db, mockPresign, "self:t1");
    expect(r.outcome).toBe("ok");
    expect(r.backendType).toBe("self_hosted");
    expect(r.business.track_id).toBe("self:t1");
    expect(r.business.url).toBe("https://mock.s3/self:t1:v1");
    expect(r.business.format).toBe("mp3");
    expect(r.business.bitrate).toBe(128000);
    expect(r.business.auth.token).toBe("mock-token");
    expect(r.business.stream_id).toBeGreaterThan(0);
    expect(r.business.expires_at).toBe("2026-12-31T00:00:00.000Z");
  });

  it("track 不存在 → no_result", async () => {
    const db = createTestDb();
    const r = await streamBusiness(db, mockPresign, "self:nope");
    expect(r.outcome).toBe("no_result");
  });

  it("third_party stream 未授权 → blocked（COPYRIGHT_RESTRICTED，T4 concerns）", async () => {
    const db = createTestDb();
    // third_party provider（如 qq:）stream 未授权 → selectPath unavailable → blocked
    const r = await streamBusiness(db, mockPresign, "qq:song1");
    expect(r.outcome).toBe("blocked");
    expect(r.backendType).toBe("self_hosted"); // attempted self_hosted
    // 透传 selectPath 的 capabilityMode + errorCode（解 M2）
    expect(r.capabilityMode).toBe("unavailable");
    expect(r.errorCode).toBe("COPYRIGHT_RESTRICTED");
  });

  it("envelope wrap + httpStatus 端到端（ok → DONE → 200）", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await streamBusiness(db, mockPresign, "self:t1");
    // handler 透传 capabilityMode + errorCode（解 M2：不再手动传）
    const env = wrapEnvelope(
      r.business,
      "content_stream",
      r.backendType,
      r.capabilityMode,
      r.outcome,
      r.errorCode,
    );
    expect(env.completion_state).toBe("DONE");
    expect(env.error_code).toBeUndefined();
    expect(httpStatus(env.completion_state)).toBe(200);
    expect(env.url).toBe("https://mock.s3/self:t1:v1");
  });

  it("envelope wrap（blocked → BLOCKED，errorCode 透传 COPYRIGHT_RESTRICTED → I1 收窄 403）", async () => {
    const db = createTestDb();
    const r = await streamBusiness(db, mockPresign, "qq:song1");
    // handler 透传 capabilityMode + errorCode（selectPath unavailable + COPYRIGHT_RESTRICTED）
    const env = wrapEnvelope(
      r.business,
      "content_stream",
      r.backendType,
      r.capabilityMode,
      r.outcome,
      r.errorCode,
    );
    expect(env.completion_state).toBe("BLOCKED");
    expect(env.error_code).toBe("COPYRIGHT_RESTRICTED");
    // I1 收窄：BLOCKED + COPYRIGHT_RESTRICTED → 403（client-side block）
    expect(httpStatus(env.completion_state, env.error_code)).toBe(403);
  });
});
