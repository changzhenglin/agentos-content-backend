// region-config.ts — backend 自持 region（spec §8.2 D10，不扩 ops-config schema）。
// backend 自持 env CONTENT_BACKEND_REGION 默认 "cn"；不依赖 ops-config drm_rule region。
export function getRegion(): string {
  return process.env.CONTENT_BACKEND_REGION ?? "cn";
}
