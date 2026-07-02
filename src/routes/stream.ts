// stream.ts — stream kind 业务 handler。
// selectPath + parseTrackId + presign + tracks 查询 → stream envelope 业务字段。
// spec §5.4：stream_id=Date.now()，audit defer M2b/M3-pre。
//
// T4 concerns：third_party_api/real 路径无 backend（M2d 前不落地），
// streamBusiness 对未实现路径走 selectPath → unavailable → blocked。
// copyright 检查先于 availability（brief T4）：selectPath 先判 authorized，
// 未授权 → COPYRIGHT_RESTRICTED blocked（先于 providerAvailable 判定）。
//
// presign 注入为函数（hexagonal）：T7 线接 presignUrl(s3,bucket,key)，
// e2e 传 stub，避免 S3 依赖（stream e2e mock presign，brief Step 4）。

import type { ContentDb } from "../content/db.js";
import { parseTrackId } from "../content/track-id.js";
import { selectPath } from "../content/path-select.js";
import { objectKey } from "../storage/presign.js";
import type { CapabilityMode, ErrorCode } from "../envelope.js";

export interface PresignFn {
  (key: string): Promise<{
    url: string;
    auth: { token: string; token_type: "query_param"; expires_at: string };
  }>;
}

export interface StreamOk {
  outcome: "ok";
  backendType: "self_hosted" | "third_party_api";
  capabilityMode: CapabilityMode;
  errorCode?: ErrorCode;
  business: {
    stream_id: number;
    track_id: string;
    url: string;
    auth: { token: string; token_type: "query_param"; expires_at: string };
    format: string;
    bitrate: number;
    expires_at: string;
  };
}
export interface StreamNoResult {
  outcome: "no_result";
  backendType: "self_hosted" | "third_party_api";
  capabilityMode: CapabilityMode;
  errorCode?: ErrorCode;
  business: Record<string, never>;
}
export interface StreamBlocked {
  outcome: "blocked";
  backendType: "self_hosted" | "third_party_api";
  capabilityMode: CapabilityMode;
  errorCode?: ErrorCode;
  business: Record<string, never>;
}
export type StreamOutcome = StreamOk | StreamNoResult | StreamBlocked;

/**
 * streamBusiness：selectPath 路由 + presign URL。
 * - third_party stream 未授权/不可用 → blocked（selectPath unavailable）
 * - track 不存在 → no_result
 * - 否则 ok + stream 字段
 *
 * 注意：brief 传 selectPath(provider, false, "stream", false)，
 * authorized=false——M2d 前无 third_party 授权，self provider 忽略该参数返回 real。
 */
export async function streamBusiness(
  db: ContentDb,
  presign: PresignFn,
  trackId: string,
): Promise<StreamOutcome> {
  const { provider, id } = parseTrackId(trackId);
  const path = selectPath(provider, false, "stream", false);
  if (path.capabilityMode === "unavailable") {
    return {
      outcome: "blocked",
      backendType: path.backendType,
      capabilityMode: path.capabilityMode,
      errorCode: path.errorCode,
      business: {},
    };
  }
  const { rows } = await db.query(
    "SELECT format, bitrate FROM tracks WHERE track_id = $1 LIMIT 1",
    [trackId],
  );
  const row = rows[0];
  if (!row) {
    return {
      outcome: "no_result",
      backendType: path.backendType,
      capabilityMode: path.capabilityMode,
      errorCode: path.errorCode,
      business: {},
    };
  }
  const key = objectKey(provider, id, 1);
  const { url, auth } = await presign(key);
  return {
    outcome: "ok",
    backendType: path.backendType,
    capabilityMode: path.capabilityMode,
    errorCode: path.errorCode,
    business: {
      stream_id: Date.now(),
      track_id: trackId,
      url,
      auth,
      format: String(row.format),
      bitrate: Number(row.bitrate),
      expires_at: auth.expires_at,
    },
  };
}
