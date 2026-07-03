// drm-rule-engine.test.ts — T2 per-kind drm 检查 + region-config（spec §8.2 + §4.5 D10）。
import { describe, it, expect } from "vitest";
import { checkDrm } from "../../src/policy/drm-rule-engine.js";
import type { PolicyRecord } from "../../src/policy/policy-store.js";

function policy(ruleId: string, action: any): PolicyRecord {
  return {
    ruleId,
    action,
    targetScope: "content_management",
    version: 1,
    envelope: {} as any,
    receivedAt: "",
    supersededBy: null,
  };
}

describe("drm-rule-engine", () => {
  it("block 命中 track → 全 kind BLOCKED", () => {
    // block policy payload 不含 track_id（target_scope=content_management 全局）；
    // 简化：block policy 命中所有 track（sim 闭环够，spec §8.2 block 全 kind 全 track）。
    const d = checkDrm(
      [policy("r1", "block")],
      "content_stream",
      "self:t1",
      "cn",
      "cn",
    );
    expect(d).toEqual({ action: "block", ruleId: "r1" });
  });

  it("allow → null（放行）", () => {
    const d = checkDrm(
      [policy("r1", "allow")],
      "content_stream",
      "self:t1",
      "cn",
      "cn",
    );
    expect(d).toBeNull();
  });

  it("region_restrict + region 不符 → REGION_RESTRICTED", () => {
    const d = checkDrm(
      [policy("r1", "region_restrict")],
      "content_stream",
      "self:t1",
      "us",
      "cn",
    );
    expect(d).toEqual({ action: "region_restrict", ruleId: "r1" });
  });

  it("region_restrict + region 符合 → null（放行）", () => {
    const d = checkDrm(
      [policy("r1", "region_restrict")],
      "content_stream",
      "self:t1",
      "cn",
      "cn",
    );
    expect(d).toBeNull();
  });

  it("空 policy 集 → null（放行）", () => {
    const d = checkDrm([], "content_stream", "self:t1", "cn", "cn");
    expect(d).toBeNull();
  });

  it("per-kind：query 也受 block 约束", () => {
    const d = checkDrm(
      [policy("r1", "block")],
      "content_query",
      "self:t1",
      "cn",
      "cn",
    );
    expect(d).toEqual({ action: "block", ruleId: "r1" });
  });
});
