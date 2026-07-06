import { describe, it, expect } from "vitest";
import { resolveSeedOpts } from "../../scripts/seed-self-hosted.js";

describe("seed-self-hosted CLI resolveSeedOpts", () => {
  const FULL_ENV: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgres://user:pass@host:5432/db",
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    S3_BUCKET: "my-bucket",
    S3_REGION: "cn",
    AUDIO_DIR: "/tmp/audio",
  };

  it("全 env 设 → 返回 opts（含显式 bucket/region/audioDir）", () => {
    const opts = resolveSeedOpts(FULL_ENV);
    expect(opts.dbUrl).toBe(FULL_ENV.DATABASE_URL);
    expect(opts.s3Endpoint).toBe(FULL_ENV.S3_ENDPOINT);
    expect(opts.s3AccessKeyId).toBe("minioadmin");
    expect(opts.s3SecretAccessKey).toBe("minioadmin");
    expect(opts.bucket).toBe("my-bucket");
    expect(opts.s3Region).toBe("cn");
    expect(opts.audioDir).toBe("/tmp/audio");
  });

  it("缺 DATABASE_URL → throw 明确 error", () => {
    const { DATABASE_URL: _omit, ...rest } = FULL_ENV;
    expect(() => resolveSeedOpts(rest)).toThrow(/DATABASE_URL/);
  });

  it("缺 S3_ENDPOINT → throw 明确 error", () => {
    const { S3_ENDPOINT: _omit, ...rest } = FULL_ENV;
    expect(() => resolveSeedOpts(rest)).toThrow(/S3_ENDPOINT/);
  });

  it("缺 S3_ACCESS_KEY_ID → throw 明确 error", () => {
    const { S3_ACCESS_KEY_ID: _omit, ...rest } = FULL_ENV;
    expect(() => resolveSeedOpts(rest)).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it("缺 S3_SECRET_ACCESS_KEY → throw 明确 error", () => {
    const { S3_SECRET_ACCESS_KEY: _omit, ...rest } = FULL_ENV;
    expect(() => resolveSeedOpts(rest)).toThrow(/S3_SECRET_ACCESS_KEY/);
  });

  it("可选字段缺省 → default（S3_REGION=us-east-1, S3_BUCKET=agentos-content-test, AUDIO_DIR=test/fixtures/audio）", () => {
    const { S3_BUCKET: _b, S3_REGION: _r, AUDIO_DIR: _a, ...required } = FULL_ENV;
    const opts = resolveSeedOpts(required);
    expect(opts.s3Region).toBe("us-east-1");
    expect(opts.bucket).toBe("agentos-content-test");
    expect(opts.audioDir).toBe("test/fixtures/audio");
  });
});
