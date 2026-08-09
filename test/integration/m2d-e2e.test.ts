// m2d-e2e.test.ts — Task 8: docker 全链 e2e（D9 验收）。
//
// 真跨层验证（方案 A：真 spawn backend as child_process）：
//   testcontainers postgres:15-alpine + minio + child_process spawn backend tsx 进程
//   （m2d-backend-handle-parsing branch，app.listen <PORT>，env 指向 testcontainers +
//   STUB_SECRETS_PATH fixture JSON + PROVIDER_BASE_URL_QQ=mock provider HTTP server）。
//   mock provider 用 node:http 真 HTTP endpoint（非 undici MockAgent，因 spawned backend
//   有独立 undici context，setGlobalDispatcher 不跨进程）。
//
// D9 验收 5 点：
//   1. cloud-ext fetch → backend X-Secret-Handle:^cloud:foo + X-Caller-Identity:cloud-ext（Flow A transport）
//   2. backend receiveAndAuthorize → audit JSONL 记 secret_handle:^cloud:foo + actor:cloud-ext
//   3. content_policy push（rule_id=qq, action=allow, token_ref=^backend:qq-token_v1）+ provider=qq
//      → backend resolveHandle(^backend:qq-token_v1,"content-backend","qq") → stub store 返 creds（Flow B resolve）
//   4. mock provider 收 Authorization: Bearer mock-qq-token → 返 raw business → backend wrapEnvelope third_party_api/real DONE
//   5. 越权 ^backend:foo + cloud-ext caller → 403 BLOCKED + audit unauthorized（reason=source_not_allowed）
//
// 复用 M2c D10 模式（cloud-ext 侧 cloud-ext-to-backend.e2e.test.ts spawn + testcontainers），
// 本 test 在 content-backend repo 内自 spawn src/index.ts（env wiring 经 STUB_SECRETS_PATH +
// PROVIDER_BASE_URL_QQ + PORT，P1.3 方案 A）。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Pool } from "pg";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyStore, type PolicyEnvelope } from "../../src/policy/policy-store.js";
import type { ContentDb } from "../../src/content/db.js";

// content-backend repo 路径（spawn tsx src/index.ts 用 cwd）
const REPO_DIR = process.env.M2D_BACKEND_DIR ?? "/Users/lcz/projects/agentos-content-backend";
const MIGRATIONS_DIR = `${REPO_DIR}/src/db/migrations`;

// docker 可用性探测（无 docker 则 skip，避免 CI 无 docker 环境 flaky）
function dockerAvailable(): boolean {
  if (process.env.DOCKER_HOST) return true;
  try {
    execSync("docker ps", { stdio: "ignore" });
    // postgres:15-alpine + minio/minio:latest 镜像本地存在（CI 预取，避免 registry 故障 flaky）
    const pgId = execSync("docker images -q postgres:15-alpine", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    const minioId = execSync("docker images -q minio/minio:latest", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return pgId.length > 0 && minioId.length > 0;
  } catch {
    return false;
  }
}

// 抓一个空闲 TCP 端口（spawn backend listen 用，避免硬编 3001 与并行测试冲突）
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        reject(new Error("failed to get free port"));
      }
    });
  });
}

interface MockProvider {
  server: Server;
  url: string;
  receivedAuths: Record<string, string | undefined>;
}

// 启动 mock provider 真 HTTP endpoint（替代 undici MockAgent，因 spawned backend 独立 undici context）
// 鉴权契约：Authorization: Bearer <token>，token 缺失/invalid → 401 AUTH_FAILED；合法 → 200 + raw business
// path 匹配 /search|/match|/stream|/lyrics|/metadata（与 test/fixtures/mock-provider.ts 同约定，
// providerBaseUrl 无 path 前缀，subPath=kind 路径）。本 e2e 只测 qq，所有请求记入 receivedAuths.qq。
function startMockProvider(): Promise<MockProvider> {
  const receivedAuths: Record<string, string | undefined> = {};
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    // 本 e2e 只测 provider=qq，所有请求记 qq（多 provider 场景另起 server per provider）
    receivedAuths.qq = auth;
    const url = req.url ?? "";
    const token = auth?.replace(/^Bearer /, "");
    if (!token || token === "invalid") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error_code: "AUTH_FAILED" }));
      return;
    }
    // 返 raw business 字段（F1：非 envelope；wrapEnvelope 会 spread 到顶层）
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        query: { keywords: ["k"] },
        candidates: [
          {
            track_id: "qq:t1",
            title: "song",
            artist: "art",
            confidence: 0.9,
          },
        ],
      }),
    );
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          server,
          url: `http://127.0.0.1:${addr.port}`,
          receivedAuths,
        });
      } else {
        reject(new Error("failed to start mock provider"));
      }
    });
  });
}

