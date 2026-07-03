import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../integration/helpers.js";
import { createPolicyStore } from "../../src/policy/policy-store.js";

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
  ) {
    return {
      command_id: commandId,
      kind: "content_policy" as const,
      capability_mode: "real",
      version: upstreamVersion, // producer 侧 monotonic version
      payload: { rule_id: ruleId, action, target_scope: "content_management" },
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
});
