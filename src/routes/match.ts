// match.ts — match kind 业务 handler。
// 调 matchTrack，null → no_result；否则 ok。
// spec §5.2：isrc/title 精确匹配。

import type { ContentDb } from "../content/db.js";
import { matchTrack } from "../content/self-hosted.js";

export async function matchBusiness(
  db: ContentDb,
  match: { title: string; artist: string; isrc?: string },
) {
  const business = await matchTrack(db, match);
  if (!business) {
    return {
      outcome: "no_result" as const,
      backendType: "self_hosted" as const,
      business: {},
    };
  }
  return {
    outcome: "ok" as const,
    backendType: "self_hosted" as const,
    business,
  };
}
