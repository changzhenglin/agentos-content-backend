// metadata.ts — metadata kind 业务 handler。
// 调 getMetadata，null → no_result；否则 ok。
// spec §5.5：单轨元数据。

import type { ContentDb } from "../content/db.js";
import type { CapabilityMode, ErrorCode } from "../envelope.js";
import { getMetadata } from "../content/self-hosted.js";

export async function metadataBusiness(db: ContentDb, trackId: string) {
  const business = await getMetadata(db, trackId);
  if (!business) {
    return {
      outcome: "no_result" as const,
      backendType: "self_hosted" as const,
      capabilityMode: "real" as CapabilityMode,
      errorCode: undefined as ErrorCode | undefined,
      business: {},
    };
  }
  return {
    outcome: "ok" as const,
    backendType: "self_hosted" as const,
    capabilityMode: "real" as CapabilityMode,
    errorCode: undefined as ErrorCode | undefined,
    business,
  };
}
