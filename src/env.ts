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
  auditSinkPath: string;            // 新增：audit JSONL 路径
  contentBackendRegion: string;     // 新增：D10 backend 自持 region
  adminToken: string;               // 新增：sim admin dev token
  operatorToken: string;            // 新增：sim operator dev token
  opsPort: number;                  // 新增：App2 端口
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
    auditSinkPath: overrides.auditSinkPath ?? process.env.AUDIT_SINK_PATH ?? ".audit.jsonl",
    contentBackendRegion: overrides.contentBackendRegion ?? process.env.CONTENT_BACKEND_REGION ?? "cn",
    adminToken: overrides.adminToken ?? process.env.CONTENT_BACKEND_ADMIN_TOKEN ?? "dev-admin",
    operatorToken: overrides.operatorToken ?? process.env.CONTENT_BACKEND_OPERATOR_TOKEN ?? "dev-op",
    opsPort: overrides.opsPort ?? Number(process.env.OPS_PORT ?? 3002),
  };
}
