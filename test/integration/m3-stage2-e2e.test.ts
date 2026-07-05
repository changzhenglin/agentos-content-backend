// M3 阶段2 e2e：spawn backend + mock device-hub caller + third_party mock provider。
// 验收（含 review fold）：
//   1. device-hub + self_hosted query → 200 DONE（seed 填库后真实曲目）
//   2. device-hub + provider=qq (third_party) → 403 backend_type_not_allowed
//   3. device-hub + content_stream → 200 + presigned URL → 真 HTTP GET 拉 MP3 字节
//   4. device-hub + X-Device-Capability 不支持 lyrics → 403 CAPABILITY_UNSUPPORTED
//   5. 伪造 X-Caller-Identity: content-backend → anonymous → 403
//   6. review fold P1#2 sim known hole: device-hub 伪 cloud-ext + 无 handle + provider=qq → 200（known hole，mTLS remediation）
//   7. review fold P2#5: audit JSONL hash chain（device-hub caller 记录）
//   8. review fold P2#6: device-hub + track_id="qq:xxx" 前缀驱动 third_party → 403
// review fold: C1 ESM import + P3#8 readdirSync 动态 migration + createBucket
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Pool } from "pg";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSelfHostedCatalog } from "../../src/db/seed/seed.js";
import { verifyChain } from "../../src/audit/audit-sink.js";
import { createPolicyStore, type PolicyEnvelope } from "../../src/policy/policy-store.js";
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
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer(); s.unref(); s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
  });
}

