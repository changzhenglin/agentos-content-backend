// scripts/seed-self-hosted.ts — M3 阶段2 self_hosted 真实曲目 seed CLI（窗口A Task 8 e2e 外部调用入口）。
// 复用 src/db/seed/seed.ts seedSelfHostedCatalog（self:track1/track2 真实 sine wave MP3，
// test/fixtures/audio/track1.mp3/track2.mp3）。区别于 scripts/seed.ts（T8 模板，placeholder audio 非真实字节）。
//
// 运行：DATABASE_URL=postgres://... S3_ENDPOINT=http://... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//      [S3_BUCKET=...] [S3_REGION=...] [AUDIO_DIR=...] npx tsx scripts/seed-self-hosted.ts
import { createS3 } from "../src/storage/s3-client.js";
import { seedSelfHostedCatalog } from "../src/db/seed/seed.js";
import type { ContentDb } from "../src/content/db.js";
import { Pool } from "pg";
import { pathToFileURL } from "node:url";

export interface SeedOpts {
  dbUrl: string;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  bucket: string;
  audioDir: string;
}

/**
 * 从 env 解析 seed opts，校验必填字段。default：S3_REGION=us-east-1, S3_BUCKET=agentos-content-test,
 * AUDIO_DIR=test/fixtures/audio（相对 cwd，content-backend repo 根）。
 */
export function resolveSeedOpts(env: NodeJS.ProcessEnv = process.env): SeedOpts {
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) throw new Error("seed-self-hosted: DATABASE_URL required");
  const s3Endpoint = env.S3_ENDPOINT;
  if (!s3Endpoint) throw new Error("seed-self-hosted: S3_ENDPOINT required");
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  if (!s3AccessKeyId) throw new Error("seed-self-hosted: S3_ACCESS_KEY_ID required");
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!s3SecretAccessKey) throw new Error("seed-self-hosted: S3_SECRET_ACCESS_KEY required");
  return {
    dbUrl,
    s3Endpoint,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3Region: env.S3_REGION ?? "us-east-1",
    bucket: env.S3_BUCKET ?? "agentos-content-test",
    audioDir: env.AUDIO_DIR ?? "test/fixtures/audio",
  };
}

async function main(): Promise<void> {
  const opts = resolveSeedOpts();
  const pool = new Pool({ connectionString: opts.dbUrl });
  const db: ContentDb = { async query(text, params) { return pool.query(text, params as any[]); } };
  const s3 = createS3(opts.s3Endpoint, opts.s3Region, opts.s3AccessKeyId, opts.s3SecretAccessKey);
  try {
    await seedSelfHostedCatalog({ db, s3, bucket: opts.bucket, audioDir: opts.audioDir });
    console.log(`[seed-self-hosted] done: 2 tracks (self:track1, self:track2) → bucket ${opts.bucket}`);
  } finally {
    await pool.end();
  }
}

// 仅在直接运行时跑（import 时不跑，便于 test）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("[seed-self-hosted] failed:", e);
    process.exit(1);
  });
}

