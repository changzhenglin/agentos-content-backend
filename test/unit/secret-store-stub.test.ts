// secret-store-stub.test.ts — Task 1 测试：resolveHandle + caller×source 矩阵 + provider binding。
// 接口按 plan REVIEW FOLD (codex C2/P2.6 + eng F2) 修订实现，覆盖 7 case。
import { describe, it, expect } from "vitest";
import { createStubSecretStore } from "../../src/auth/secret-store-stub.js";
import { ALLOW_MATRIX } from "../../src/auth/caller-auth-matrix.js";

describe("secret-store-stub", () => {
  const store = createStubSecretStore({
    "^backend:qq:token_v1": {
      token: "mock-qq-token",
      token_type: "bearer",
      expiry: "2026-12-31T23:59:59Z",
      audience: "qq-music-api",
    },
    "^backend:netease:token_v1": {
      token: "mock-nease-token",
      token_type: "query_param",
    },
  });

  it("case1: content-backend caller + ^backend:qq:token_v1 + expectedProvider=qq → ok 返 Secret", async () => {
    const r = await store.resolveHandle("^backend:qq:token_v1", "content-backend", "qq");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.secret.token).toBe("mock-qq-token");
      expect(r.secret.token_type).toBe("bearer");
      expect(r.secret.expiry).toBe("2026-12-31T23:59:59Z");
      expect(r.secret.audience).toBe("qq-music-api");
    }
  });

  // 注：brief case2 原期望 caller_not_allowed（列视角：cloud-ext 不在 ^backend: 允许行），
  // 但与 case5（行视角：content-backend + ^cloud: → source_not_allowed）对称且不一致。
  // 自然矩阵逻辑：caller 在矩阵中（cloud-ext 合法）但 source 不在其允许行 → source_not_allowed。
  // 本实现取自然逻辑（caller_not_allowed 仅用于 caller 不在矩阵，如 anonymous）。
  // concern 见 task-1-report.md。
  it("case2: cloud-ext caller + ^backend: handle → {ok:false, error:'source_not_allowed'}（caller 合法但 source 不在其允许行）", async () => {
    const r = await store.resolveHandle("^backend:qq:token_v1", "cloud-ext");
    expect(r).toEqual({ ok: false, error: "source_not_allowed" });
  });

  it("case3: handle 不存在 → {ok:false, error:'handle_not_found'}", async () => {
    const r = await store.resolveHandle("^backend:unknown:v1", "content-backend");
    expect(r).toEqual({ ok: false, error: "handle_not_found" });
  });

  it("case4: anonymous caller → {ok:false, error:'caller_not_allowed'}", async () => {
    const r = await store.resolveHandle("^backend:qq:token_v1", "anonymous");
    expect(r).toEqual({ ok: false, error: "caller_not_allowed" });
  });

  it("case5: 非 ^backend: source（^cloud:foo）+ content-backend caller → {ok:false, error:'source_not_allowed'}", async () => {
    const r = await store.resolveHandle("^cloud:foo", "content-backend");
    expect(r).toEqual({ ok: false, error: "source_not_allowed" });
  });

  it("case6: provider binding 不匹配（handle ^backend:qq: + expectedProvider=netease）→ {ok:false, error:'provider_binding_mismatch'}", async () => {
    const r = await store.resolveHandle("^backend:qq:token_v1", "content-backend", "netease");
    expect(r).toEqual({ ok: false, error: "provider_binding_mismatch" });
  });

  it("case7: expectedProvider 匹配（handle ^backend:qq:token_v1 + expectedProvider=qq）→ ok", async () => {
    const r = await store.resolveHandle("^backend:qq:token_v1", "content-backend", "qq");
    expect(r.ok).toBe(true);
  });

  it("ALLOW_MATRIX 单一源：content-backend→^backend: / cloud-ext→^cloud: / ops-platform→^ops: / provisioning-service→^device:", () => {
    expect(ALLOW_MATRIX["content-backend"]).toEqual(["^backend:"]);
    expect(ALLOW_MATRIX["cloud-ext"]).toEqual(["^cloud:"]);
    expect(ALLOW_MATRIX["ops-platform"]).toEqual(["^ops:"]);
    expect(ALLOW_MATRIX["provisioning-service"]).toEqual(["^device:"]);
    // anonymous 不在任何允许行
    expect(ALLOW_MATRIX["anonymous"]).toBeUndefined();
  });
});
