// third-party-adapter.test.ts — Task 5 测试：fetchThirdParty 全分流。
// 覆盖 REVIEW FOLD 修订（C2 typed Result / P2.5 token_type 真用 / P2.7 catch 分流 / F1 raw business）。
// 7 case：resolve ok+200(bearer) / bearer 路径断言 / query_param 路径断言 / 4xx AUTH_FAILED /
//         resolve 失败 AUTH_FAILED(不泄露) / 5xx BACKEND_UNAVAILABLE / providerHandle 缺失 AUTH_FAILED。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici";
import { fetchThirdParty } from "../../src/content/third-party-adapter.js";
import { createStubSecretStore } from "../../src/auth/secret-store-stub.js";
import { setupMockProvider } from "../fixtures/mock-provider.js";

const BASE = "http://mock-qq.local";
// query_param 路径专用 mock baseUrl（避免与 setupMockProvider 的 Bearer 拦截冲突）。
const BASE_Q = "http://mock-qq-query.local";
// 5xx 专用 mock baseUrl。
const BASE_5XX = "http://mock-5xx.local";

describe("third-party-adapter", () => {
  let agent: MockAgent;
  let fetchSave: typeof globalThis.fetch;
  let mp: ReturnType<typeof setupMockProvider>;
  let queryHitUrl: { url?: string };

  // query_param mock 返回的两种 body 形态（显式 union，对齐 mock-provider fixture 的 reply<> 模式）。
  type QueryMockData =
    | { error_code: string }
    | {
        query: { keywords: string[] };
        candidates: Array<{
          track_id: string;
          title: string;
          artist: string;
          confidence: number;
        }>;
      };

  beforeEach(() => {
    agent = new MockAgent();
    setGlobalDispatcher(agent);
    agent.disableNetConnect();
    fetchSave = globalThis.fetch;
    globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
    mp = setupMockProvider(agent, { qq: BASE });

    // query_param 专用 mock：验 token 出现在 URL ?token= 而非 Authorization header。
    queryHitUrl = { url: undefined };
    agent
      .get(BASE_Q)
      .intercept({ method: "GET", path: /\/search/ })
      .reply<QueryMockData>((req) => {
        queryHitUrl.url = req.path;
        const path = req.path as string;
        const hasToken = /[?&]token=mock-qq-token-q($|&)/.test(path);
        if (hasToken) {
          return {
            statusCode: 200,
            data: {
              query: { keywords: ["k"] },
              candidates: [
                { track_id: "qq:t1", title: "song", artist: "art", confidence: 0.9 },
              ],
            },
          };
        }
        return { statusCode: 401, data: { error_code: "AUTH_FAILED" } };
      });

    // 5xx mock：provider 内部错。
    agent
      .get(BASE_5XX)
      .intercept({ method: "GET", path: /\/search/ })
      .reply(500, { error: "internal" });
  });

  afterEach(() => {
    globalThis.fetch = fetchSave;
  });

  it("resolve ok + mock 200 → third_party_api/real/done，business={query,candidates}，mock 收 Bearer <token>", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "mock-qq-token", token_type: "bearer" },
    });
    const r = await fetchThirdParty({
      kind: "content_query",
      request: { query: { keywords: ["k"] } },
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: BASE,
      traceId: "trace-third-party",
      traceOrigin: "propagated",
    });
    expect(r.backendType).toBe("third_party_api");
    expect(r.capabilityMode).toBe("real");
    expect(r.outcome).toBe("done");
    expect(r.business).toHaveProperty("query");
    expect(r.business).toHaveProperty("candidates");
    expect(mp.receivedAuths.qq).toBe("Bearer mock-qq-token");
    expect(mp.receivedTraceIds.qq).toBe("trace-third-party");
    expect(mp.receivedTraceOrigins.qq).toBe("propagated");
  });

  it("resolve ok + token_type=bearer → mock 收 Authorization: Bearer（非 query_param 路径）", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "mock-qq-token", token_type: "bearer" },
    });
    await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: BASE,
    });
    // bearer 路径：Authorization header 为 Bearer 形式。
    expect(mp.receivedAuths.qq).toBe("Bearer mock-qq-token");
  });

  it("resolve ok + token_type=query_param → mock 收 URL ?token=（token_type 真用）", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "mock-qq-token-q", token_type: "query_param" },
    });
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: BASE_Q,
    });
    expect(r.outcome).toBe("done");
    expect(r.capabilityMode).toBe("real");
    expect(queryHitUrl.url).toMatch(/[?&]token=mock-qq-token-q($|&)/);
  });

  it("resolve ok + mock 401（token=invalid）→ blocked/AUTH_FAILED", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "invalid", token_type: "bearer" },
    });
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: BASE,
    });
    expect(r.outcome).toBe("blocked");
    expect(r.capabilityMode).toBe("unavailable");
    expect(r.errorCode).toBe("AUTH_FAILED");
  });

  it("resolve 失败（handle not found）→ blocked/AUTH_FAILED（不泄露具体内部 error）", async () => {
    const store = createStubSecretStore({});
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: BASE,
    });
    expect(r.outcome).toBe("blocked");
    expect(r.capabilityMode).toBe("unavailable");
    expect(r.errorCode).toBe("AUTH_FAILED");
    // 不泄露 resolve 内部 error（caller_not_allowed/source_not_allowed/
    // provider_binding_mismatch/handle_not_found 全映射 AUTH_FAILED）。
  });

  it("mock 5xx → blocked/BACKEND_UNAVAILABLE", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "mock-qq-token", token_type: "bearer" },
    });
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: BASE_5XX,
    });
    expect(r.outcome).toBe("blocked");
    expect(r.capabilityMode).toBe("unavailable");
    expect(r.errorCode).toBe("BACKEND_UNAVAILABLE");
  });

  it("fetch 网络错（无 intercept）→ blocked/BACKEND_UNAVAILABLE", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "mock-qq-token", token_type: "bearer" },
    });
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: "http://mock-unreachable.local",
    });
    expect(r.outcome).toBe("blocked");
    expect(r.errorCode).toBe("BACKEND_UNAVAILABLE");
  });

  it("providerHandle 缺失（空串）→ blocked/AUTH_FAILED", async () => {
    const store = createStubSecretStore({});
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: BASE,
    });
    expect(r.outcome).toBe("blocked");
    expect(r.errorCode).toBe("AUTH_FAILED");
  });

  // M2d codex P2.2 fix：providerBaseUrl 缺失/空 → blocked/BACKEND_UNAVAILABLE（不 throw 500）。
  // 原先 new URL("") 在 try 外，TypeError 逃出 catch → 进程 unhandled → 非 BACKEND_UNAVAILABLE。
  it("providerBaseUrl 缺失（空串）→ blocked/BACKEND_UNAVAILABLE（不 throw 500，P2.2）", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "mock-qq-token", token_type: "bearer" },
    });
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: "",
    });
    expect(r.outcome).toBe("blocked");
    expect(r.capabilityMode).toBe("unavailable");
    expect(r.errorCode).toBe("BACKEND_UNAVAILABLE");
  });

  // M2d codex P2.2 fix：providerBaseUrl 非法（非 URL）→ blocked/BACKEND_UNAVAILABLE（new URL throw 被 catch）。
  it("providerBaseUrl 非法（非 URL）→ blocked/BACKEND_UNAVAILABLE（new URL throw 被映射，P2.2）", async () => {
    const store = createStubSecretStore({
      "^backend:qq:token_v1": { token: "mock-qq-token", token_type: "bearer" },
    });
    const r = await fetchThirdParty({
      kind: "content_query",
      request: {},
      providerHandle: "^backend:qq:token_v1",
      provider: "qq",
      store,
      caller: "content-backend",
      providerBaseUrl: "not-a-valid-url",
    });
    expect(r.outcome).toBe("blocked");
    expect(r.errorCode).toBe("BACKEND_UNAVAILABLE");
  });
});