// 应用 drizzle migrations 到 testcontainers pg（空库无表 → backend 查询 500，需建 schema）
async function applyMigrations(pgContainer: StartedPostgreSqlContainer) {
  const files = [
    "0000_abnormal_wrecking_crew.sql",
    "0001_neat_mystique.sql",
    "0002_dizzy_sway.sql",
  ];
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
    // psql -c 接受多语句（; 分隔）；--> statement-breakline 为 SQL 行注释（-- 前缀）psql 忽略
    const result = await pgContainer.exec([
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      pgContainer.getUsername(),
      "-d",
      pgContainer.getDatabase(),
      "-c",
      sql,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`migration ${f} failed: ${result.output}`);
    }
  }
}

// 构造 content_policy envelope（option A：单段 hyphen token_ref ^backend:qq-token_v1，
// fit ops-config.schema.json pattern ^backend:[a-zA-Z0-9_-]+$，无冒号 → binding 校验 skip，
// provider 绑定靠 rule_id=qq lookup）
function mkQqPolicyEnvelope(): PolicyEnvelope {
  return {
    command_id: `cmd_qq_${Math.random().toString(36).slice(2)}`,
    kind: "content_policy",
    capability_mode: "real",
    version: 1,
    payload: {
      rule_id: "qq",
      action: "allow",
      target_scope: "cn",
      auth_config: {
        token_source: "backend_issued",
        token_ref: "^backend:qq-token_v1",
      },
    },
    security_context: {
      actor: "ops-platform",
      rbac_decision: {},
      audience: "content-backend",
      expiry: "2026-12-31T00:00:00Z",
    },
  };
}

// 经生产 policyStore.applyPolicy 代码路径 push content_policy（复用 production wiring，
// 非手写 SQL，防 SQL 列序 drift）。用 testcontainers pg Pool 构 ContentDb。
async function pushQqPolicy(pgConnUri: string) {
  const pool = new Pool({ connectionString: pgConnUri });
  const db: ContentDb = {
    async query(text: string, params?: unknown[]) {
      return pool.query(text, params as any[]);
    },
  };
  const policyStore = createPolicyStore(db);
  await policyStore.applyPolicy(mkQqPolicyEnvelope(), "ops-platform");
  await pool.end();
}

// 等 backend listen ready（poll /content_query 直至响应任意 HTTP）
async function waitForBackend(url: string) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${url}/content_query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: { keywords: [] } }),
      });
      // 任意 HTTP 响应说明 fastify 已 listen
      if (r.ok || r.status === 400 || r.status === 500 || r.status === 403) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("M2d backend not ready in 90s");
}

