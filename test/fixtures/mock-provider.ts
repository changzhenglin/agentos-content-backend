// mock 第三方 provider HTTP endpoint（QQ/网易云/酷狗），验 creds 用对。
// M2d sim：真 provider 授权后换真 endpoint（接口不变）。
// F1 fold（plan REVIEW）：返 raw business 字段（content_query 形态 {query, candidates}），
// 不含 envelope meta（kind/version/backend_type/capability_mode/completion_state），
// 避免下游 wrapEnvelope 时 `...business` spread 与 envelope 字段冲突。
import type { MockAgent } from "undici";

// mock provider 返回的 raw business 字段（200 路径）或 error body（401 路径）。
type MockProviderResponseData =
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

export interface MockProviderHandle {
  // 记录每个 provider 收到的 Authorization header（供测试断言 creds 路由正确）
  receivedAuths: Record<string, string | undefined>;
  receivedTraceIds: Record<string, string | undefined>;
  receivedTraceOrigins: Record<string, string | undefined>;
}

// 为给定 provider→baseUrl 映射注册 mock 拦截。
// 拦截 GET /search|/match|/stream|/lyrics|/metadata（option A：单段 handle，per-provider endpoint）。
// 鉴权契约：Authorization: Bearer <token>，token 缺失或为 "invalid" → 401 AUTH_FAILED；
// 合法 token → 200 + raw business 字段。
export function setupMockProvider(
  agent: MockAgent,
  providerBaseUrl: Record<string, string>,
): MockProviderHandle {
  const receivedAuths: Record<string, string | undefined> = {};
  const receivedTraceIds: Record<string, string | undefined> = {};
  const receivedTraceOrigins: Record<string, string | undefined> = {};
  for (const [provider, baseUrl] of Object.entries(providerBaseUrl)) {
    const pool = agent.get(baseUrl);
    pool
      .intercept({ method: "GET", path: /\/search|\/match|\/stream|\/lyrics|\/metadata/ })
      .reply<MockProviderResponseData>((req) => {
        // headers 类型为 `Headers | Record<string,string> | undefined`；
        // 这里是 server-side undici 请求头（Record 形态），cast 取 authorization。
        const headers = (req.headers ?? {}) as Record<string, string>;
        const auth = headers.authorization;
        receivedAuths[provider] = auth;
        receivedTraceIds[provider] = headers["x-trace-id"];
        receivedTraceOrigins[provider] = headers["x-trace-origin"];
        const token = auth?.replace(/^Bearer /, "");
        if (!token || token === "invalid") {
          return { statusCode: 401, data: { error_code: "AUTH_FAILED" } };
        }
        // 返 raw business 字段（F1：非 envelope）；与 self_hosted queryBusiness 返形一致。
        return {
          statusCode: 200,
          data: {
            query: { keywords: ["k"] },
            candidates: [
              {
                track_id: `${provider}:t1`,
                title: "song",
                artist: "art",
                confidence: 0.9,
              },
            ],
          },
        };
      });
  }
  return { receivedAuths, receivedTraceIds, receivedTraceOrigins };
}
