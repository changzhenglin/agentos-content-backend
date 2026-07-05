import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { Pool } from "pg";
import { S3Client, HeadObjectCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
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

describe("self-hosted-seed", { skip: !dockerAvailable() || !ffmpegAvailable() }, () => {
  let pg: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:15-alpine").withDatabase("agentos_content").start();
    minio = await new MinioContainer("minio/minio:latest").start();
    // review fold P3#8：动态读 migration 文件（避免硬编码列表 stale）
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
      await pg.exec(["psql","-v","ON_ERROR_STOP=1","-U",pg.getUsername(),"-d",pg.getDatabase(),"-c",sql]);
    }
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const db: ContentDb = { async query(text: string, params?: unknown[]) { return pool.query(text, params as any[]); } };
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    // MinIO testcontainers 默认无 bucket，先创建
    try { await s3.send(new CreateBucketCommand({ Bucket: "agentos-content-test" })); } catch {}
    await seedSelfHostedCatalog({ db, s3, bucket: "agentos-content-test", audioDir: AUDIO_DIR });
    await pool.end();
  }, 240000);

  afterAll(async () => { try { await pg?.stop(); } catch {} try { await minio?.stop(); } catch {} });

  it("tracks 表填入 2 首 self 曲目", async () => {
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query("SELECT track_id, title, format, bitrate, audio_object_key FROM tracks WHERE track_id LIKE 'self:%'");
    await pool.end();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].format).toBe("mp3");
    expect(rows[0].bitrate).toBe(128000);
  });

  it("lyrics 表填入歌词行", async () => {
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM lyrics");
    await pool.end();
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("MP3 文件已上传到 MinIO（HeadObject 成功）", async () => {
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query("SELECT audio_object_key FROM tracks LIMIT 1");
    await pool.end();
    const head = await s3.send(new HeadObjectCommand({ Bucket: "agentos-content-test", Key: rows[0].audio_object_key }));
    expect(head.ContentLength).toBeGreaterThan(0);
  });
});
