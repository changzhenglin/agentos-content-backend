import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../integration/helpers.js";
import { createPolicyStore } from "../../src/policy/policy-store.js";
import type { PolicyEnvelope, AuthConfig } from "../../src/policy/policy-store.js";

describe("policy-store", () => {
  let db: any;
  beforeEach(async () => {
    db = await createTestDb();
  });

  // envelope 含 upstream version 字段（fold codex P1#2 stale 检测）
  function envelope(
    ruleId: string,
    action: any,
    commandId: string,
    upstreamVersion: number,
    authConfig?: AuthConfig,
  ) {
    return {
      command_id: commandId,
      kind: "content_policy" as const,
      capability_mode: "real",
      version: upstreamVersion, // producer 侧 monotonic version
      payload: {
        rule_id: ruleId,
        action,
        target_scope: "content_management",
        ...(authConfig ? { auth_config: authConfig } : {}),
      },
      security_context: {
        actor: "ops-platform",
        rbac_decision: { role: "admin", allowed: true },
        audience: "content_backend",
        expiry: new Date(Date.now() + 60000).toISOString(),
      },
    };
  }

  it("applyPolicy 首次应用 version=1", async () => {
    const store = createPolicyStore(db);
    const r = await store.applyPolicy(
      envelope("r1", "block", "cmd-1", 1),
      "ops-platform",
    );
    expect(r).toEqual({ applied: true, version: 1 });
  });

  it("command_id 重复幂等 applied=false", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform");
    const r = await store.applyPolicy(
      envelope("r1", "block", "cmd-1", 1),
      "ops-platform",
    );
    expect(r.applied).toBe(false);
    expect(r.version).toBe(1);
  });

  it("新 upstream version 应用，旧标 superseded", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform"); // v1
    const r2 = await store.applyPolicy(
      envelope("r1", "allow", "cmd-2", 2),
      "ops-platform",
    ); // v2
    expect(r2).toEqual({ applied: true, version: 2 });
    const latest = await store.latestPolicy();
    expect(latest.length).toBe(1);
    expect(latest[0].action).toBe("allow");
    const { rows } = await db.query(
      "SELECT superseded_by FROM content_policy WHERE version=1",
    );
    expect(rows[0].superseded_by).toBe(2);
  });

  it("stale upstream version（旧后到）→ applied:false superseded:true（fold codex P1#2）", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "allow", "cmd-2", 2), "ops-platform"); // v2 先到
    const r = await store.applyPolicy(
      envelope("r1", "block", "cmd-1", 1),
      "ops-platform",
    ); // v1 后到
    expect(r).toEqual({ applied: false, version: 2, superseded: true });
    const latest = await store.latestPolicy();
    expect(latest.length).toBe(1);
    expect(latest[0].action).toBe("allow"); // 仍是 v2
  });

  it("不同 ruleId 并存于 latestPolicy", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform");
    await store.applyPolicy(envelope("r2", "allow", "cmd-2", 1), "ops-platform");
    const latest = await store.latestPolicy();
    expect(latest.length).toBe(2);
  });

  // M2d Task 3: auth_config（option A，单 string token_ref，对齐 ops-config.schema.json）
  // M2d codex P2.1 fix：fixture 对齐 C1 fix 生产值 + fixed schema pattern（带 caret ^backend:...）。
  const authCfg: AuthConfig = {
    token_source: "backend_issued",
    token_ref: "^backend:qq-token_v1", // 单段 ^backend:<provider>-<id>，fit ^\^backend:[a-zA-Z0-9_-]+$
  };

  it("applyPolicy 含 auth_config → latestPolicy 返 auth_config（option A 单 string）", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(
      envelope("qq", "allow", "cmd-auth-1", 1, authCfg),
      "ops-platform",
    );
    const latest = await store.latestPolicy();
    expect(latest.length).toBe(1);
    expect(latest[0].envelope.payload).toHaveProperty("auth_config");
    expect(latest[0].envelope.payload.auth_config).toEqual(authCfg);
    expect(latest[0].envelope.payload.auth_config?.token_ref).toBe(
      "^backend:qq-token_v1",
    );
  });

  it("applyPolicy 无 auth_config → latestPolicy payload 无 auth_config（backward compat 不崩）", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(
      envelope("r1", "block", "cmd-noauth-1", 1),
      "ops-platform",
    );
    const latest = await store.latestPolicy();
    expect(latest.length).toBe(1);
    expect(latest[0].envelope.payload).not.toHaveProperty("auth_config");
  });
});
