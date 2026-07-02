// scripts/seed.ts — T8：royalty-free track insert 模板。
//
// insert 3 首 CC-licensed track metadata + lyrics 到 tracks/lyrics 表。
// audio 占位文件上传对象存储（生产由 ops 执行：先 putObject 再 seed metadata）。
//
// 选曲为模板占位（SDD 执行时定具体 royalty-free track）；license 标 CC-BY / CC0。
// 运行：DATABASE_URL=postgres://... pnpm tsx scripts/seed.ts
// 可选 S3_* env 上传占位 audio（缺失则仅 insert metadata，audio 留待 ops 手动上传）。

import { createDb } from "../src/db/client.js";
import { tracks, lyrics } from "../src/db/schema.js";
import { createS3 } from "../src/storage/s3-client.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { loadEnv } from "../src/env.js";

const env = loadEnv();

interface SeedTrack {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  format: "mp3" | "aac" | "flac";
  bitrate: number;
  isrc: string;
  license: string;
  audioObjectKey: string;
  lyricsLicense: string;
  lyricLines: { timestampMs: number; text: string }[];
}

// 模板：3 首 CC-licensed track（royalty-free 占位，ops 替换为真实选曲）。
const SEED: SeedTrack[] = [
  {
    trackId: "self:t1",
    title: "Sunrise",
    artist: "Foo Artist",
    album: "Dawn EP",
    durationMs: 180000,
    format: "mp3",
    bitrate: 128000,
    isrc: "CC0000000001",
    license: "CC-BY-4.0",
    audioObjectKey: "self:t1:v1",
    lyricsLicense: "CC-BY-4.0",
    lyricLines: [
      { timestampMs: 0, text: "Sunrise on the dawn" },
      { timestampMs: 5000, text: "Light breaks through" },
    ],
  },
  {
    trackId: "self:t2",
    title: "Noon",
    artist: "Bar Artist",
    album: "Dawn EP",
    durationMs: 200000,
    format: "mp3",
    bitrate: 128000,
    isrc: "CC0000000002",
    license: "CC0-1.0",
    audioObjectKey: "self:t2:v1",
    lyricsLicense: "CC0-1.0",
    lyricLines: [
      { timestampMs: 0, text: "High noon" },
      { timestampMs: 6000, text: "Sun overhead" },
    ],
  },
  {
    trackId: "self:t3",
    title: "Sunset",
    artist: "Baz Artist",
    album: "Dusk EP",
    durationMs: 220000,
    format: "mp3",
    bitrate: 128000,
    isrc: "CC0000000003",
    license: "CC-BY-4.0",
    audioObjectKey: "self:t3:v1",
    lyricsLicense: "CC-BY-4.0",
    lyricLines: [
      { timestampMs: 0, text: "Sunset glow" },
      { timestampMs: 7000, text: "Day is done" },
    ],
  },
];

async function uploadPlaceholderAudio(bucket: string): Promise<void> {
  if (!process.env.S3_ENDPOINT) {
    console.log("[seed] S3_ENDPOINT 未配置，跳过占位 audio 上传（ops 手动 put）");
    return;
  }
  const s3 = createS3(
    env.s3.endpoint,
    env.s3.region,
    env.s3.accessKeyId,
    env.s3.secretAccessKey,
  );
  for (const t of SEED) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: t.audioObjectKey,
        Body: Buffer.from(`placeholder-audio-${t.trackId}`),
        ContentType: "audio/mpeg",
      }),
    );
    console.log(`[seed] uploaded placeholder ${t.audioObjectKey} → bucket ${bucket}`);
  }
}

async function main(): Promise<void> {
  if (!env.dbUrl) {
    throw new Error("DATABASE_URL required");
  }
  const db = createDb(env.dbUrl);

  await uploadPlaceholderAudio(env.s3.bucket);

  for (const t of SEED) {
    await db.insert(tracks).values({
      trackId: t.trackId,
      title: t.title,
      artist: t.artist,
      album: t.album,
      durationMs: t.durationMs,
      audioObjectKey: t.audioObjectKey,
      format: t.format,
      bitrate: t.bitrate,
      isrc: t.isrc,
      license: t.license,
    });
    for (let i = 0; i < t.lyricLines.length; i++) {
      const l = t.lyricLines[i];
      await db.insert(lyrics).values({
        trackId: t.trackId,
        lineIndex: i,
        timestampMs: l.timestampMs,
        text: l.text,
        lyricsLicense: t.lyricsLicense,
      });
    }
    console.log(`[seed] inserted ${t.trackId} + ${t.lyricLines.length} lyric lines`);
  }

  console.log(`[seed] done: ${SEED.length} tracks`);
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
