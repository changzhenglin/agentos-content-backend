// drm-rule-engine.ts — per-kind drm 检查（spec §8.2 + §4.5）。
// block 全 kind 全 track；region_restrict 按 backend 自持 region 判定；allow 放行。
// 纯函数 + region 注入，不绑 fastify。fail-closed 是 T6 drm-guard 范围，此处只做 checkDrm 纯逻辑。
import type { PolicyRecord } from "./policy-store.js";
import type { Kind } from "../envelope.js";

export interface DrmDecision {
  action: "allow" | "block" | "region_restrict";
  ruleId: string;
}

/**
 * 检查 policy 命中。sim 简化：block/region_restrict policy 全局命中所有 track_id + 全 kind
 *（spec §8.2 drm_rule 适用全 kind）。空集→null（放行）。
 * 返回 null=放行；返回 DrmDecision=命中。
 *
 * 注：`kind`/`trackId` 参数前缀 `_`（sim block 全 kind 全 track，未用），
 * 留参为 future per-kind 细化（spec §8.2）。
 */
export function checkDrm(
  policies: PolicyRecord[],
  _kind: Kind,
  _trackId: string,
  requestRegion: string,
  backendRegion: string,
): DrmDecision | null {
  for (const p of policies) {
    if (p.action === "block") return { action: "block", ruleId: p.ruleId };
    if (p.action === "region_restrict" && requestRegion !== backendRegion) {
      return { action: "region_restrict", ruleId: p.ruleId };
    }
    // allow / region_restrict 符合 → 继续看下一条
  }
  return null;
}
