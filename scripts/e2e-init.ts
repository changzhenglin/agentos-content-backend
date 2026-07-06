// scripts/e2e-init.ts — M3 阶段2 Task 8 docker seed init
// docker-compose seed service 调：create S3 bucket + run migration SQL + seed self-hosted catalog。
// 复用 m3-stage2-self-hosted-loop.e2e.test.ts beforeAll 模式（testcontainers pg+minio + migration + seed）。
import { Pool } from "pg";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { seedSelfHostedCatalog } from "../src/db/seed/seed.js";
import type { ContentDb } from "../src/content/db.js";

const dbUrl = process.env.DATABASE_URL;
const s3Endpoint = process.env.S3_ENDPOINT;
const s3Region = process.env.S3_REGION ?? "us-east-1";
const s3Key = process.env.S3_ACCESS_KEY_ID;
const s3Secret = process.env.S3_SECRET_ACCESS_KEY;
const bucket = process.env.S3_BUCKET ?? "agentos-content-test";
const audioDir = process.env.AUDIO_DIR ?? "test/fixtures/audio";
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), "src/db/migrations");

async function main() {
  if (!dbUrl || !s3Endpoint || !s3Key || !s3Secret) {
    console.error("e2e-init: DATABASE_URL/S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY required");
    process.exit(1);
  }
  // 1. migration SQL（0000/0001/0002 顺序）
  const pool = new Pool({ connectionString: dbUrl });
  const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    console.log("migration:", f);
    await pool.query(sql);
  }
  const db: ContentDb = {
    async query(text: string, params?: unknown[]) { return pool.query(text, params as any[]); },
  };
  // 2. create bucket（已存在则忽略）
  const s3 = new S3Client({
    endpoint: s3Endpoint, region: s3Region,
    credentials: { accessKeyId: s3Key, secretAccessKey: s3Secret },
    forcePathStyle: true,
  });
  try { await s3.send(new CreateBucketCommand({ Bucket: bucket })); console.log("bucket created:", bucket); }
  catch (e: any) { console.log("bucket exists/ignore:", bucket, e?.name ?? ""); }
  // 3. seed self-hosted catalog（self:track1/track2 真实 sine wave MP3）
  await seedSelfHostedCatalog({ db, s3, bucket, audioDir });
  console.log("seed done: self:track1/track2");
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
