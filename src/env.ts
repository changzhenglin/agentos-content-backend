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
  port: number;                     // M2d: backend HTTP listen 端口（CLI spawn 用，default 3001）
  stubSecretsPath: string;          // M2d: stub secret store fixture JSON 路径（spawn env 传，D9 e2e 用）
  providerBaseUrl: Record<string, string>; // M2d: provider→base url 映射（PROVIDER_BASE_URL_<PROVIDER> env 解析）
  iamJwksUrl: string;            // #2: IAM JWKS base（如 http://iam:3000）
  iamJwtIssuer: string;          // #2: JWT iss 校验（agentos-iam）
  iamJwtAudience: string;        // #2: JWT aud 校验（content-backend）
  opsLookupUrl: string;          // #2: ops base（如 http://ops:3000）
  opsLookupToken: string;        // #2: service-auth x-service-token（与 ops OPS_LOOKUP_TOKEN 同值）
  capabilityMode: string;        // #2: mock=sim stub region/entitlement/mTLS caller，诚实声明
}

/**
 * 从 env 解析 PROVIDER_BASE_URL_<PROVIDER> 形如 PROVIDER_BASE_URL_QQ=http://...
 * 映射为 { qq: "http://..." }（provider key 小写）。spawn env 传，D9 e2e 用。
 */
function loadProviderBaseUrlEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = "PROVIDER_BASE_URL_";
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && v) {
      const provider = k.slice(prefix.length).toLowerCase();
      if (provider) out[provider] = v;
    }
  }
  return out;
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
    auditSinkPath: overrides.auditSinkPath ?? process.env.AUDIT_SINK_PATH ?? "",
    contentBackendRegion: overrides.contentBackendRegion ?? process.env.CONTENT_BACKEND_REGION ?? "cn",
    adminToken: overrides.adminToken ?? process.env.CONTENT_BACKEND_ADMIN_TOKEN ?? "dev-admin",
    operatorToken: overrides.operatorToken ?? process.env.CONTENT_BACKEND_OPERATOR_TOKEN ?? "dev-op",
    opsPort: overrides.opsPort ?? Number(process.env.OPS_PORT ?? 3002),
    // M2d: PORT env（CLI spawn 用，D9 e2e 传动态端口避免 3001 冲突）
    port: overrides.port ?? Number(process.env.PORT ?? 3001),
    // M2d: stub secret store fixture 路径（空串→默认空 stub；spawn env 传）
    stubSecretsPath: overrides.stubSecretsPath ?? process.env.STUB_SECRETS_PATH ?? "",
    // M2d: provider base url map（PROVIDER_BASE_URL_<PROVIDER> env 解析）
    providerBaseUrl: overrides.providerBaseUrl ?? loadProviderBaseUrlEnv(),
    // #2: token 校验 env（prod 必配项默认空串，assertProdEnv fail-fast）
    iamJwksUrl: overrides.iamJwksUrl ?? process.env.IAM_JWKS_URL ?? "",
    iamJwtIssuer: overrides.iamJwtIssuer ?? process.env.IAM_JWT_ISSUER ?? "agentos-iam",
    iamJwtAudience: overrides.iamJwtAudience ?? process.env.IAM_JWT_AUDIENCE ?? "content-backend",
    opsLookupUrl: overrides.opsLookupUrl ?? process.env.OPS_LOOKUP_URL ?? "",
    opsLookupToken: overrides.opsLookupToken ?? process.env.OPS_LOOKUP_TOKEN ?? "",
    capabilityMode: overrides.capabilityMode ?? process.env.CAPABILITY_MODE ?? "mock",
  };
}

/**
 * #2: production fail-fast 校验。prod 必配项缺失则抛错。
 * 本 T1 仅定义，T6 buildServer 内调用。
 */
export function assertProdEnv(env: Env): void {
  if (process.env.NODE_ENV !== "production") return;
  const missing: string[] = [];
  if (!env.iamJwksUrl) missing.push("IAM_JWKS_URL");
  if (!env.opsLookupUrl) missing.push("OPS_LOOKUP_URL");
  if (!env.opsLookupToken) missing.push("OPS_LOOKUP_TOKEN");
  if (missing.length) throw new Error(`prod env missing: ${missing.join(", ")}`);
  if (env.capabilityMode !== "mock") {
    console.warn("[env] CAPABILITY_MODE!=mock but region/entitlement real-check not implemented");
  }
}
