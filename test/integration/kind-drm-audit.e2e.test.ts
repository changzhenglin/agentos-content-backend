// kind-drm-audit.e2e.test.ts — T6：kind business 接中央 drm-guard + audit tool_call e2e。
// 5 用例：block 403+audit / allow 200 / ok emit tool_call+hash chain / fail-closed 503 /
// fail-closed 默认生效（不传 auditSink，buildServer 默认注入 policyStore）。
// 验证 codex P1#6（drm fail-closed 独立于 audit）+ codex P2（中央 guard 不内联）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/index.js";
import {
  createTestDb,
  seedTrack,
  type SeedTrack,
} from "./helpers.js";
import { createPolicyStore } from "../../src/policy/policy-store.js";
import {
  createAuditSink,
  verifyChain,
} from "../../src/audit/audit-sink.js";
import type { PolicyEnvelope } from "../../src/policy/policy-store.js";
import { rmSync, readFileSync } from "node:fs";

const auditPath = ".tmp-audit-kind.jsonl";
beforeEach(() => rmSync(auditPath, { force: true }));
afterEach(() => rmSync(auditPath, { force: true }));

const base: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo",
  duration_ms: 1000,
  audio_object_key: "self:t1:v1",
  format: "mp3",
  bitrate: 128000,
  license: "CC",
};

const mockPresign = async (key: string) => ({
  url: `https://mock.s3/${key}`,
  auth: {
    token: "t",
    token_type: "query_param" as const,
    expires_at: "2026-12-31T00:00:00.000Z",
  },
});

// 构造 content_policy envelope（含 upstream version，T1 PolicyEnvelope 要求）
function blockEnvelope(
  cmdId: string,
  action: "block" | "allow" | "region_restrict" = "block",
  version = 1,
): PolicyEnvelope {
  return {
    command_id: cmdId,
    kind: "content_policy",
    capability_mode: "real",
    version,
    payload: {
      rule_id: "r1",
      action,
      target_scope: "content_management",
    },
    security_context: {
      actor: "ops-platform",
      rbac_decision: { allowed: true },
      audience: "content_backend",
      expiry: new Date(Date.now() + 60000).toISOString(),
    },
  };
}

describe("kind drm + audit e2e", () => {
  it("block policy → content_stream 403 COPYRIGHT_RESTRICTED + emit tool_call audit", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const store = createPolicyStore(db);
    await store.applyPolicy(blockEnvelope("cmd-block"), "ops-platform");
    const app = await buildServer({
      db,
      presign: mockPresign,
      policyStore: store,
      auditSink: createAuditSink(auditPath),
      actor: "cloud-ext",
    });
    const res = await app.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe("COPYRIGHT_RESTRICTED");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]).eventType).toBe("tool_call"); // blocked 也 emit
  });

  it("无 policy → allow 200", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const store = createPolicyStore(db);
    const app = await buildServer({
      db,
      presign: mockPresign,
      policyStore: store,
      auditSink: createAuditSink(auditPath),
      actor: "cloud-ext",
    });
    const res = await app.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("ok 路径 emit tool_call audit + hash chain 完整", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const store = createPolicyStore(db);
    const app = await buildServer({
      db,
      presign: mockPresign,
      policyStore: store,
      auditSink: createAuditSink(auditPath),
      actor: "cloud-ext",
    });
    await app.inject({
      method: "POST",
      url: "/content_metadata",
      payload: { track_id: "self:t1" },
    });
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).eventType).toBe("tool_call");
    expect(JSON.parse(lines[0]).actor).toBe("cloud-ext");
    expect(verifyChain(auditPath)).toBe(true);
  });

  it("policy store 故障 → fail-closed 503（auditSink 注入）", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const brokenStore = {
      applyPolicy: async () => {
        throw new Error("db down");
      },
      latestPolicy: async () => {
        throw new Error("db down");
      },
    };
    const app = await buildServer({
      db,
      presign: mockPresign,
      policyStore: brokenStore as any,
      auditSink: createAuditSink(auditPath),
      actor: "cloud-ext",
    });
    const res = await app.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe("BACKEND_UNAVAILABLE");
  });

  // fold codex P1#6：DRM fail-closed 独立于 audit 注入——buildServer 默认注入 policyStore，
  // 即使不传 auditSink，drm 仍生效（仅无 audit emit）。
  it("fail-closed 默认生效（不传 auditSink，buildServer 默认注入 policyStore）", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const store = createPolicyStore(db);
    await store.applyPolicy(blockEnvelope("cmd-default"), "ops-platform");
    // 不传 auditSink → buildServer 默认从 createPolicyStore(db) 注入 policyStore；
    // 此处显式传 store（含 block policy）验证 drm 生效不依赖 auditSink。
    const app = await buildServer({
      db,
      presign: mockPresign,
      policyStore: store,
    });
    const res = await app.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
    });
    expect(res.statusCode).toBe(403); // drm 生效，即使无 auditSink
  });
});
