import { describe, it, expect } from "vitest";
import { ALLOW_MATRIX, ALLOWED_BACKEND_TYPES, authorizeBackendType } from "../../src/auth/caller-auth-matrix.js";

describe("caller-auth-matrix (M3 阶段2 device-hub 扩展)", () => {
  it("device-hub 在 ALLOW_MATRIX（无 source 域，self_hosted 路径无 handle）", () => {
    expect(ALLOW_MATRIX["device-hub"]).toEqual([]);
  });
  it("cloud-ext 仍允许 ^cloud: source", () => {
    expect(ALLOW_MATRIX["cloud-ext"]).toContain("^cloud:");
  });
  it("device-hub 只允许 self_hosted backend_type", () => {
    expect(ALLOWED_BACKEND_TYPES["device-hub"]).toEqual(["self_hosted"]);
  });
  it("cloud-ext 允许 self_hosted + third_party_api", () => {
    expect(ALLOWED_BACKEND_TYPES["cloud-ext"]).toEqual(["self_hosted", "third_party_api"]);
  });
  it("authorizeBackendType: device-hub + self_hosted → authorized", () => {
    expect(authorizeBackendType("device-hub", "self_hosted")).toEqual({ authorized: true });
  });
  it("authorizeBackendType: device-hub + third_party_api → 拒绝（防越权）", () => {
    const r = authorizeBackendType("device-hub", "third_party_api");
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("backend_type_not_allowed");
  });
  it("authorizeBackendType: cloud-ext + third_party_api → authorized", () => {
    expect(authorizeBackendType("cloud-ext", "third_party_api")).toEqual({ authorized: true });
  });
  it("authorizeBackendType: anonymous + self_hosted → authorized（self_hosted 不校验 caller，与 !handle 短路一致）", () => {
    expect(authorizeBackendType("anonymous", "self_hosted")).toEqual({ authorized: true });
  });
  it("authorizeBackendType: anonymous + third_party_api → 拒绝（third_party 校验 caller）", () => {
    expect(authorizeBackendType("anonymous", "third_party_api").authorized).toBe(false);
  });
});