describe("m2d e2e (D9 全链)", { skip: !dockerAvailable() }, () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let backendProc: ChildProcess;
  let mockProvider: MockProvider;
  let backendUrl: string;
  let auditPath: string;
  let stubSecretsPath: string;
  let backendPort: number;

  beforeAll(async () => {
    // 清理上次 audit 残留
    auditPath = join(tmpdir(), `m2d-e2e-audit-${process.pid}.jsonl`);
    stubSecretsPath = join(tmpdir(), `m2d-e2e-secrets-${process.pid}.json`);
    try {
      if (existsSync(auditPath)) unlinkSync(auditPath);
    } catch {}
    // stub secrets fixture：^backend:qq-token_v1 → mock-qq-token bearer
    writeFileSync(
      stubSecretsPath,
      JSON.stringify({
        "^backend:qq-token_v1": { token: "mock-qq-token", token_type: "bearer" },
      }),
    );

    // testcontainers postgres:15-alpine + minio
    pgContainer = await new PostgreSqlContainer("postgres:15-alpine").withDatabase(
      "agentos_content",
    ).start();
    minioContainer = await new MinioContainer("minio/minio:latest").start();
    await applyMigrations(pgContainer);

    // push content_policy（rule_id=qq, action=allow, token_ref=^backend:qq-token_v1）
    await pushQqPolicy(pgContainer.getConnectionUri());

    // mock provider 真 HTTP endpoint
    mockProvider = await startMockProvider();

    // spawn backend tsx 进程，env wiring（P1.3 方案 A）：
    //   DATABASE_URL/S3_*/AUDIT_SINK_PATH → testcontainers
    //   STUB_SECRETS_PATH → fixture JSON（backend 启动 load 构 stub store）
    //   PROVIDER_BASE_URL_QQ → mock provider url（backend 按.providerBaseUrl[provider] 路由）
    //   PROVIDER_AVAILABLE=true（selectPath third_party 分支启用）
    //   PORT → 动态端口（避免 3001 冲突）
    backendPort = await getFreePort();
    backendUrl = `http://127.0.0.1:${backendPort}`;
    backendProc = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        DATABASE_URL: pgContainer.getConnectionUri(),
        S3_ENDPOINT: minioContainer.getConnectionUrl(),
        S3_ACCESS_KEY_ID: minioContainer.getUsername(),
        S3_SECRET_ACCESS_KEY: minioContainer.getPassword(),
        S3_BUCKET: "agentos-content-test",
        S3_REGION: "us-east-1",
        CONTENT_BACKEND_REGION: "cn",
        AUDIT_SINK_PATH: auditPath,
        STUB_SECRETS_PATH: stubSecretsPath,
        PROVIDER_BASE_URL_QQ: mockProvider.url,
        PROVIDER_AVAILABLE: "true",
        PORT: String(backendPort),
      },
      stdio: "pipe",
    });
    // backend stderr 调试用（M2D_E2E_DEBUG=1 时打印）
    backendProc.stderr?.on("data", (d) => {
      if (process.env.M2D_E2E_DEBUG) console.error("[backend stderr]", d.toString());
    });
    await waitForBackend(backendUrl);
  }, 240000); // 4min container startup timeout（首次拉镜像慢）

  afterAll(async () => {
    try {
      backendProc?.kill("SIGTERM");
    } catch {}
    try {
      await mockProvider?.server.close();
    } catch {}
    try {
      await pgContainer?.stop();
    } catch {}
    try {
      await minioContainer?.stop();
    } catch {}
    try {
      if (auditPath && existsSync(auditPath)) unlinkSync(auditPath);
    } catch {}
    try {
      if (stubSecretsPath && existsSync(stubSecretsPath)) unlinkSync(stubSecretsPath);
    } catch {}
  });

  beforeEach(() => {
    // 每 test 前 clean audit（test 2 验本 run emit，不受残留干扰）
    try {
      if (existsSync(auditPath)) unlinkSync(auditPath);
    } catch {}
    // reset mock provider 记录
    for (const k of Object.keys(mockProvider.receivedAuths)) {
      delete mockProvider.receivedAuths[k];
    }
  });

  it("D9#1+#2: cloud-ext ^cloud: transport → 200 self_hosted DONE + audit JSONL 记 secret_handle + actor=cloud-ext", async () => {
    // 模拟 cloud-ext 出站：直接 fetch backend，注入 X-Secret-Handle + X-Caller-Identity
    // （cloud-ext injectSecretHandleHeader + 硬编 X-Caller-Identity:cloud-ext 在 Task 7 e2e 验证；
    //  本 test 验 backend 接收侧 receiveAndAuthorize + audit emit）
    const r = await fetch(`${backendUrl}/content_query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-secret-handle": "^cloud:foo",
        "x-caller-identity": "cloud-ext",
        "x-trace-id": "trace-d9-1",
      },
      body: JSON.stringify({ query: { keywords: ["any"] } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.kind).toBe("content_query");
    expect(body.backend_type).toBe("self_hosted");
    // 空库 query → DONE_WITH_CONCERNS（NO_RESULT）；D9#1 验 transport+audit 非 query 结果，
    // 接受 DONE/DONE_WITH_CONCERNS（与 M2c D10 base 同模式）
    expect(["DONE", "DONE_WITH_CONCERNS"]).toContain(body.completion_state);

    // 等 backend audit flush（appendFileSync 同步，留 300ms 安全余量）
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(auditPath)).toBe(true);
    const audit = readFileSync(auditPath, "utf8");
    // D9#2: audit 记 secret_handle（F5 截断 12 字符 → ^cloud:foo 不足 12，全保留）
    expect(audit).toContain("secret_handle:^cloud:foo");
    // D9#2: audit actor=cloud-ext（X-Caller-Identity 真传输到 backend receiveAndAuthorize）
    expect(audit).toContain('"actor":"cloud-ext"');
    expect(audit).toContain('"eventType":"tool_call"');
    expect(audit).toContain("trace-d9-1");
  });

  it("D9#3+#4: content_policy token_ref + provider=qq → resolveHandle → mock provider 收 Bearer → third_party_api/real DONE", async () => {
    // content_policy 已在 beforeAll push（rule_id=qq, action=allow, token_ref=^backend:qq-token_v1）
    // request provider=qq → resolveProviderPath 查 latestPolicy 命中 allow rule →
    // fetchThirdParty(providerHandle=^backend:qq-token_v1, provider=qq) →
    // stub store resolveHandle(^backend:qq-token_v1,"content-backend","qq") →
    //   caller content-backend 在 ALLOW_MATRIX 允许 ^backend:✓；option A 单段 hyphen handle
    //   无结构 provider 段 → binding skip；secrets[handle] 命中 → 返 {mock-qq-token, bearer}✓
    // → mock provider 收 Authorization: Bearer mock-qq-token → 200 raw business →
    // backend wrapEnvelope third_party_api/real DONE
    const r = await fetch(`${backendUrl}/content_query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caller-identity": "cloud-ext",
        "x-trace-id": "trace-d9-3",
      },
      body: JSON.stringify({ provider: "qq", query: { keywords: ["k"] } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.kind).toBe("content_query");
    expect(body.backend_type).toBe("third_party_api");
    expect(body.capability_mode).toBe("real");
    expect(body.completion_state).toBe("DONE");
    // D9#4: mock provider 返 raw business {query, candidates}，wrapEnvelope spread 到顶层
    expect(body.candidates).toBeInstanceOf(Array);
    expect(body.candidates[0].track_id).toBe("qq:t1");
    // D9#4: mock provider 收 Authorization: Bearer mock-qq-token（transport 实质验证）
    // backend 用 providerBaseUrl[provider=qq]=mockProvider.url + KIND_PATH[/search]
    // mock provider path 形如 /qq/search → provider=qq
    expect(mockProvider.receivedAuths.qq).toBe("Bearer mock-qq-token");
  });

  it("D9#5: 越权 ^backend:foo + cloud-ext caller → 403 BLOCKED + audit unauthorized (source_not_allowed)", async () => {
    // cloud-ext caller 仅允许 ^cloud: 源；^backend: 是 content-backend internal source，
    // 从 HTTP inbound（cloud-ext caller）进来 → receiveAndAuthorize source_not_allowed →
    // 403 BLOCKED AUTH_FAILED + audit unauthorized（reason 独立字段+traceId 入站透传）
    const r = await fetch(`${backendUrl}/content_query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-secret-handle": "^backend:foo",
        "x-caller-identity": "cloud-ext",
        "x-trace-id": "trace-d9-5",
      },
      body: JSON.stringify({ query: { keywords: ["any"] } }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.completion_state).toBe("BLOCKED");
    expect(body.error_code).toBe("AUTH_FAILED");

    // audit unauthorized：emitUnauthorized 复用 tool_call event_type，reason 为独立结构化字段。
    // M3 可观测 D2：traceId 只使用入站值透传（禁覆盖/不嵌入），不再用老格式
    // traceId() + "|unauthorized:<reason>"（该格式已随 M3 可观测 land 废弃）。
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(auditPath)).toBe(true);
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"reason":"source_not_allowed"');
    // D2 透传：入站 x-trace-id 原样进 audit，不被生成值覆盖
    expect(audit).toContain('"traceId":"trace-d9-5"');
    expect(audit).toContain("secret_handle:^backend:foo");
    expect(audit).toContain('"actor":"cloud-ext"');
  });
});
