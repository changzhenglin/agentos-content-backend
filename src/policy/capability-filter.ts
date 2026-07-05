// capability-filter.ts — device-capability 筛选（M3 阶段2 U2）。
// drm-guard 前置：端侧能力不支持 kind/format/bitrate → 降级或 BLOCKED。
// device_capability 与 drm_rule 正交：drm 管版权/region，device_capability 管端侧硬件能力。
// fail-closed：policyStore 故障 → BACKEND_UNAVAILABLE（不 silent allow）。
// 降级优先于 BLOCKED：format/bitrate 不匹配时优先返 degraded=true（route 层据此标 capability_mode=degraded），
//   全不支持才 BLOCKED。
//
// review fold P2#3：无 capability header → 放行（sim trust network）提到 policyStore 探测之前。
//   否则 device-hub 不带 cap（sim 常态）+ policyStore 抖动 → BACKEND_UNAVAILABLE，trust-network 旁路失效。

import type { Kind, ErrorCode } from "../envelope.js";
import type { PolicyStore } from "./policy-store.js";

export interface DeviceCapability {
  kinds: string[];          // 端侧支持的 kind 列表（content_query/content_stream...）
  formats: string[];        // 支持的音频格式（mp3/aac/flac）
  maxBitrate: number;       // 最大支持比特率
  region?: string;          // 端侧 region
}

export type CapabilityDecision =
  | { blocked: true; errorCode: ErrorCode }
  | { blocked: false; degraded?: boolean; format?: string; bitrate?: number };

/** 解析 X-Device-Capability header（JSON）。非法/缺失 → undefined（不阻塞，sim trust network）。 */
export function parseDeviceCapability(header: string | undefined): DeviceCapability | undefined {
  if (!header) return undefined;
  try {
    const raw = JSON.parse(header);
    if (!Array.isArray(raw.kinds) || !Array.isArray(raw.formats) || typeof raw.maxBitrate !== "number") {
      return undefined;
    }
    return raw as DeviceCapability;
  } catch {
    return undefined;
  }
}

/**
 * capability 筛选：
 * - 无 capability（undefined）→ 放行（sim trust network，真机 mTLS + capability 强制 defer M5）
 * - kind 不在端侧 kinds → BLOCKED CAPABILITY_UNSUPPORTED
 * - format 不在端侧 formats → BLOCKED CAPABILITY_UNSUPPORTED
 * - trackBitrate > maxBitrate → 降级（blocked=false, degraded=true）；无可用降级 format 才 BLOCKED
 * - policyStore 故障 → fail-closed BACKEND_UNAVAILABLE（仅当 capability 存在时才探测 store 健康）
 *
 * 注意：本 sim 版不查 capability_policy（ops 下发给端侧的，归端侧；content-backend 消费 device_capability）。
 */
export async function capabilityFilter(opts: {
  capability: DeviceCapability | undefined;
  kind: Kind;
  trackFormat?: string;
  trackBitrate?: number;
  policyStore: PolicyStore;
}): Promise<CapabilityDecision> {
  const { capability, kind, trackFormat, trackBitrate, policyStore } = opts;
  // review fold P2#3：无 capability header → 放行（sim trust network）提到 policyStore 探测之前。
  // 否则 device-hub 不带 cap（sim 常态）+ policyStore 抖动 → BACKEND_UNAVAILABLE，trust-network 旁路失效。
  if (!capability) return { blocked: false };
  // policyStore fail-closed 探测（与 drm-guard 一致：store 故障不 silent allow）。
  // 仅当 capability 存在时才探测 store 健康（无 cap 已放行）。
  try {
    await policyStore.latestPolicy();
  } catch {
    return { blocked: true, errorCode: "BACKEND_UNAVAILABLE" };
  }
  // kind 筛选
  if (!capability.kinds.includes(kind)) {
    return { blocked: true, errorCode: "CAPABILITY_UNSUPPORTED" };
  }
  // format 筛选（trackFormat 有值时校验，query/match 无 format）
  if (trackFormat && !capability.formats.includes(trackFormat)) {
    return { blocked: true, errorCode: "CAPABILITY_UNSUPPORTED" };
  }
  // bitrate 降级（trackBitrate > maxBitrate → degraded，不 BLOCKED）
  let degraded = false;
  let bitrate = trackBitrate;
  if (trackBitrate && trackBitrate > capability.maxBitrate) {
    degraded = true;
    bitrate = capability.maxBitrate; // 降级到端侧 max
    // 注：sim 不做真实转码，仅标记 degraded；真机转码 defer
  }
  return { blocked: false, degraded, format: trackFormat, bitrate };
}
