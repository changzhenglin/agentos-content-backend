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
