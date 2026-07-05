import { describe, it, expect } from "vitest";
import { parseDeviceCapability, capabilityFilter } from "../../src/policy/capability-filter.js";
import type { PolicyStore } from "../../src/policy/policy-store.js";

const emptyStore: PolicyStore = {
  async latestPolicy() { return []; },
  async applyPolicy() {},
} as unknown as PolicyStore;

const failStore: PolicyStore = {
  async latestPolicy() { throw new Error("store down"); },
  async applyPolicy() {},
} as unknown as PolicyStore;

describe("device-capability-filter", () => {
  it("parseDeviceCapability: 合法 JSON → 解析", () => {
    const c = parseDeviceCapability(JSON.stringify({ kinds: ["content_query","content_stream"], formats: ["mp3"], maxBitrate: 128000, region: "cn" }));
    expect(c?.formats).toEqual(["mp3"]);
    expect(c?.maxBitrate).toBe(128000);
  });
  it("parseDeviceCapability: undefined/非法 → undefined（不阻塞，trust caller）", () => {
    expect(parseDeviceCapability(undefined)).toBeUndefined();
    expect(parseDeviceCapability("not-json")).toBeUndefined();
  });
  it("无 capability header → 放行（不阻塞，sim trust network）", async () => {
    const d = await capabilityFilter({ capability: undefined, kind: "content_stream", policyStore: emptyStore });
    expect(d.blocked).toBe(false);
  });
  it("端侧支持 stream+mp3 → 放行", async () => {
    const c = parseDeviceCapability(JSON.stringify({ kinds: ["content_stream"], formats: ["mp3"], maxBitrate: 128000 }))!;
    const d = await capabilityFilter({ capability: c, kind: "content_stream", trackFormat: "mp3", trackBitrate: 128000, policyStore: emptyStore });
    expect(d.blocked).toBe(false);
  });
  it("端侧不支持 content_lyrics kind → BLOCKED CAPABILITY_UNSUPPORTED", async () => {
    const c = parseDeviceCapability(JSON.stringify({ kinds: ["content_query"], formats: ["mp3"], maxBitrate: 128000 }))!;
    const d = await capabilityFilter({ capability: c, kind: "content_lyrics", policyStore: emptyStore });
    expect(d.blocked).toBe(true);
    if (d.blocked) expect(d.errorCode).toBe("CAPABILITY_UNSUPPORTED");
  });
  it("端侧 maxBitrate 128000 但 track 320000 → 降级提示（blocked=false, degraded=true）", async () => {
    const c = parseDeviceCapability(JSON.stringify({ kinds: ["content_stream"], formats: ["mp3"], maxBitrate: 128000 }))!;
    const d = await capabilityFilter({ capability: c, kind: "content_stream", trackFormat: "mp3", trackBitrate: 320000, policyStore: emptyStore });
    expect(d.blocked).toBe(false);
    if (!d.blocked) expect(d.degraded).toBe(true);
  });
  it("端侧不支持 mp3 format → BLOCKED", async () => {
    const c = parseDeviceCapability(JSON.stringify({ kinds: ["content_stream"], formats: ["aac"], maxBitrate: 128000 }))!;
    const d = await capabilityFilter({ capability: c, kind: "content_stream", trackFormat: "mp3", trackBitrate: 128000, policyStore: emptyStore });
    expect(d.blocked).toBe(true);
    if (d.blocked) expect(d.errorCode).toBe("CAPABILITY_UNSUPPORTED");
  });
  it("policyStore 故障 + 有 capability → fail-closed BACKEND_UNAVAILABLE", async () => {
    const c = parseDeviceCapability(JSON.stringify({ kinds: ["content_stream"], formats: ["mp3"], maxBitrate: 128000 }))!;
    const d = await capabilityFilter({ capability: c, kind: "content_stream", trackFormat: "mp3", trackBitrate: 128000, policyStore: failStore });
    expect(d.blocked).toBe(true);
    if (d.blocked) expect(d.errorCode).toBe("BACKEND_UNAVAILABLE");
  });
  it("review fold P2#3: 无 capability + policyStore 故障 → 放行（!capability 短路在 store 探测前）", async () => {
    // device-hub 不带 cap（sim 常态）+ policyStore 抖动 → 不应 BACKEND_UNAVAILABLE
    const d = await capabilityFilter({ capability: undefined, kind: "content_stream", policyStore: failStore });
    expect(d.blocked).toBe(false);
  });
});
