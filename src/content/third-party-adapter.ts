// third-party-adapter.ts — third_party_api path：查 handle → resolveHandle → 调 provider。
// fold M2d D9：transport 实质验证（adapter 真用 creds 调 provider）。
//
// REVIEW FOLD 修订（覆盖 task-brief）：
//  - C2/P2.5：resolveHandle 返 typed ResolveResult（不 throw stringly），adapter 处理 {ok:true,secret}
//    / {ok:false,error} 两态；secret.token_type 真用（bearer→Authorization: Bearer header；
//    query_param→URL ?token= query），非 hardcoded Bearer。
//  - P2.7 catch 分流精神（非字面 validateContract on provider body）：mock provider 不返
//    content-contract envelope（返 raw business 或 {error_code}），故 adapter 不对 provider body
//    跑 validateContract，而是按 status 分流：200→raw business；4xx→提取 error_code；5xx→BACKEND_UNAVAILABLE。
//  - F1 raw business：200 返 business = raw provider body（{query,candidates}），非 envelope；
//    route 的 wrapEnvelope 会 `...business` spread。
//  - resolve 失败（ok:false）全映射 AUTH_FAILED，不泄露 caller_not_allowed/source_not_allowed/
//    provider_binding_mismatch/handle_not_found 具体内部 error 给 provider/下游。
//  - P2.6 provider binding：resolveHandle 第三参 expectedProvider 传 opts.provider，防
//    providerHandle 指向错误 provider 的 handle 致跨 provider 凭证泄漏。
//  - option A：handle 单段 ^backend:qq:token_v1，adapter 按 provider 参数 + providerHandle resolve。

import type { SecretStore } from "../auth/secret-store-stub.js";

export interface FetchThirdPartyOpts {
  /** 业务 kind：content_query | content_match | content_stream | content_lyrics | content_metadata */
  kind: string;
  /** 业务请求体（透传给 provider；sim mock 不解析，真 provider 按需序列化） */
  request: Record<string, unknown>;
  /** token_ref from content_policy auth_config（如 ^backend:qq:token_v1），route 查得传入 */
  providerHandle: string;
  /** provider 名（qq | netease | kugou），用于 provider binding 校验与 base url 路由 */
  provider: string;
  /** secret store（sim stub，真 store defer M3-pre SDD） */
  store: SecretStore;
  /** 调用 principal，内部 adapter 用 "content-backend"（不从 HTTP 接受） */
  caller: string;
  /** mock provider endpoint base url */
  providerBaseUrl: string;
  /** 入站 trace，第三方 HTTP 尽力透传；缺失时不补建。 */
  traceId?: string;
  /** 入站 trace 来源，和 trace 一并透传。 */
  traceOrigin?: "generated" | "propagated";
  /** 调用结果观测回调（由 HTTP 层接入 prom-client）。 */
  observeCall?: (status: string, durationSeconds: number) => void;
}

export interface ThirdPartyResult {
  outcome: "done" | "blocked";
  backendType: "third_party_api";
  capabilityMode: "real" | "unavailable";
  /** AUTH_FAILED | BACKEND_UNAVAILABLE（blocked 时必有） */
  errorCode?: string;
  /** raw provider business 字段（done 时 = provider body；blocked 时 = {}） */
  business: Record<string, unknown>;
}

/** kind → provider endpoint 子路径映射（mock provider 拦截 /search|/match|/stream|/lyrics|/metadata） */
const KIND_PATH: Record<string, string> = {
  content_query: "search",
  content_match: "match",
  content_stream: "stream",
  content_lyrics: "lyrics",
  content_metadata: "metadata",
};

function blocked(errorCode: string): ThirdPartyResult {
  return {
    outcome: "blocked",
    backendType: "third_party_api",
    capabilityMode: "unavailable",
    errorCode,
    business: {},
  };
}

export async function fetchThirdParty(
  opts: FetchThirdPartyOpts,
): Promise<ThirdPartyResult> {
  const {
    kind,
    providerHandle,
    provider,
    store,
    caller,
    providerBaseUrl,
    traceId,
    traceOrigin,
    observeCall,
  } = opts;

  // providerHandle 缺失 → AUTH_FAILED（route 未在 content_policy auth_config 查得 token_ref）。
  if (!providerHandle) {
    return blocked("AUTH_FAILED");
  }

  // resolve handle（typed Result，不 throw）。传 expectedProvider=provider 做 P2.6 provider binding 校验。
  const result = await store.resolveHandle(providerHandle, caller, provider);
  if (!result.ok) {
    // 不泄露具体内部 error 给 provider/下游；全映射 AUTH_FAILED。
    return blocked("AUTH_FAILED");
  }
  const { token, token_type } = result.secret;

  // M2d codex P2.2 fix：providerBaseUrl 缺失/空 → 早 return BACKEND_UNAVAILABLE（对齐 P2.7 catch 分流精神）。
  // 原先 new URL 在 try 外，空/无效 baseUrl 抛 TypeError 逃出 catch → 500 非 BACKEND_UNAVAILABLE。
  // 此 guard 为第一道防线；下方 new URL 仍在 try 内（双保险，防 baseUrl 非空但非法 hostname）。
  if (!providerBaseUrl) {
    return blocked("BACKEND_UNAVAILABLE");
  }

  // 构造请求 URL + 凭证注入（token_type 真用，P2.5）。
  const subPath = KIND_PATH[kind] ?? kind.replace("content_", "");
  const headers: Record<string, string> = {};
  if (traceId?.trim()) {
    headers["x-trace-id"] = traceId.trim();
    if (traceOrigin) headers["x-trace-origin"] = traceOrigin;
  }
  // url 在 try 内构造（P2.2：invalid URL 抛 TypeError 须被 catch 映射 BACKEND_UNAVAILABLE）。
  let url: URL;
  try {
    url = new URL(`${providerBaseUrl}/${subPath}`);
  } catch {
    return blocked("BACKEND_UNAVAILABLE");
  }
  if (token_type === "bearer") {
    headers.authorization = `Bearer ${token}`;
  } else if (token_type === "query_param") {
    url.searchParams.set("token", token);
  } else {
    // 未知 token_type（不应发生，secret-store-stub 类型限定 bearer|query_param）→ 安全 fail。
    return blocked("AUTH_FAILED");
  }

  const startedAt = process.hrtime.bigint();
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    observeCall?.(String(resp.status), durationSeconds);
    if (!resp.ok) {
      // P2.7 catch 分流精神（非 validateContract on provider body）：
      // 5xx → BACKEND_UNAVAILABLE；4xx → 提取 body.error_code（默认 AUTH_FAILED）。
      if (resp.status >= 500) {
        return blocked("BACKEND_UNAVAILABLE");
      }
      const body = (await resp.json().catch(() => null)) as {
        error_code?: string;
      } | null;
      return blocked(body?.error_code ?? "AUTH_FAILED");
    }
    // 200 → F1 raw business（provider body 直接作为 business，非 envelope）。
    const business = (await resp.json()) as Record<string, unknown>;
    return {
      outcome: "done",
      backendType: "third_party_api",
      capabilityMode: "real",
      business,
    };
  } catch {
    observeCall?.(
      "network_error",
      Number(process.hrtime.bigint() - startedAt) / 1e9,
    );
    // fetch 网络错 / 超时 → BACKEND_UNAVAILABLE。
    return blocked("BACKEND_UNAVAILABLE");
  }
}
