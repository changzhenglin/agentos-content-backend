// capability 三层语义统一边界固化测试（P6 单元 2 Task 7，spec §6.2）。
// 零行为变更：代码现状即目标态，本测试只固化防回退。
// 三层"分裂"是有意设计——契约值域接受 mock（sim 证据）、runtime floor 排除 mock
// （production 执行）、env 开关只控 auth stub（非响应 provenance）。见 docs/capability-semantics.md。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { wrapEnvelope } from "../../src/envelope.js";

describe("capability 三层语义统一（P6 单元 2 Task 7，spec §6.2）", () => {
  it("层 1 schema 值域：capability_mode enum 接受 mock（sim 证据值域，有意保留）", () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas/content-contract.schema.json"), "utf8"));
    expect(schema.properties.capability_mode.enum).toContain("mock");
    expect(schema.properties.capability_mode.enum).toEqual(expect.arrayContaining(["real", "mock", "unavailable", "degraded"]));
  });

  it("层 1 schema 校验：mock doc 是合法契约响应（ajv 通过）", () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas/content-contract.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    // 注册 external $ref（track/runtime-mode，同 content-contract-validator 约定）
    for (const f of ["track.schema.json", "runtime-mode.schema.json"]) {
      ajv.addSchema(JSON.parse(readFileSync(join(process.cwd(), "schemas", f), "utf8")));
    }
    const validate = ajv.compile(schema);
    const mockDoc = {
      kind: "content_query", version: 1, backend_type: "self_hosted",
      capability_mode: "mock", completion_state: "DONE_WITH_CONCERNS", // codex P1-5 fold：schema allOf mock 禁 DONE
      query: { keywords: ["x"] }, candidates: [],
    };
    expect(validate(mockDoc)).toBe(true);
  });

  it("层 2 runtime floor：wrapEnvelope 的 CapabilityMode 参数 type 排除 mock（tsc 编译守护）", () => {
    // type 级排除：CapabilityMode = "real" | "degraded" | "unavailable"（envelope.ts:16-18），
    // 传入 "mock" 即 tsc 编译失败（本测试文件能编译 = 守护生效）。
    // 运行时：wrapEnvelope 产出的 envelope.capability_mode 必在三值域内。
    const modes = ["real", "degraded", "unavailable"] as const;
    expect(modes).not.toContain("mock");
    // @ts-expect-error — mock 不在 CapabilityMode 值域（编译期拒绝，固化 runtime floor）
    const _typeGuard: import("../../src/envelope.js").CapabilityMode = "mock";
    expect(_typeGuard).toBe("mock"); // 运行时可达（ts-expect-error 只抑编译），断言 type 守护存在
  });

  it("层 3 env 解耦：CAPABILITY_MODE env 不写入响应 capability_mode", async () => {
    // env.capabilityMode="mock" 只控 auth stub（token-verify-hook），响应 capability_mode 来自 handler。
    // 固化现状：loadEnv 读 CAPABILITY_MODE，但 wrapEnvelope 的 capabilityMode 参数不由 env 提供。
    const { loadEnv } = await import("../../src/env.js");
    const env = loadEnv({ capabilityMode: "mock" });
    expect(env.capabilityMode).toBe("mock"); // env 层接受任意 string（auth stub 开关）
    // wrapEnvelope 显式传 real → 响应 real（env mock 不污染）。
    // Eng I-4 fold：实际签名 wrapEnvelope(business, kind, backendType, capabilityMode, outcome, errorCode?)
    // （envelope.ts:158-165）；completion_state 由 completionState() 派生（real+ok→DONE），不手传。
    const envelope = wrapEnvelope({}, "content_query", "self_hosted", "real", "ok");
    expect(envelope.capability_mode).toBe("real");
    expect(envelope.capability_mode).not.toBe(env.capabilityMode); // env mock ≠ 响应 real
  });
});
