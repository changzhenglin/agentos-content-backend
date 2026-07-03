import { describe, it, expect } from "vitest";
import { httpStatus } from "../../src/routes/http-mapping.js";

describe("httpStatus（§4.4 → HTTP 状态码）", () => {
  it("DONE → 200", () => {
    expect(httpStatus("DONE")).toBe(200);
  });

  it("DONE_WITH_CONCERNS → 200（有结果但带 concerns，仍是 2xx）", () => {
    expect(httpStatus("DONE_WITH_CONCERNS")).toBe(200);
  });

  it("BLOCKED → 503", () => {
    expect(httpStatus("BLOCKED")).toBe(503);
  });

  it("NEEDS_CONTEXT → 503（未知状态兜底 5xx）", () => {
    expect(httpStatus("NEEDS_CONTEXT")).toBe(503);
  });
});

// T4 I1 收窄：BLOCKED + client-side block（copyright/region）→ 403；
// BLOCKED + server-side unavailable（backend/auth/无 errorCode）→ 503。
// 注：REGION_RESTRICTED/AUTH_FAILED 在 content-contract.schema.json:13 ErrorCode enum
// 已含（schema 既有），envelope.ts 既有 TS type 缺这两个（M2a 遗留），T6 Step 1 扩 TS
// type 对齐 schema 后可去掉 as any。本 task 不改 schema 不改 envelope.ts enum。
describe("http-mapping I1 收窄", () => {
  it("DONE/DONE_WITH_CONCERNS → 200", () => {
    expect(httpStatus("DONE")).toBe(200);
    expect(httpStatus("DONE_WITH_CONCERNS")).toBe(200);
  });
  it("BLOCKED + COPYRIGHT_RESTRICTED → 403", () => {
    expect(httpStatus("BLOCKED", "COPYRIGHT_RESTRICTED")).toBe(403);
  });
  it("BLOCKED + REGION_RESTRICTED → 403", () => {
    // REGION_RESTRICTED 不在 envelope.ts 既有 TS ErrorCode（M2a 遗留），用字面量透传
    expect(httpStatus("BLOCKED", "REGION_RESTRICTED" as any)).toBe(403);
  });
  it("BLOCKED + BACKEND_UNAVAILABLE → 503", () => {
    expect(httpStatus("BLOCKED", "BACKEND_UNAVAILABLE")).toBe(503);
  });
  it("BLOCKED + AUTH_FAILED → 503", () => {
    expect(httpStatus("BLOCKED", "AUTH_FAILED" as any)).toBe(503);
  });
  it("BLOCKED 无 errorCode 兜底 → 503", () => {
    expect(httpStatus("BLOCKED")).toBe(503);
  });
});
