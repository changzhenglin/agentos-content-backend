// seed.ts — self_hosted 真实曲目填库（M3 阶段2 U3）。
// 填 tracks/lyrics 表 + 上传 MP3 到 MinIO。
// sim 用 ffmpeg 生成 sine wave MP3（public-domain，真实字节）；真 royalty-free 曲目授权后替换。
import type { ContentDb } from "../../content/db.js";
import type { S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { objectKey } from "../../storage/presign.js";

interface SeedTrack {
  trackId: string;      // self:track1
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  coverUrl: string | null;
  format: "mp3" | "aac" | "flac";
  bitrate: number;
  isrc: string | null;
  license: string;       // "public-domain"
  regionPolicy: string | null;
  mp3File: string;       // test/fixtures/audio/track1.mp3
  lyrics: { lineIndex: number; timestampMs: number; text: string; license: string }[];
}

const SEED_TRACKS: SeedTrack[] = [
  {
    trackId: "self:track1", title: "Sim Sine 440Hz", artist: "AgentOS", album: "Sim Test",
    durationMs: 3000, coverUrl: null, format: "mp3", bitrate: 128000, isrc: null,
    license: "public-domain", regionPolicy: null, mp3File: "track1.mp3",
    lyrics: [
      { lineIndex: 0, timestampMs: 0, text: "[sim sine wave 440Hz]", license: "public-domain" },
    ],
  },
  {
    trackId: "self:track2", title: "Sim Sine 523Hz", artist: "AgentOS", album: "Sim Test",
    durationMs: 2000, coverUrl: null, format: "mp3", bitrate: 128000, isrc: null,
    license: "public-domain", regionPolicy: null, mp3File: "track2.mp3",
    lyrics: [
      { lineIndex: 0, timestampMs: 0, text: "[sim sine wave 523Hz]", license: "public-domain" },
    ],
  },
];

export async function seedSelfHostedCatalog(opts: {
  db: ContentDb;
  s3: S3Client;
  bucket: string;
  audioDir: string;
}): Promise<void> {
  const { db, s3, bucket, audioDir } = opts;
  for (const t of SEED_TRACKS) {
    const key = objectKey("self", t.trackId.replace(/^self:/, ""), 1);
    const mp3Path = join(audioDir, t.mp3File);
    const body = readFileSync(mp3Path);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "audio/mpeg" }));
    // insert tracks（track_id 已含 self: 前缀，parseTrackId 期望 <provider>:<id>）
    await db.query(
      `INSERT INTO tracks (track_id, title, artist, album, duration_ms, cover_url, audio_object_key, format, bitrate, isrc, license, region_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (track_id) DO NOTHING`,
      [t.trackId, t.title, t.artist, t.album, t.durationMs, t.coverUrl, key, t.format, t.bitrate, t.isrc, t.license, t.regionPolicy],
    );
    for (const l of t.lyrics) {
      await db.query(
        `INSERT INTO lyrics (track_id, line_index, timestamp_ms, text, lyrics_license)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (track_id, line_index) DO NOTHING`,
        [t.trackId, l.lineIndex, l.timestampMs, l.text, l.license],
      );
    }
  }
}
