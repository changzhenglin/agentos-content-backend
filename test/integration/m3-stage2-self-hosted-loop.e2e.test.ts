// M3 阶段2 5 kind 真实数据闭环：seed 填库后，device-hub caller 调 5 kind 全链。
// testcontainers pg+minio + in-process buildServer（listen + fetch，因 stream URL 要真 HTTP GET 拉取）。
// review fold: C1 ESM import + P3#8 readdirSync 动态 migration + P2#4 degraded 路径测试。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { Pool } from "pg";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";
import { seedSelfHostedCatalog } from "../../src/db/seed/seed.js";
import type { ContentDb } from "../../src/content/db.js";

const REPO_DIR = process.env.M2D_BACKEND_DIR ?? "/Users/lcz/projects/agentos-content-backend";
const MIGRATIONS_DIR = `${REPO_DIR}/src/db/migrations`;
const AUDIO_DIR = `${REPO_DIR}/test/fixtures/audio`;

function dockerAvailable(): boolean {
  if (process.env.DOCKER_HOST) return true;
  try { execSync("docker ps", { stdio: "ignore" }); return true; } catch { return false; }
}
function ffmpegAvailable(): boolean {
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch { return false; }
}

describe("M3 阶段2 self_hosted 5 kind 闭环", { skip: !dockerAvailable() || !ffmpegAvailable() }, () => {
  let pg: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let app: FastifyInstance;
  let baseUrl: string;
  let pool: Pool;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:15-alpine").withDatabase("agentos_content").start();
    minio = await new MinioContainer("minio/minio:latest").start();
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
      await pg.exec(["psql","-v","ON_ERROR_STOP=1","-U",pg.getUsername(),"-d",pg.getDatabase(),"-c",sql]);
    }
    pool = new Pool({ connectionString: pg.getConnectionUri() });
    const db: ContentDb = { async query(text: string, params?: unknown[]) { return pool.query(text, params as any[]); } };
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    try { await s3.send(new CreateBucketCommand({ Bucket: "agentos-content-test" })); } catch {}
    await seedSelfHostedCatalog({ db, s3, bucket: "agentos-content-test", audioDir: AUDIO_DIR });
    app = await buildServer({ db, s3, bucket: "agentos-content-test" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
  }, 240000);

  afterAll(async () => { try { await app?.close(); } catch {} try { await pool?.end(); } catch {} try { await pg?.stop(); } catch {} try { await minio?.stop(); } catch {} });

  const headers = (cap?: string) => ({
    "content-type": "application/json",
    "x-caller-identity": "device-hub",
    "x-device-capability": cap ?? JSON.stringify({ kinds: ["content_query","content_match","content_stream","content_lyrics","content_metadata"], formats: ["mp3"], maxBitrate: 128000, region: "cn" }),
  });

  it("query → 返 self 曲目 candidates", async () => {
    const r = await fetch(`${baseUrl}/content_query`, { method: "POST", headers: headers(), body: JSON.stringify({ query: { keywords: ["Sim"] } }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.backend_type).toBe("self_hosted");
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates[0].track_id).toMatch(/^self:/);
  });

  it("match → 返 match+track", async () => {
    const r = await fetch(`${baseUrl}/content_match`, { method: "POST", headers: headers(), body: JSON.stringify({ match: { title: "Sim Sine 440Hz" } }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.match.track_id).toBe("self:track1");
    expect(body.track.title).toBe("Sim Sine 440Hz");
  });

  it("stream → 返真 presigned URL（HTTP GET 拉 MP3 字节非空）", async () => {
    const r = await fetch(`${baseUrl}/content_stream`, { method: "POST", headers: headers(), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toMatch(/^http/);
    expect(body.format).toBe("mp3");
    const mp3Res = await fetch(body.url);
    const buf = Buffer.from(await mp3Res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0] === 0x49 || buf[0] === 0xff).toBe(true);
  });

  it("lyrics → 返歌词行", async () => {
    const r = await fetch(`${baseUrl}/content_lyrics`, { method: "POST", headers: headers(), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.lines.length).toBeGreaterThanOrEqual(1);
  });

  it("metadata → 返 track metadata", async () => {
    const r = await fetch(`${baseUrl}/content_metadata`, { method: "POST", headers: headers(), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.title).toBe("Sim Sine 440Hz");
    expect(body.duration_ms).toBe(3000);
  });

  it("capability 筛选：端侧不支持 content_lyrics → 403 CAPABILITY_UNSUPPORTED", async () => {
    const cap = JSON.stringify({ kinds: ["content_query"], formats: ["mp3"], maxBitrate: 128000 });
    const r = await fetch(`${baseUrl}/content_lyrics`, { method: "POST", headers: headers(cap), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("review fold P2#4: stream bitrate 降级 → DONE_WITH_CONCERNS + capability_mode=degraded", async () => {
    // seed track bitrate=128000, 端侧 maxBitrate=64000 → degraded
    const cap = JSON.stringify({ kinds: ["content_stream"], formats: ["mp3"], maxBitrate: 64000 });
    const r = await fetch(`${baseUrl}/content_stream`, { method: "POST", headers: headers(cap), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.capability_mode).toBe("degraded");
    expect(body.completion_state).toBe("DONE_WITH_CONCERNS");
  });
});
