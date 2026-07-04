import { describe, it, expect } from "vitest";
import { syncSchemas } from "../scripts/sync-schemas.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthConfig } from "../src/policy/policy-store.js";

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

  // M2d Task 3: PolicyEnvelope.payload.auth_config shape 对齐 AgentOS ops-config.schema.json
  // 的 auth_config def（option A：单 string token_ref，不改 AgentOS 仓）。
  it("PolicyEnvelope.auth_config shape 对齐 ops-config.schema.json auth_config def", () => {
    const schemaPath = join(SRC, "ops-config.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    const authDef = schema.$defs.auth_config;
    expect(authDef).toBeDefined();
    expect(authDef.type).toBe("object");
    expect(authDef.required).toEqual(["token_source", "token_ref"]);
    expect(authDef.additionalProperties).toBe(false);

    // token_source enum 值对齐
    const tokenSourceEnum = authDef.properties.token_source.enum;
    expect(tokenSourceEnum).toEqual(["ops_managed", "backend_issued"]);

    // token_ref type 对齐
    expect(authDef.properties.token_ref.type).toBe("string");

    // per-source pattern 对齐：backend_issued → ^backend:[a-zA-Z0-9_-]+$
    const backendIssuedBranch = authDef.allOf.find(
      (b: any) =>
        b.if?.properties?.token_source?.const === "backend_issued",
    );
    expect(backendIssuedBranch).toBeDefined();
    expect(backendIssuedBranch.then.properties.token_ref.pattern).toBe(
      "^backend:[a-zA-Z0-9_-]+$",
    );

    // 静态校验 AuthConfig 类型可承载 schema 约束（编译期断言）
    const cfg: AuthConfig = {
      token_source: "backend_issued",
      token_ref: "backend:qq-token_v1",
    };
    expect(cfg.token_source).toBe("backend_issued");
    expect(cfg.token_ref).toMatch(/^backend:[a-zA-Z0-9_-]+$/);
  });
});
