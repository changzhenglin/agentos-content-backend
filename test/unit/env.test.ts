import { describe, it, expect, afterEach } from "vitest";
import { loadEnv } from "../../src/env.js";

describe("env", () => {
  afterEach(() => { delete process.env.AUDIT_SINK_PATH; });

  it("loadEnv 默认 auditSinkPath 空串（I2 fix：不默认 .audit.jsonl，消除 CLI 常开 audit sink 副作用）", () => {
    delete process.env.AUDIT_SINK_PATH;
    const env = loadEnv();
    expect(env.auditSinkPath).toBe("");
  });

  it("AUDIT_SINK_PATH 显式设置 → loadEnv 读取（opt-in 落 audit）", () => {
    process.env.AUDIT_SINK_PATH = "/tmp/audit.jsonl";
    const env = loadEnv();
    expect(env.auditSinkPath).toBe("/tmp/audit.jsonl");
  });
});
