// onsend-full-validate.test.ts — I2 delta：onSend 全量契约校验恢复（error_code 定向 skip 移除）。
// AJV compile 路径与 src/index.ts 模块级 compile 同构（schemas/ 本地副本 + 外部 $ref 注册）。
import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { readFileSync } from "node:fs";

const NEW_CODES = [
  "INVALID_TOKEN",
  "DEVICE_NOT_BOUND",
  "JWKS_UNAVAILABLE",
  "LOOKUP_UNAVAILABLE",
  "INVALID_ENVELOPE",
] as const;

function compileValidate() {
  const contentSchema = JSON.parse(readFileSync("schemas/content-contract.schema.json", "utf8"));
  const trackSchema = JSON.parse(readFileSync("schemas/track.schema.json", "utf8"));
  const runtimeModeSchema = JSON.parse(readFileSync("schemas/runtime-mode.schema.json", "utf8"));
  const ajv = new Ajv({ allErrors: true, validateSchema: false });
  ajv.addSchema(trackSchema);
  ajv.addSchema(runtimeModeSchema);
  return ajv.compile(contentSchema);
}

describe("I2：content-contract enum 含 token 校验 5 码（本地副本）", () => {
  it("BLOCKED + unavailable + 5 码逐一 validate 通过（token-verify-hook 响应形状）", () => {
    const validate = compileValidate();
    for (const code of NEW_CODES) {
      const doc = {
        kind: "content_query", version: 1, backend_type: "self_hosted",
        capability_mode: "unavailable", completion_state: "BLOCKED",
        error_code: code, runtime_mode: "remote-service",
      };
      expect(validate(doc), `${code} 应 schema-valid`).toBe(true);
    }
  });

  it("5 码在 DONE 下仍被拒（allOf DONE→error_code:false 规则不变）", () => {
    const validate = compileValidate();
    for (const code of NEW_CODES) {
      const doc = {
        kind: "content_query", version: 1, backend_type: "self_hosted",
        capability_mode: "real", completion_state: "DONE",
        error_code: code,
        query: { keywords: ["x"] }, candidates: [],
      };
      expect(validate(doc), `DONE + ${code} 应被拒`).toBe(false);
    }
  });
});

describe("I2：onSend 无 error_code 定向 skip（结构锁定，spec §6.2 第 4 项）", () => {
  // 运行时判别形状（畸形+新码→500）不可达：服务器不产出该形状响应；
  // 结构锁定 = skip 标识符不存在 + 无状态码门控 skip 分支 + validate-throw 存在。
  const src = readFileSync("src/index.ts", "utf8");

  it("skip 标识符与状态码门控分支不存在", () => {
    expect(src).not.toContain("NEW_TOKEN_VERIFY_CODES");
    // 旧 skip 结构：statusCode >= 400 附近的 skip 赋值/判定
    expect(src).not.toMatch(/statusCode\s*>=\s*400[\s\S]{0,300}skip/);
    expect(src).not.toMatch(/\bskip\s*=\s*true/);
  });

  it("onSend 全量 validate-throw 存在", () => {
    expect(src).toContain('addHook("onSend"');
    expect(src).toContain("content-contract validate fail");
  });
});