// mock provider（复用 m2d-e2e pattern，for #6 known hole spoof cloud-ext + third_party 200）
function startMockProvider(): Promise<{ server: Server; url: string; receivedAuths: Record<string, string | undefined> }> {
  const receivedAuths: Record<string, string | undefined> = {};
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    receivedAuths.qq = auth;
    const token = auth?.replace(/^Bearer /, "");
    if (!token || token === "invalid") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error_code: "AUTH_FAILED" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ query: { keywords: ["k"] }, candidates: [{ track_id: "qq:t1", title: "song", artist: "art", confidence: 0.9 }] }));
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}`, receivedAuths }));
  });
}

function mkQqPolicyEnvelope(): PolicyEnvelope {
  return {
    command_id: `cmd_qq_${Math.random().toString(36).slice(2)}`,
    kind: "content_policy", capability_mode: "real", version: 1,
    payload: { rule_id: "qq", action: "allow", target_scope: "cn", auth_config: { token_source: "backend_issued", token_ref: "^backend:qq-token_v1" } },
    security_context: { actor: "ops-platform", rbac_decision: {}, audience: "content-backend", expiry: "2026-12-31T00:00:00Z" },
  };
}

describe("M3 阶段2 e2e (device-hub 直连 + self_hosted 真实曲目)", { skip: !dockerAvailable() || !ffmpegAvailable() }, () => {
  let pg: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let backendProc: ChildProcess;
  let mockProvider: { server: Server; url: string; receivedAuths: Record<string, string | undefined> };
  let backendUrl: string;
  let auditPath: string;
  let stubSecretsPath: string;

  beforeAll(async () => {
    auditPath = join(tmpdir(), `m3-stage2-audit-${process.pid}.jsonl`);
    stubSecretsPath = join(tmpdir(), `m3-stage2-secrets-${process.pid}.json`);
    if (existsSync(auditPath)) unlinkSync(auditPath);
    writeFileSync(stubSecretsPath, JSON.stringify({ "^backend:qq-token_v1": { token: "mock-qq-token", token_type: "bearer" } }));

    pg = await new PostgreSqlContainer("postgres:15-alpine").withDatabase("agentos_content").start();
    minio = await new MinioContainer("minio/minio:latest").start();
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
      await pg.exec(["psql","-v","ON_ERROR_STOP=1","-U",pg.getUsername(),"-d",pg.getDatabase(),"-c",sql]);
    }
    // seed 填库
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const db: ContentDb = { async query(text: string, params?: unknown[]) { return pool.query(text, params as any[]); } };
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    try { await s3.send(new CreateBucketCommand({ Bucket: "agentos-content-test" })); } catch {}
    await seedSelfHostedCatalog({ db, s3, bucket: "agentos-content-test", audioDir: AUDIO_DIR });
    // push qq policy（for #6 known hole spoof cloud-ext + third_party 200）
    const policyStore = createPolicyStore(db);
    await policyStore.applyPolicy(mkQqPolicyEnvelope(), "ops-platform");
    await pool.end();

    mockProvider = await startMockProvider();
    const port = await getFreePort();
    backendUrl = `http://127.0.0.1:${port}`;
    backendProc = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        DATABASE_URL: pg.getConnectionUri(),
        S3_ENDPOINT: minio.getConnectionUrl(), S3_ACCESS_KEY_ID: minio.getUsername(), S3_SECRET_ACCESS_KEY: minio.getPassword(),
        S3_BUCKET: "agentos-content-test", S3_REGION: "us-east-1", CONTENT_BACKEND_REGION: "cn",
        AUDIT_SINK_PATH: auditPath, STUB_SECRETS_PATH: stubSecretsPath,
        PROVIDER_BASE_URL_QQ: mockProvider.url, PROVIDER_AVAILABLE: "true", PORT: String(port),
      },
      stdio: "pipe",
    });
    backendProc.stderr?.on("data", (d) => { if (process.env.M3_E2E_DEBUG) console.error("[backend]", d.toString()); });
    for (let i = 0; i < 90; i++) {
      try { const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: { keywords: [] } }) }); if (r.ok || r.status === 400 || r.status === 403 || r.status === 500) break; } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 240000);

  afterAll(async () => {
    try { backendProc?.kill("SIGTERM"); } catch {}
    try { await mockProvider?.server.close(); } catch {}
    try { await pg?.stop(); } catch {}
    try { await minio?.stop(); } catch {}
    try { if (auditPath && existsSync(auditPath)) unlinkSync(auditPath); } catch {}
    try { if (stubSecretsPath && existsSync(stubSecretsPath)) unlinkSync(stubSecretsPath); } catch {}
  });

  beforeEach(() => { try { if (existsSync(auditPath)) unlinkSync(auditPath); } catch {} for (const k of Object.keys(mockProvider.receivedAuths)) delete mockProvider.receivedAuths[k]; });

  const cap = JSON.stringify({ kinds: ["content_query","content_match","content_stream","content_lyrics","content_metadata"], formats: ["mp3"], maxBitrate: 128000, region: "cn" });

  it("#1 device-hub + self_hosted query → 200 DONE + 真实 candidates", async () => {
    const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": cap }, body: JSON.stringify({ query: { keywords: ["Sim"] } }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.backend_type).toBe("self_hosted");
    expect(body.completion_state).toBe("DONE");
    expect(body.candidates[0].track_id).toMatch(/^self:/);
  });

  it("#2 device-hub + provider=qq (third_party) → 403 backend_type_not_allowed", async () => {
    const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": cap }, body: JSON.stringify({ provider: "qq", query: { keywords: ["k"] } }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("AUTH_FAILED");
  });

  it("#3 device-hub + content_stream → 200 + presigned URL → 真 HTTP GET 拉 MP3 字节", async () => {
    const r = await fetch(`${backendUrl}/content_stream`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": cap }, body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toMatch(/^http/);
    const mp3Res = await fetch(body.url);
    const buf = Buffer.from(await mp3Res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0] === 0x49 || buf[0] === 0xff).toBe(true);
  });

  it("#4 device-hub + X-Device-Capability 不支持 lyrics → 403 CAPABILITY_UNSUPPORTED", async () => {
    const capNoLyrics = JSON.stringify({ kinds: ["content_query"], formats: ["mp3"], maxBitrate: 128000 });
    const r = await fetch(`${backendUrl}/content_lyrics`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": capNoLyrics }, body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("#5 伪造 X-Caller-Identity: content-backend + ^backend:foo handle → 403（anonymous 归一化 + source_not_allowed）", async () => {
    // content-backend 不在 inbound 白名单 → anonymous；^backend: handle + anonymous caller
    // → receiveAndAuthorize caller_not_allowed（anonymous 不在 ALLOW_MATRIX）
    const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "content-backend", "x-secret-handle": "^backend:foo" }, body: JSON.stringify({ query: { keywords: ["any"] } }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("AUTH_FAILED");
  });

  it("#6 review fold P1#2 sim known hole: device-hub 伪 cloud-ext + 无 handle + provider=qq → 200（known hole）", async () => {
    // device-hub 伪造 X-Caller-Identity: cloud-ext + 无 handle → !handle 短路 authorized as cloud-ext
    // → authorizeBackendType(cloud-ext, third_party_api) → authorized → fetchThirdParty → mock provider 200
    // 这是 sim known hole（mTLS defer 真机才修），记录验证当前行为
    const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "cloud-ext", "x-device-capability": cap }, body: JSON.stringify({ provider: "qq", query: { keywords: ["k"] } }) });
    expect(r.status).toBe(200); // known hole: 当前 200（sim trust network，mTLS defer 真机修）
    const body = await r.json();
    expect(body.backend_type).toBe("third_party_api");
    // mock provider 收 Bearer mock-qq-token（cloud-ext spoof 调通 third_party）
    expect(mockProvider.receivedAuths.qq).toBe("Bearer mock-qq-token");
  });

  it("#7 review fold P2#5: audit JSONL hash chain（device-hub caller tool_call 记录）", async () => {
    await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-trace-id": "trace-audit-7", "x-device-capability": cap }, body: JSON.stringify({ query: { keywords: ["Sim"] } }) });
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(auditPath)).toBe(true);
    const audit = readFileSync(auditPath, "utf8");
    // device-hub self_hosted 无 handle 不 emit secret_handle audit，但 drmGuard tool_call audit 记 actor
    // 注意：drmGuard tool_call audit actor=ctx.actor（buildServer actor 默认 "anonymous-service"）
    // device-hub caller 不直接进 audit actor（actor 是 buildServer opts.actor）。audit 记 tool_call eventType。
    expect(audit).toContain('"eventType":"tool_call"');
    // review fold I2: 调 verifyChain 验证 hash chain 完整性（对齐 policy-push/kind-drm-audit e2e 范式）
    expect(verifyChain(auditPath)).toBe(true);
  });

  it("#8 review fold P2#6: device-hub + track_id=qq:xxx 前缀驱动 third_party → 403", async () => {
    // track_id 前缀 qq: → parseTrackId 解析 provider=qq → resolveProviderPath third_party →
    // authorizeBackendType(device-hub, third_party_api) → 拒 403
    const r = await fetch(`${backendUrl}/content_stream`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": cap }, body: JSON.stringify({ track_id: "qq:xxx" }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("AUTH_FAILED");
  });
});
