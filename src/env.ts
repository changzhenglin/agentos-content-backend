/**
 * 运行环境配置（默认值供本地/开发；生产通过 env 覆盖）。
 */

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Env {
  dbUrl: string;
  s3: S3Config;
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  return {
    dbUrl: overrides.dbUrl ?? process.env.DATABASE_URL ?? "postgres://localhost:5432/agentos_content",
    s3: {
      endpoint:
        overrides.s3?.endpoint ??
        process.env.S3_ENDPOINT ??
        "http://localhost:9000",
      region: overrides.s3?.region ?? process.env.S3_REGION ?? "us-east-1",
      bucket: overrides.s3?.bucket ?? process.env.S3_BUCKET ?? "agentos-content",
      accessKeyId:
        overrides.s3?.accessKeyId ?? process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey:
        overrides.s3?.secretAccessKey ??
        process.env.S3_SECRET_ACCESS_KEY ??
        "minioadmin",
    },
  };
}
