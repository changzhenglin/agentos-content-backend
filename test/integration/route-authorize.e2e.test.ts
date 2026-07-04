// route-authorize.e2e.test.ts — Task 6 集成测试：5 kind route 接入
//   X-Caller-Identity + receiveAndAuthorize + provider 分支（third_party→adapter）。
//
// 3 case（按 plan §Task 6 验收标准）：
//   1. cloud-ext caller + ^cloud:foo handle → 200 self_hosted DONE + audit JSONL 记 secret_handle
//   2. cloud-ext caller + ^backend:foo handle → 403 BLOCKED + audit unauthorized（source_not_allowed）
//   3. content_policy push（rule_id=qq, action=allow, auth_config.token_ref=^backend:qq-token_v1）
//      + request provider=qq + PROVIDER_AVAILABLE 默认 true → 200 third_party_api/real DONE
//      + mock provider 收 Bearer mock-qq-token
//
// 复用 server.e2e.test.ts 模式（buildServer + inject + pg-mem ContentDb）。
// third_party case 复用 third-party-adapter.test.ts 模式（undici MockAgent + mock-provider fixture）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/index.js";
import { createTestDb, seedTrack, type SeedTrack } from "./helpers.js";
import { createPolicyStore, type PolicyEnvelope } from "../../src/policy/policy-store.js";
import { createAuditSink } from "../../src/audit/audit-sink.js";
import { createStubSecretStore } from "../../src/auth/secret-store-stub.js";
import { setupMockProvider } from "../fixtures/mock-provider.js";

const base: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo",
  album: "Dawn",
  duration_ms: 1000,
  audio_object_key: "self:t1:v1",
  format: "mp3",
  bitrate: 128000,
  license: "CC",
};

// mock provider base url（per-provider endpoint，option A）
const QQ_BASE = "http://mock-qq.local";

function mkPolicyEnvelope(
  ruleId: string,
  action: "allow" | "block" | "region_restrict",
  tokenRef?: string,
): PolicyEnvelope {
  return {
    command_id: `cmd_${ruleId}_${Math.random().toString(36).slice(2)}`,
    kind: "content_policy",
    capability_mode: "real",
    version: 1,
    payload: {
      rule_id: ruleId,
      action,
      target_scope: "cn",
      ...(tokenRef
        ? {
            auth_config: {
              token_source: "backend_issued" as const,
              token_ref: tokenRef,
            },
          }
        : {}),
    },
    security_context: {
      actor: "ops-platform",
      rbac_decision: {},
      audience: "content-backend",
      expiry: "2026-12-31T00:00:00Z",
    },
  };
}

describe("route-authorize e2e (Task 6)", () => {
  let agent: MockAgent;
  let fetchSave: typeof globalThis.fetch;
  let mp: ReturnType<typeof setupMockProvider>;
  let auditDir: string;
  let auditPath: string;

  beforeEach(() => {
    // undici MockAgent 全局拦截（third_party case 用）
    agent = new MockAgent();
    setGlobalDispatcher(agent);
    agent.disableNetConnect();
    fetchSave = globalThis.fetch;
    globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
    mp = setupMockProvider(agent, { qq: QQ_BASE });
    auditDir = mkdtempSync(join(tmpdir(), "m2d-audit-"));
    auditPath = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    globalThis.fetch = fetchSave;
    rmSync(auditDir, { recursive: true, force: true });
  });

  it("case 1: cloud-ext caller + ^cloud:foo handle → 200 self_hosted DONE + audit JSONL 记 secret_handle", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const policyStore = createPolicyStore(db);
    const auditSink = createAuditSink(auditPath);
    const app = await buildServer({
      db,
      policyStore,
      auditSink,
      actor: "anonymous-service",
    });

    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: {
        "x-secret-handle": "^cloud:foo",
        "x-caller-identity": "cloud-ext",
        "x-trace-id": "trace-case-1",
      },
      payload: { query: { keywords: ["Sunrise"] } },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe("content_query");
    expect(body.backend_type).toBe("self_hosted");
    expect(body.completion_state).toBe("DONE");

    // audit JSONL 记 secret_handle:^cloud:foo（receiveAndAuthorize authorized 路径 emit）
    const auditContent = readFileSync(auditPath, "utf8");
    expect(auditContent).toContain("secret_handle:^cloud:foo");
    expect(auditContent).toContain("trace-case-1");
  });

  it("case 2: cloud-ext caller + ^backend:foo handle → 403 BLOCKED + audit unauthorized (source_not_allowed)", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const policyStore = createPolicyStore(db);
    const auditSink = createAuditSink(auditPath);
    const app = await buildServer({
      db,
      policyStore,
      auditSink,
      actor: "anonymous-service",
    });

    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: {
        "x-secret-handle": "^backend:foo",
        "x-caller-identity": "cloud-ext",
        "x-trace-id": "trace-case-2",
      },
      payload: { query: { keywords: ["Sunrise"] } },
    });

    expect(r.statusCode).toBe(403);
    const body = r.json();
    expect(body.completion_state).toBe("BLOCKED");
    expect(body.error_code).toBe("AUTH_FAILED");

    // audit unauthorized：reason=source_not_allowed 进 traceId 语义
    const auditContent = readFileSync(auditPath, "utf8");
    expect(auditContent).toContain("unauthorized:source_not_allowed");
    expect(auditContent).toContain("secret_handle:^backend:foo");
  });

  it("case 3: content_policy push (rule_id=qq, action=allow, token_ref=^backend:qq-token_v1) + request provider=qq → 200 third_party_api/real DONE + mock 收 Bearer", async () => {
    const db = createTestDb();
    const policyStore = createPolicyStore(db);
    // push content_policy：rule_id=qq（option A：rule_id 即 provider 名），action=allow，
    // auth_config.token_ref=^backend:qq-token_v1（hyphen 格式，对齐 option A 生产 handle +
    // ops-config.schema.json pattern ^backend:[a-zA-Z0-9_-]+$，无冒号 → secret-store-stub
    // providerSegment 返 undefined → binding 校验 skip，provider 绑定靠 rule_id=qq lookup）
    await policyStore.applyPolicy(
      mkPolicyEnvelope("qq", "allow", "^backend:qq-token_v1"),
      "ops-platform",
    );

    const secretStore = createStubSecretStore({
      "^backend:qq-token_v1": { token: "mock-qq-token", token_type: "bearer" },
    });
    const auditSink = createAuditSink(auditPath);
    const app = await buildServer({
      db,
      policyStore,
      auditSink,
      secretStore,
      providerBaseUrl: { qq: QQ_BASE },
      actor: "anonymous-service",
    });

    const r = await app.inject({
      method: "POST",
      url: "/content_query",
      headers: {
        "x-caller-identity": "cloud-ext",
        "x-trace-id": "trace-case-3",
      },
      payload: { provider: "qq", query: { keywords: ["k"] } },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe("content_query");
    expect(body.backend_type).toBe("third_party_api");
    expect(body.capability_mode).toBe("real");
    expect(body.completion_state).toBe("DONE");
    // mock provider 返 raw business {query, candidates}，wrapEnvelope spread 到顶层
    expect(body.candidates).toBeInstanceOf(Array);
    expect(body.candidates[0].track_id).toBe("qq:t1");
    // mock provider 收 Bearer mock-qq-token（transport 实质验证 D9）
    expect(mp.receivedAuths.qq).toBe("Bearer mock-qq-token");
  });
});
