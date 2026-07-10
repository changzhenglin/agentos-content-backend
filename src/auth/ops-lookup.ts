// ops-lookup.ts — #2 token 绑设备校验（IAM §6.3 step4）。
// 调 ops GET /api/internal/bindings（#4 PR#15）验 end_user_id↔device_id 绑定。
// service-auth：x-service-token 头（scope=lookup 对应 OPS_LOOKUP_TOKEN）+ x-service-name。
// 200 → {bound,...}；bound=false 由调用方判 403（非 throw）。
// 401/403 service-auth 失败 → warn + LookupError(503)（区分 log，仍 503 给调用方）。
// 非 2xx/网络/超时/shape 无效 → LookupError(503)。
// 不缓存（sim，零 stale 风险，绑定撤销立即生效）。
// trace_id 下传：x-trace-id 头（T5 透传请求 trace）。
export interface DeviceBinding {
  bound: boolean;
  role?: "owner" | "member";
  device_group_id?: string;
}

export class LookupError extends Error {
  constructor(public status: 503, message: string) {
    super(message);
    this.name = "LookupError";
  }
}

export interface OpsLookupClient {
  lookupDeviceBinding(
    end_user_id: string,
    device_id: string,
    traceId?: string,
  ): Promise<DeviceBinding>;
}

export function createOpsLookupClient(opts: {
  baseUrl: string;
  serviceToken: string;
  serviceName: string;
}): OpsLookupClient {
  return {
    async lookupDeviceBinding(
      end_user_id: string,
      device_id: string,
      traceId?: string,
    ): Promise<DeviceBinding> {
      const url = new URL("/api/internal/bindings", opts.baseUrl);
      url.searchParams.set("end_user_id", end_user_id);
      url.searchParams.set("device_id", device_id);
      const headers: Record<string, string> = {
        "x-service-token": opts.serviceToken,
        "x-service-name": opts.serviceName,
        accept: "application/json",
      };
      if (traceId) headers["x-trace-id"] = traceId;
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", headers });
      } catch (e) {
        throw new LookupError(
          503,
          `ops lookup network error: ${(e as Error).message}`,
        );
      }
      // ops service-auth 失败（401/403）≠ 不可用——区分 log（仍 503 给调用方，
      // 但 warn 提醒查 OPS_LOOKUP_TOKEN）
      if (res.status === 401 || res.status === 403) {
        console.warn(
          `[ops-lookup] service-auth failed (HTTP ${res.status}) — check OPS_LOOKUP_TOKEN`,
        );
        throw new LookupError(
          503,
          `ops lookup service-auth failed: HTTP ${res.status}`,
        );
      }
      if (!res.ok) {
        throw new LookupError(503, `ops lookup HTTP ${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (e) {
        throw new LookupError(
          503,
          `ops lookup invalid response body: ${(e as Error).message}`,
        );
      }
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { bound?: unknown }).bound !== "boolean"
      ) {
        throw new LookupError(
          503,
          "ops lookup invalid response shape (bound not boolean)",
        );
      }
      return body as DeviceBinding;
    },
  };
}
