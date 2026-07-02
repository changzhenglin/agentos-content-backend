import { describe, it, expect } from "vitest";
import { syncSchemas } from "../scripts/sync-schemas.js";
import { existsSync, readFileSync } from "node:fs";

const SRC = process.env.AGENTOS_SHARED_PROTOCOLS ?? "../AgentOS/shared-protocols/schemas";

describe("drift", () => {
  it("schemas synced (no drift)", () => {
    expect(() => syncSchemas(SRC, "schemas", { failOnDrift: true })).not.toThrow();
  });

  it("generated/content-contract.ts exists", () => {
    expect(existsSync("generated/content-contract.ts")).toBe(true);
  });

  it("generated type 导出 Track + RuntimeMode（非 any，$ref resolver 解远程 URL）", () => {
    // C3 关键断言：远程 $ref 解析后须生成具体类型，不能退化成 any
    const checkedIn = readFileSync("generated/content-contract.ts", "utf-8");
    expect(checkedIn).toContain("Track");
    expect(checkedIn).toContain("RuntimeMode");
    // 须有 interface/type 定义，而非 export type Track = any
    expect(checkedIn).not.toMatch(/export type Track = any/);
    expect(checkedIn).not.toMatch(/export type RuntimeMode = any/);
  });
});
