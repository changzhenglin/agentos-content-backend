// query.ts — query kind 业务 handler。
// 调 queryTracks，返回 {outcome, backendType, business}（路由层 wrap envelope）。
// spec §5.1：candidates 非空 → ok；空 → no_result。
// self_hosted only（third_party query 未授权走 selectPath fallback degraded，
// 但 degraded 仍走 self_hosted 业务函数——M2d 前所有 query 均 self_hosted）。

import type { ContentDb } from "../content/db.js";
import { queryTracks } from "../content/self-hosted.js";

export async function queryBusiness(db: ContentDb, keywords: string[]) {
  const business = await queryTracks(db, keywords);
  return {
    outcome: business.candidates.length ? ("ok" as const) : ("no_result" as const),
    backendType: "self_hosted" as const,
    business,
  };
}
