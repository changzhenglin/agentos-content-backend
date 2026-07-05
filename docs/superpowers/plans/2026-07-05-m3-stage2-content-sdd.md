# M3 阶段2 内容侧 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接通 M3 阶段2 内容侧链路3（端侧→device-hub→content-backend 5 kind API），device-hub 作为端侧唯一网关直连 content-backend self_hosted 真实曲目，cloud-ext 回归纯 agent 工具（链路4 defer 阶段3）。

**Architecture:** device-hub 直连 content-backend 5 kind API（caller=device-hub, self_hosted 路径, 无 secret_handle）；扩 inbound 白名单加 device-hub caller + caller×backend_type 矩阵防越权（device-hub 只允许 self_hosted）；新建 device-capability-filter（drm-guard 前置，format/bitrate 降级优先）；填 royalty-free 真实曲目（sim 用 ffmpeg 生成 sine wave MP3 占位真实字节）；e2e 真 HTTP 拉 presigned URL 校验 MP3 字节。

**Tech Stack:** TypeScript 5 + fastify 5 + drizzle-orm 0.36 + pg 8 + @aws-sdk/client-s3 + @testcontainers/postgresql + @testcontainers/minio + vitest 2 + tsx 4

## Global Constraints

- 主模型 glm-5.2[1m] 紧凑档 + codex gpt-5.5 跨厂商（content-contract 公共 contract 强制子集）
- 仓库：`~/projects/agentos-content-backend`（sibling，独立 repo 天然隔离，无 worktree）；feature branch `m3-stage2-content-design`（已建，spec commit `f601f97`）
- 测试命令：`pnpm test`（= `vitest run`）；单文件 `npx vitest run <path> -t "<name>"`
- commit message 英文 conventional 前缀 + 中文描述（如 `feat(m3-stage2): 扩 caller-auth-matrix 加 device-hub`）
- content-contract schema 字节级同步三 repo（本 plan 不改 schema，只消费）
- surgical 原则：每 hunk 归入请求/必要支撑/验证需要/本次清理；无关死代码不删
- sim 诚实边界：capability_mode 标 real（self_hosted 真实曲目）/ unavailable；mTLS defer 真机/M5；终端用户 mock
- spec 文件：`docs/superpowers/specs/2026-07-05-m3-stage2-content-design.md`（commit f601f97）
- 现有签名（不改）：
  - `ALLOW_MATRIX: Record<string, string[]>`（caller→source 域前缀数组，`src/auth/caller-auth-matrix.ts:11`）
  - `receiveAndAuthorize({handle, caller, auditSink, traceId}): Promise<AuthorizeResult>`（`src/auth/secret-handle-hook.ts:67`）
  - `drmGuard(ctx, kind, trackId, requestRegion): Promise<DrmBlocked|DrmAllow>`（`src/policy/drm-guard.ts:33`）
  - `buildServer(opts): Promise<FastifyInstance>`（`src/index.ts:124`），`INBOUND_ALLOWED_CALLERS`（`src/index.ts:52`）
  - `wrapEnvelope(business, kind, backendType, capabilityMode, outcome, errorCode): Envelope`（`src/envelope.ts:86`）
  - `Kind/BackendType/CapabilityMode/Outcome/ErrorCode`（`src/envelope.ts:9-29`）
  - `streamBusiness(db, presign, trackId, ctx): Promise<StreamOutcome>`（`src/routes/stream.ts:68`）
  - `queryTracks/matchTrack/getMetadata`（`src/content/self-hosted.ts`）
  - `getLyrics(db, trackId): Promise<LyricsOutcome>`（`src/content/lyrics.ts:46`）
  - `presignUrl(client, bucket, key, ttl?)`（`src/storage/presign.ts:43`）+ `objectKey(provider, trackId, version)`（`:7`）
  - tracks/lyrics/contentPolicy 表（`src/db/schema.ts`）
  - e2e 范式：`test/integration/m2d-e2e.test.ts`（testcontainers pg+minio + spawn + mock provider）

---

### Task 1: caller-auth-matrix 扩 device-hub + caller×backend_type 矩阵

**Files:**
- Modify: `src/auth/caller-auth-matrix.ts`
- Modify: `src/index.ts`（INBOUND_ALLOWED_CALLERS + route 层 backend_type 校验）
- Test: `test/auth/caller-auth-matrix.test.ts`（新建）+ `test/integration/route-authorize.e2e.test.ts`（扩 case）

> review fold P1#1：`src/auth/secret-handle-hook.ts` **不改**——`receiveAndAuthorize` 的 `!handle` 短路已存在（`secret-handle-hook.ts:74` `if (!handle) return { authorized: true }`），device-hub self_hosted 无 handle 路径经此短路 authorized。本 task 不动该文件（原 plan 列 Modify 是笔误）。

**Interfaces:**
- Consumes: 既有 `ALLOW_MATRIX`、`receiveAndAuthorize`、`INBOUND_ALLOWED_CALLERS`、`normalizeInboundCaller`
- Produces:
  - `ALLOWED_BACKEND_TYPES: Record<string, BackendType[]>`（caller→允许的 backend_type 数组，单一源）
  - `authorizeBackendType(caller, backendType): { authorized: boolean; reason?: string }`（caller×backend_type 校验，route 层 resolveProviderPath 后调）

- [ ] **Step 1: 写 caller-auth-matrix 失败测试**

Create `test/auth/caller-auth-matrix.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ALLOW_MATRIX, ALLOWED_BACKEND_TYPES, authorizeBackendType } from "../../src/auth/caller-auth-matrix.js";

describe("caller-auth-matrix (M3 阶段2 device-hub 扩展)", () => {
  it("device-hub 在 ALLOW_MATRIX（无 source 域，self_hosted 路径无 handle）", () => {
    expect(ALLOW_MATRIX["device-hub"]).toEqual([]);
  });
  it("cloud-ext 仍允许 ^cloud: source", () => {
    expect(ALLOW_MATRIX["cloud-ext"]).toContain("^cloud:");
  });
  it("device-hub 只允许 self_hosted backend_type", () => {
    expect(ALLOWED_BACKEND_TYPES["device-hub"]).toEqual(["self_hosted"]);
  });
  it("cloud-ext 允许 self_hosted + third_party_api", () => {
    expect(ALLOWED_BACKEND_TYPES["cloud-ext"]).toEqual(["self_hosted", "third_party_api"]);
  });
  it("authorizeBackendType: device-hub + self_hosted → authorized", () => {
    expect(authorizeBackendType("device-hub", "self_hosted")).toEqual({ authorized: true });
  });
  it("authorizeBackendType: device-hub + third_party_api → 拒绝（防越权）", () => {
    const r = authorizeBackendType("device-hub", "third_party_api");
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("backend_type_not_allowed");
  });
  it("authorizeBackendType: cloud-ext + third_party_api → authorized", () => {
    expect(authorizeBackendType("cloud-ext", "third_party_api")).toEqual({ authorized: true });
  });
  it("authorizeBackendType: anonymous + any → 拒绝", () => {
    expect(authorizeBackendType("anonymous", "self_hosted").authorized).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/auth/caller-auth-matrix.test.ts`
Expected: FAIL — `ALLOW_MATRIX["device-hub"]` is undefined / `ALLOWED_BACKEND_TYPES` not exported

- [ ] **Step 3: 扩 caller-auth-matrix.ts**

Modify `src/auth/caller-auth-matrix.ts`，在文件末尾 `ALLOW_MATRIX` 之后追加：

```typescript
import type { BackendType } from "../envelope.js";

/**
 * caller×backend_type 允许矩阵（M3 阶段2 D7：device-hub 防越权）。
 * - cloud-ext：agent 工具，允许 self_hosted + third_party_api（链路4）
 * - device-hub：端侧网关，只允许 self_hosted（端侧不直接调 third_party provider，
 *   third_party 内容经 agent 链路4 触发；防 device-hub 伪造 provider 调用越权）
 * - 其他 caller（anonymous 等）：无任何 backend_type 允许
 */
export const ALLOWED_BACKEND_TYPES: Record<string, BackendType[]> = {
  "cloud-ext": ["self_hosted", "third_party_api"],
  "device-hub": ["self_hosted"],
};

/**
 * caller×backend_type 校验（route 层 resolveProviderPath 后调）。
 * caller 不在矩阵或 backend_type 不在其允许行 → backend_type_not_allowed。
 * 与 receiveAndAuthorize（caller×source）正交：receive 校验 handle 来源域，
 * 本函数校验 caller 被允许走的 backend 路径。
 */
export function authorizeBackendType(
  caller: string,
  backendType: BackendType,
): { authorized: boolean; reason?: string } {
  const allowed = ALLOWED_BACKEND_TYPES[caller];
  if (!allowed || !allowed.includes(backendType)) {
    return { authorized: false, reason: "backend_type_not_allowed" };
  }
  return { authorized: true };
}
```

注意：`ALLOW_MATRIX` 加 `"device-hub": []` 行（device-hub 无 source 域，self_hosted 路径无 handle → receiveAndAuthorize 的 `!handle` 短路返 authorized true，不查 ALLOW_MATRIX；但矩阵完整性仍列 device-hub）：

```typescript
export const ALLOW_MATRIX: Record<string, string[]> = {
  "content-backend": ["^backend:"],
  "cloud-ext": ["^cloud:"],
  "ops-platform": ["^ops:"],
  "provisioning-service": ["^device:"],
  "device-hub": [], // M3 阶段2：self_hosted 路径无 handle，receiveAndAuthorize !handle 短路；列此行保矩阵完整
};
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/auth/caller-auth-matrix.test.ts`
Expected: PASS（8/8）

- [ ] **Step 5: 扩 INBOUND_ALLOWED_CALLERS + route 层 backend_type 校验**

Modify `src/index.ts:52`：

```typescript
const INBOUND_ALLOWED_CALLERS = ["cloud-ext", "device-hub"] as const;
```

在 5 个 route handler 中，`resolveProviderPath` 之后、`handle()` 之前，插入 backend_type 校验。以 `/content_query` 为例（`src/index.ts:281` 之后）：

```typescript
    const { backendType, providerHandle } = await resolveProviderPath("content_query", provider);
    const btAuthz = authorizeBackendType(caller, backendType);
    if (!btAuthz.authorized) {
      const envelope = wrapEnvelope({}, "content_query", "self_hosted", "unavailable", "blocked", "AUTH_FAILED");
      return reply.code(403).send(envelope);
    }
```

import 块（`src/index.ts:41` 附近）追加：

```typescript
import { authorizeBackendType } from "./auth/caller-auth-matrix.js";
```

其余 4 个 route（match/stream/lyrics/metadata）同模式插入 `authorizeBackendType` 校验（kind 字面量替换为对应 kind）。

- [ ] **Step 6: 扩 route-authorize e2e 加 device-hub case**

Modify `test/integration/route-authorize.e2e.test.ts`，新增 case（参照既有 case 1 cloud-ext 模式）：

```typescript
  it("case 6: device-hub caller + self_hosted query → 200（无 handle，authorized）", async () => {
    const r = await fetch(`${BACKEND_URL}/content_query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caller-identity": "device-hub",
        "x-trace-id": "trace-devhub-1",
      },
      body: JSON.stringify({ query: { keywords: ["any"] } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.backend_type).toBe("self_hosted");
  });

  it("case 7: device-hub caller + provider=qq (third_party) → 403 backend_type_not_allowed", async () => {
    const r = await fetch(`${BACKEND_URL}/content_query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caller-identity": "device-hub",
        "x-trace-id": "trace-devhub-2",
      },
      body: JSON.stringify({ provider: "qq", query: { keywords: ["k"] } }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.completion_state).toBe("BLOCKED");
    expect(body.error_code).toBe("AUTH_FAILED");
  });

  it("case 8: 伪造 X-Caller-identity: content-backend → anonymous 归一化 → 403", async () => {
    const r = await fetch(`${BACKEND_URL}/content_query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caller-identity": "content-backend",
      },
      body: JSON.stringify({ query: { keywords: ["any"] } }),
    });
    expect(r.status).toBe(403);
  });
```

注意：case 6/7/8 依赖 `BACKEND_URL` 与既有 e2e setup 一致；若既有 setup 用 in-process buildServer（非 spawn），case 6 需注入空 policyStore（self_hosted allow）。若 BACKEND_URL 来自 m2d-e2e 的 spawn setup，则 case 6/7/8 应放新 e2e 文件（见 Task 6），本 task 只加 case 8（spoof 防御，in-process 可测）。**实操**：若 route-authorize.e2e 用 in-process，只加 case 8 + case 6（self_hosted 无 handle authorized，空库 NO_RESULT 但 200）；case 7（third_party 越权）需 push qq policy 后测，放 Task 6 e2e。

- [ ] **Step 7: 跑全部测试验证无回归**

Run: `npx vitest run test/auth/ test/integration/route-authorize.e2e.test.ts`
Expected: PASS（既有 case + 新 case 6/8）

- [ ] **Step 8: Commit**

```bash
git add src/auth/caller-auth-matrix.ts src/auth/secret-handle-hook.ts src/index.ts test/auth/caller-auth-matrix.test.ts test/integration/route-authorize.e2e.test.ts
git commit -m "feat(m3-stage2): 扩 caller-auth-matrix 加 device-hub caller + caller×backend_type 矩阵

- ALLOW_MATRIX 加 device-hub（无 source 域，self_hosted 路径无 handle）
- 新 ALLOWED_BACKEND_TYPES 单一源 + authorizeBackendType 校验函数
- INBOUND_ALLOWED_CALLERS 加 device-hub
- 5 kind route 层 resolveProviderPath 后校验 caller×backend_type（device-hub 只允许 self_hosted 防越权）
- D7 走向B：device-hub 直连 content-backend，cloud-ext 回归纯 agent 工具"
```

---

### Task 2: device-capability-filter（drm-guard 前置能力筛选）

**Files:**
- Create: `src/policy/capability-filter.ts`
- Modify: `src/index.ts`（5 route 接入 capability-filter，drm-guard 前）
- Test: `test/policy/capability-filter.test.ts`（新建）

**Interfaces:**
- Consumes: `Kind`（`src/envelope.ts`）、capability_policy（`policyStore.latestPolicy()` 复用，capability kind 的 rule）
- Produces:
  - `DeviceCapability`（interface：支持的 kind/format/bitrate/region）
  - `parseDeviceCapability(header: string | undefined): DeviceCapability | undefined`
  - `capabilityFilter(opts: { capability: DeviceCapability | undefined; kind: Kind; trackFormat?: string; trackBitrate?: number; policyStore: PolicyStore }): Promise<CapabilityDecision>`
  - `CapabilityDecision = { blocked: true; errorCode: "CAPABILITY_UNSUPPORTED" | "BACKEND_UNAVAILABLE" } | { blocked: false; degraded?: boolean; format?: string; bitrate?: number }`

- [ ] **Step 1: 写 capability-filter 失败测试**

Create `test/policy/capability-filter.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { parseDeviceCapability, capabilityFilter } from "../../src/policy/capability-filter.js";
import type { PolicyStore } from "../../src/policy/policy-store.js";

const emptyStore: PolicyStore = {
  async latestPolicy() { return []; },
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
  it("policyStore 故障 → fail-closed BACKEND_UNAVAILABLE", async () => {
    const failStore: PolicyStore = {
      async latestPolicy() { throw new Error("store down"); },
      async applyPolicy() {},
    } as unknown as PolicyStore;
    const c = parseDeviceCapability(JSON.stringify({ kinds: ["content_stream"], formats: ["mp3"], maxBitrate: 128000 }))!;
    const d = await capabilityFilter({ capability: c, kind: "content_stream", trackFormat: "mp3", trackBitrate: 128000, policyStore: failStore });
    expect(d.blocked).toBe(true);
    if (d.blocked) expect(d.errorCode).toBe("BACKEND_UNAVAILABLE");
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/policy/capability-filter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 capability-filter.ts**

Create `src/policy/capability-filter.ts`:

```typescript
// capability-filter.ts — device-capability 筛选（M3 阶段2 U2）。
// drm-guard 前置：端侧能力不支持 kind/format/bitrate → 降级或 BLOCKED。
// capability_policy 与 drm_rule 正交：drm 管版权/region，capability 管设备能力。
// fail-closed：policyStore 故障 → BACKEND_UNAVAILABLE（不 silent allow）。
// 降级优先于 BLOCKED：format/bitrate 不匹配时优先返 degraded=true（route 层据此标 capability_mode=degraded），
//   全不支持才 BLOCKED。

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
 * - policyStore 故障 → fail-closed BACKEND_UNAVAILABLE
 *
 * 注意：本 sim 版不查 capability_policy（ops 下发的 capability_mode 约束）——
 *   capability_policy 消费复用 policyStore.latestPolicy（capability kind rule），
 *   sim 阶段空集 allow；真机 capability_policy 下发后 latestPolicy 返 rule 约束 kind。
 *   本函数先做端侧 device_capability 硬件能力筛选（kinds/formats/bitrate），
 *   capability_policy（运营下发的软件约束）defer 后续 task/窗口B。
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
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/policy/capability-filter.test.ts`
Expected: PASS（7/7）

- [ ] **Step 5: 5 route 接入 capability-filter**

Modify `src/index.ts`，import 块追加：

```typescript
import { parseDeviceCapability, capabilityFilter, type DeviceCapability } from "./policy/capability-filter.js";
```

在每个 route handler 中，`receiveAndAuthorize` 之后、`resolveProviderPath` 之前，插入 capability-filter。以 `/content_stream` 为例（`src/index.ts:337` 之后，authz 校验后）——**review fold A1+P2#4**：stream 先查 tracks format/bitrate 再筛，degraded 传到 envelope：

```typescript
    const capHeader = req.headers["x-device-capability"] as string | undefined;
    const capability = parseDeviceCapability(capHeader);
    // review fold A1：stream 先查 tracks format/bitrate 再调 capability-filter（传 trackFormat/trackBitrate），
    // 使 format/bitrate 降级生效（spec U2 要求降级优先于 BLOCKED；trackFormat 在 streamBusiness 内查，
    // capability-filter 在 business 前，故 route 层先查一次 format/bitrate 传给 capability-filter）。
    const { rows: trackRows } = await db.query(
      "SELECT format, bitrate FROM tracks WHERE track_id = $1 LIMIT 1",
      [tid],
    );
    const trackFormat = trackRows[0]?.format ? String(trackRows[0].format) : undefined;
    const trackBitrate = trackRows[0]?.bitrate ? Number(trackRows[0].bitrate) : undefined;
    const capDec = await capabilityFilter({ capability, kind: "content_stream", trackFormat, trackBitrate, policyStore });
    if (capDec.blocked) {
      const envelope = wrapEnvelope({}, "content_stream", "self_hosted", "unavailable", "blocked", capDec.errorCode);
      return reply.code(403).send(envelope);
    }
    // review fold P2#4：capDec.degraded 时 envelope capability_mode=degraded（端侧感知降级）。
    // handle() 返 envelope 后覆盖 capability_mode + completion_state（degraded+ok→DONE_WITH_CONCERNS）。
    // 注意：需在 handle() 调用后处理，见下。
```

stream route 的 `handle()` 调用后，加 degraded 覆盖：

```typescript
    const { envelope, status } = await handle(
      "content_stream",
      () => backendType === "third_party_api" ? /* 既有 fetchThirdParty 分支 */ : streamBusiness(db, presign, tid, ctx),
      tid,
      requestRegion,
    );
    // review fold P2#4：degraded 覆盖（capability-filter 算出 degraded，streamBusiness 不感知）
    if (capDec.degraded && !capDec.blocked) {
      (envelope as any).capability_mode = "degraded";
      (envelope as any).completion_state = "DONE_WITH_CONCERNS";
    }
    reply.code(status).send(envelope);
```

query/match/lyrics/metadata 同模式插入 capability-filter，但**无 trackFormat/trackBitrate**（这 4 kind 只筛 kind + policyStore fail-closed），且无 degraded 覆盖（无 bitrate 降级）：

```typescript
    const capHeader = req.headers["x-device-capability"] as string | undefined;
    const capability = parseDeviceCapability(capHeader);
    const capDec = await capabilityFilter({ capability, kind: "content_query" /* 对应 kind */, policyStore });
    if (capDec.blocked) {
      const envelope = wrapEnvelope({}, "content_query" /* 对应 kind */, "self_hosted", "unavailable", "blocked", capDec.errorCode);
      return reply.code(403).send(envelope);
    }
```

注意：`policyStore` 在 buildServer 作用域（`src/index.ts:144`），route handler 闭包可访问。

- [ ] **Step 6: 跑测试验证无回归**

Run: `npx vitest run test/policy/ test/integration/route-authorize.e2e.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/policy/capability-filter.ts src/index.ts test/policy/capability-filter.test.ts
git commit -m "feat(m3-stage2): device-capability-filter（drm-guard 前置，format/bitrate 降级优先）

- 新 capability-filter.ts：parseDeviceCapability + capabilityFilter
- kind/format 不支持 → BLOCKED CAPABILITY_UNSUPPORTED；bitrate 超限 → degraded（不 BLOCKED）
- policyStore 故障 fail-closed BACKEND_UNAVAILABLE（不 silent allow）
- 5 kind route 接入（receiveAndAuthorize 后、resolveProviderPath 前）
- capability 与 drm 正交：capability 管设备能力，drm 管版权/region"
```

---

### Task 3: self-hosted-seed（royalty-free 真实曲目填库）

**Files:**
- Create: `src/db/seed/seed.ts`
- Create: `test/fixtures/audio/gen-mp3.sh`（ffmpeg 生成 sine wave MP3，public-domain 占位真实字节）
- Create: `test/fixtures/audio/*.mp3`（生成的 fixture，commit 进 repo）
- Test: `test/db/seed.test.ts`（新建，in-process pg-mem 或 testcontainers）

**Interfaces:**
- Consumes: `ContentDb`（`src/content/db.ts`）、tracks/lyrics 表（`src/db/schema.ts`）、MinIO S3 client
- Produces:
  - `seedSelfHostedCatalog(opts: { db: ContentDb; s3: S3Client; bucket: string; audioDir: string }): Promise<void>`（填 tracks/lyrics 表 + 上传 MP3 到 MinIO）

- [ ] **Step 1: 生成 royalty-free MP3 fixture（ffmpeg sine wave，public-domain）**

Create `test/fixtures/audio/gen-mp3.sh`:

```bash
#!/bin/sh
# 生成 public-domain sine wave MP3 作为 sim 真实字节占位（无版权，可商用）。
# 真实 royalty-free 曲目（如 Kevin MacLeod CC-BY）授权后替换本 fixture。
# 需 ffmpeg；无 ffmpeg 则 skip（test 跳过）。
set -e
cd "$(dirname "$0")"
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" -b:a 128k track1.mp3 2>/dev/null
ffmpeg -y -f lavfi -i "sine=frequency=523:duration=2" -b:a 128k track2.mp3 2>/dev/null
echo "generated track1.mp3 track2.mp3"
```

Run: `sh test/fixtures/audio/gen-mp3.sh`（生成 track1.mp3 + track2.mp3）

若本机无 ffmpeg：`brew install ffmpeg` 后重跑。生成的 MP3 commit 进 repo（小文件，~几 KB）。

- [ ] **Step 2: 写 seed 失败测试**

Create `test/db/seed.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { Pool } from "pg";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { seedSelfHostedCatalog } from "../../src/db/seed/seed.js";
import type { ContentDb } from "../../src/content/db.js";

const REPO_DIR = process.env.M2D_BACKEND_DIR ?? "/Users/lcz/projects/agentos-content-backend";
const MIGRATIONS_DIR = `${REPO_DIR}/src/db/migrations`;
const AUDIO_DIR = `${REPO_DIR}/test/fixtures/audio`;

function dockerAvailable(): boolean {
  if (process.env.DOCKER_HOST) return true;
  try { require("child_process").execSync("docker ps", { stdio: "ignore" }); return true; } catch { return false; }
}
function ffmpegAvailable(): boolean {
  try { require("child_process").execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch { return false; }
}

describe("self-hosted-seed", { skip: !dockerAvailable() || !ffmpegAvailable() }, () => {
  let pg: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let db: ContentDb;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:15-alpine").withDatabase("agentos_content").start();
    minio = await new MinioContainer("minio/minio:latest").start();
    // apply migrations
    for (const f of ["0000_abnormal_wrecking_crew.sql","0001_neat_mystique.sql","0002_dizzy_sway.sql"]) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
      await pg.exec(["psql","-v","ON_ERROR_STOP=1","-U",pg.getUsername(),"-d",pg.getDatabase(),"-c",sql]);
    }
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    db = { async query(text: string, params?: unknown[]) { return pool.query(text, params as any[]); } };
    await pool.end();
    // 用新 pool 给 seed
    const seedPool = new Pool({ connectionString: pg.getConnectionUri() });
    const seedDb: ContentDb = { async query(text: string, params?: unknown[]) { return seedPool.query(text, params as any[]); } };
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    await seedSelfHostedCatalog({ db: seedDb, s3, bucket: "agentos-content-test", audioDir: AUDIO_DIR });
    await seedPool.end();
  }, 240000);

  afterAll(async () => { try { await pg?.stop(); } catch {} try { await minio?.stop(); } catch {} });

  it("tracks 表填入 2 首 self 曲目", async () => {
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query("SELECT track_id, title, format, bitrate, audio_object_key FROM tracks WHERE track_id LIKE 'self:%'");
    await pool.end();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].format).toBe("mp3");
    expect(rows[0].bitrate).toBe(128000);
  });

  it("lyrics 表填入歌词行", async () => {
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM lyrics");
    await pool.end();
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("MP3 文件已上传到 MinIO（HeadObject 成功）", async () => {
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query("SELECT audio_object_key FROM tracks LIMIT 1");
    await pool.end();
    const head = await s3.send(new HeadObjectCommand({ Bucket: "agentos-content-test", Key: rows[0].audio_object_key }));
    expect(head.ContentLength).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: 跑测试验证失败**

Run: `npx vitest run test/db/seed.test.ts`
Expected: FAIL — module not found / tracks 表空

- [ ] **Step 4: 实现 seed.ts**

Create `src/db/seed/seed.ts`:

```typescript
// seed.ts — self_hosted 真实曲目填库（M3 阶段2 U3）。
// 填 tracks/lyrics 表 + 上传 MP3 到 MinIO。
// sim 用 ffmpeg 生成 sine wave MP3（public-domain，真实字节）；真 royalty-free 曲目授权后替换。
import type { ContentDb } from "../../content/db.js";
import type { S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { objectKey } from "../../storage/presign.js";

interface SeedTrack {
  trackId: string;      // self:track1
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  coverUrl: string | null;
  format: "mp3" | "aac" | "flac";
  bitrate: number;
  isrc: string | null;
  license: string;       // "public-domain"
  regionPolicy: string | null;
  mp3File: string;       // test/fixtures/audio/track1.mp3
  lyrics: { lineIndex: number; timestampMs: number; text: string; license: string }[];
}

const SEED_TRACKS: SeedTrack[] = [
  {
    trackId: "self:track1", title: "Sim Sine 440Hz", artist: "AgentOS", album: "Sim Test",
    durationMs: 3000, coverUrl: null, format: "mp3", bitrate: 128000, isrc: null,
    license: "public-domain", regionPolicy: null, mp3File: "track1.mp3",
    lyrics: [
      { lineIndex: 0, timestampMs: 0, text: "[sim sine wave 440Hz]", license: "public-domain" },
    ],
  },
  {
    trackId: "self:track2", title: "Sim Sine 523Hz", artist: "AgentOS", album: "Sim Test",
    durationMs: 2000, coverUrl: null, format: "mp3", bitrate: 128000, isrc: null,
    license: "public-domain", regionPolicy: null, mp3File: "track2.mp3",
    lyrics: [
      { lineIndex: 0, timestampMs: 0, text: "[sim sine wave 523Hz]", license: "public-domain" },
    ],
  },
];

export async function seedSelfHostedCatalog(opts: {
  db: ContentDb;
  s3: S3Client;
  bucket: string;
  audioDir: string;
}): Promise<void> {
  const { db, s3, bucket, audioDir } = opts;
  for (const t of SEED_TRACKS) {
    const key = objectKey("self", t.trackId.replace(/^self:/, ""), 1);
    const mp3Path = join(audioDir, t.mp3File);
    const body = readFileSync(mp3Path);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "audio/mpeg" }));
    // insert tracks（track_id 已含 self: 前缀，parseTrackId 期望 <provider>:<id>）
    await db.query(
      `INSERT INTO tracks (track_id, title, artist, album, duration_ms, cover_url, audio_object_key, format, bitrate, isrc, license, region_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (track_id) DO NOTHING`,
      [t.trackId, t.title, t.artist, t.album, t.durationMs, t.coverUrl, key, t.format, t.bitrate, t.isrc, t.license, t.regionPolicy],
    );
    for (const l of t.lyrics) {
      await db.query(
        `INSERT INTO lyrics (track_id, line_index, timestamp_ms, text, lyrics_license)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (track_id, line_index) DO NOTHING`,
        [t.trackId, l.lineIndex, l.timestampMs, l.text, l.license],
      );
    }
  }
}
```

- [ ] **Step 5: 跑测试验证通过**

Run: `npx vitest run test/db/seed.test.ts`
Expected: PASS（3/3：tracks 填入 + lyrics 填入 + MinIO HeadObject 成功）

- [ ] **Step 6: Commit**

```bash
git add src/db/seed/seed.ts test/fixtures/audio/ test/db/seed.test.ts
git commit -m "feat(m3-stage2): self-hosted-seed 填 royalty-free 真实曲目

- seed.ts：填 tracks/lyrics 表 + 上传 MP3 到 MinIO（2 首 sine wave 占位，public-domain）
- gen-mp3.sh：ffmpeg 生成 sine wave MP3（真实字节，sim 占位；真 royalty-free 曲目授权后替换）
- testcontainers pg+minio e2e 验证填库 + MinIO HeadObject"
```

---

### Task 4: 5 kind 真实数据集成测试（query→match→stream→lyrics→metadata 闭环）

**Files:**
- Create: `test/integration/m3-stage2-self-hosted-loop.e2e.test.ts`
- 无新生产代码（本 task 验证 U3 填库后 5 kind 自然真实 + U1/U2 接入）

**Interfaces:**
- Consumes: Task 1/2/3 产物（caller-auth-matrix + capability-filter + seed）

- [ ] **Step 1: 写集成测试**

Create `test/integration/m3-stage2-self-hosted-loop.e2e.test.ts`:

```typescript
// 5 kind 真实数据闭环：seed 填库后，device-hub caller 调 5 kind 全链。
// testcontainers pg+minio + in-process buildServer（注入 testcontainers db/s3 + seed）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { Pool } from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { buildServer } from "../../src/index.js";
import { seedSelfHostedCatalog } from "../../src/db/seed/seed.js";
import type { ContentDb } from "../../src/content/db.js";

const REPO_DIR = process.env.M2D_BACKEND_DIR ?? "/Users/lcz/projects/agentos-content-backend";
const MIGRATIONS_DIR = `${REPO_DIR}/src/db/migrations`;
const AUDIO_DIR = `${REPO_DIR}/test/fixtures/audio`;

function dockerAvailable(): boolean {
  if (process.env.DOCKER_HOST) return true;
  try { require("child_process").execSync("docker ps", { stdio: "ignore" }); return true; } catch { return false; }
}
function ffmpegAvailable(): boolean {
  try { require("child_process").execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch { return false; }
}

describe("M3 阶段2 self_hosted 5 kind 闭环", { skip: !dockerAvailable() || !ffmpegAvailable() }, () => {
  let pg: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let app: import("fastify").FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:15-alpine").withDatabase("agentos_content").start();
    minio = await new MinioContainer("minio/minio:latest").start();
    for (const f of ["0000_abnormal_wrecking_crew.sql","0001_neat_mystique.sql","0002_dizzy_sway.sql"]) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
      await pg.exec(["psql","-v","ON_ERROR_STOP=1","-U",pg.getUsername(),"-d",pg.getDatabase(),"-c",sql]);
    }
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const db: ContentDb = { async query(text: string, params?: unknown[]) { return pool.query(text, params as any[]); } };
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    await seedSelfHostedCatalog({ db, s3, bucket: "agentos-content-test", audioDir: AUDIO_DIR });
    app = await buildServer({ db, s3, bucket: "agentos-content-test" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
    await pool.end();
  }, 240000);

  afterAll(async () => { try { await app?.close(); } catch {} try { await pg?.stop(); } catch {} try { await minio?.stop(); } catch {} });

  const headers = (cap?: string) => ({
    "content-type": "application/json",
    "x-caller-identity": "device-hub",
    "x-device-capability": cap ?? JSON.stringify({ kinds: ["content_query","content_match","content_stream","content_lyrics","content_metadata"], formats: ["mp3"], maxBitrate: 128000, region: "cn" }),
  });

  it("query → 返 self 曲目 candidates", async () => {
    const r = await fetch(`${baseUrl}/content_query`, { method: "POST", headers: headers(), body: JSON.stringify({ query: { keywords: ["Sim"] } }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.backend_type).toBe("self_hosted");
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates[0].track_id).toMatch(/^self:/);
  });

  it("match → 返 match+track", async () => {
    const r = await fetch(`${baseUrl}/content_match`, { method: "POST", headers: headers(), body: JSON.stringify({ match: { title: "Sim Sine 440Hz" } }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.match.track_id).toBe("self:track1");
    expect(body.track.title).toBe("Sim Sine 440Hz");
  });

  it("stream → 返真 presigned URL（HTTP GET 拉 MP3 字节非空）", async () => {
    const r = await fetch(`${baseUrl}/content_stream`, { method: "POST", headers: headers(), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toMatch(/^http/);
    expect(body.format).toBe("mp3");
    // 真实拉取 MP3 字节
    const mp3Res = await fetch(body.url);
    const buf = Buffer.from(await mp3Res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // MP3 magic：ID3 或 frame sync（0xFF 0xE/0xF）
    expect(buf[0] === 0x49 || buf[0] === 0xff).toBe(true); // 'I'(ID3) 或 0xff(frame sync)
  });

  it("lyrics → 返歌词行", async () => {
    const r = await fetch(`${baseUrl}/content_lyrics`, { method: "POST", headers: headers(), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.lines.length).toBeGreaterThanOrEqual(1);
  });

  it("metadata → 返 track metadata", async () => {
    const r = await fetch(`${baseUrl}/content_metadata`, { method: "POST", headers: headers(), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.title).toBe("Sim Sine 440Hz");
    expect(body.duration_ms).toBe(3000);
  });

  it("capability 筛选：端侧不支持 content_lyrics → 403 CAPABILITY_UNSUPPORTED", async () => {
    const cap = JSON.stringify({ kinds: ["content_query"], formats: ["mp3"], maxBitrate: 128000 });
    const r = await fetch(`${baseUrl}/content_lyrics`, { method: "POST", headers: headers(cap), body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("CAPABILITY_UNSUPPORTED");
  });
});
```

- [ ] **Step 2: 跑测试验证通过**

Run: `npx vitest run test/integration/m3-stage2-self-hosted-loop.e2e.test.ts`
Expected: PASS（6/6）

- [ ] **Step 3: Commit**

```bash
git add test/integration/m3-stage2-self-hosted-loop.e2e.test.ts
git commit -m "test(m3-stage2): 5 kind 真实数据闭环 e2e（query→match→stream→lyrics→metadata + capability 筛选）

- seed 填库后 device-hub caller 调 5 kind 全链 self_hosted 真实曲目
- stream 真实拉取 presigned URL MP3 字节校验（magic header + 非空）
- capability 筛选：端侧不支持 lyrics kind → 403 CAPABILITY_UNSUPPORTED"
```

---

### Task 5: content_request envelope 契约提议文档（U5，归 AgentOS shared-protocols 窗口A 落地）

**Files:**
- Create: `docs/superpowers/contracts/2026-07-05-content-request-envelope-proposal.md`（契约提议文档，非落地）

**Interfaces:**
- 无代码改动，纯文档

- [ ] **Step 1: 写契约提议文档**

Create `docs/superpowers/contracts/2026-07-05-content-request-envelope-proposal.md`:

````markdown
# content_request envelope 契约提议（M3 阶段2 U5）

> 窗口C 提议，schema 落地归窗口A（AgentOS 主仓 `shared-protocols/schemas/`）。
> 本文档是契约提议，非落地实现。窗口C 在 content-backend 侧消费 `X-Device-Capability` header（Task 2），schema 落地后可切到 envelope 字段。

## 1. device_capability 字段

content_request envelope 扩 `device_capability` 字段（端侧能力声明，device-hub 转发时注入）：

```json
{
  "kind": "content_stream",
  "track_id": "self:track1",
  "device_capability": {
    "kinds": ["content_query","content_match","content_stream","content_lyrics","content_metadata"],
    "formats": ["mp3"],
    "max_bitrate": 128000,
    "region": "cn"
  }
}
```

字段语义：
- `kinds`: 端侧支持的 kind 列表
- `formats`: 支持的音频格式（mp3/aac/flac）
- `max_bitrate`: 最大比特率（bps）
- `region`: 端侧 region（与 drm region_restrict 交互）

## 2. device-hub caller principal + ^hub: secret_handle 形态

- `X-Caller-Identity: device-hub`（inbound 白名单，self_hosted 路径）
- `^hub:` secret_handle 前缀（真机/secret-store 落地后；sim 阶段不发 handle，trust network）
- device-hub 只允许 `self_hosted` backend_type（caller×backend_type 矩阵，Task 1）
- 真机 mTLS + 真 handle defer M3-pre secret store SDD

## 3. 归属

- schema 落地：AgentOS 主仓 `shared-protocols/schemas/content-request-envelope.schema.json`（窗口A）
- device-hub 侧实现（HTTP client + identity 注入）：窗口A
- content-backend 侧消费：本窗口（Task 2 capability-filter 消费 `X-Device-Capability` header，schema 落地后切 envelope 字段）
````

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/contracts/2026-07-05-content-request-envelope-proposal.md
git commit -m "docs(m3-stage2): content_request envelope 契约提议（device_capability + device-hub caller principal）

- U5 提议契约，schema 落地归窗口A AgentOS shared-protocols
- device_capability 字段（kinds/formats/max_bitrate/region）
- device-hub caller principal + ^hub: handle 形态（sim 不持 handle，真机 defer M3-pre）
- content-backend 侧消费 X-Device-Capability header（Task 2），schema 落地后切 envelope 字段"
```

---

### Task 6: U7 e2e（mock device-hub caller + third_party mock provider + docker 全链）

**Files:**
- Create: `test/integration/m3-stage2-e2e.test.ts`（spawn backend + mock device-hub caller + third_party mock provider）

**Interfaces:**
- Consumes: Task 1-3 产物（caller-auth-matrix + capability-filter + seed），M2d 既有 mock provider 范式

- [ ] **Step 1: 写 e2e 测试**

Create `test/integration/m3-stage2-e2e.test.ts`（参照 `m2d-e2e.test.ts` spawn + testcontainers 范式）:

```typescript
// M3 阶段2 e2e：spawn backend + mock device-hub caller + third_party mock provider。
// 验收：
//   1. device-hub caller + self_hosted query → 200 DONE（seed 填库后真实曲目）
//   2. device-hub caller + provider=qq (third_party) → 403 backend_type_not_allowed
//   3. device-hub caller + content_stream → 200 + presigned URL → 真 HTTP GET 拉 MP3 字节
//   4. device-hub caller + X-Device-Capability 不支持 lyrics → 403 CAPABILITY_UNSUPPORTED
//   5. 伪造 X-Caller-Identity: content-backend → anonymous → 403
//   6. audit JSONL 记 device-hub caller（self_hosted 无 handle 不 emit secret_handle audit，但 tool_call audit 记 actor）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createNetServer } from "node:net";
import { Pool } from "pg";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSelfHostedCatalog } from "../../src/db/seed/seed.js";
import type { ContentDb } from "../../src/content/db.js";

const REPO_DIR = process.env.M2D_BACKEND_DIR ?? "/Users/lcz/projects/agentos-content-backend";
const MIGRATIONS_DIR = `${REPO_DIR}/src/db/migrations`;
const AUDIO_DIR = `${REPO_DIR}/test/fixtures/audio`;

function dockerAvailable(): boolean {
  if (process.env.DOCKER_HOST) return true;
  try { execSync("docker ps", { stdio: "ignore" }); return true; } catch { return false; }
}
function ffmpegAvailable(): boolean {
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch { return false; }
}
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer(); s.unref(); s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
  });
}

describe("M3 阶段2 e2e (device-hub 直连 + self_hosted 真实曲目)", { skip: !dockerAvailable() || !ffmpegAvailable() }, () => {
  let pg: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let backendProc: ChildProcess;
  let backendUrl: string;
  let auditPath: string;

  beforeAll(async () => {
    auditPath = join(tmpdir(), `m3-stage2-audit-${process.pid}.jsonl`);
    if (existsSync(auditPath)) unlinkSync(auditPath);
    pg = await new PostgreSqlContainer("postgres:15-alpine").withDatabase("agentos_content").start();
    minio = await new MinioContainer("minio/minio:latest").start();
    for (const f of ["0000_abnormal_wrecking_crew.sql","0001_neat_mystique.sql","0002_dizzy_sway.sql"]) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
      await pg.exec(["psql","-v","ON_ERROR_STOP=1","-U",pg.getUsername(),"-d",pg.getDatabase(),"-c",sql]);
    }
    // seed 填库（用 testcontainers pg pool + minio s3）
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const db: ContentDb = { async query(text: string, params?: unknown[]) { return pool.query(text, params as any[]); } };
    const { S3Client } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() }, forcePathStyle: true });
    await seedSelfHostedCatalog({ db, s3, bucket: "agentos-content-test", audioDir: AUDIO_DIR });
    await pool.end();
    const port = await getFreePort();
    backendUrl = `http://127.0.0.1:${port}`;
    backendProc = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        DATABASE_URL: pg.getConnectionUri(),
        S3_ENDPOINT: minio.getConnectionUrl(),
        S3_ACCESS_KEY_ID: minio.getUsername(),
        S3_SECRET_ACCESS_KEY: minio.getPassword(),
        S3_BUCKET: "agentos-content-test",
        S3_REGION: "us-east-1",
        CONTENT_BACKEND_REGION: "cn",
        AUDIT_SINK_PATH: auditPath,
        PORT: String(port),
      },
      stdio: "pipe",
    });
    backendProc.stderr?.on("data", (d) => { if (process.env.M3_E2E_DEBUG) console.error("[backend]", d.toString()); });
    // wait ready
    for (let i = 0; i < 90; i++) {
      try { const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: { keywords: [] } }) }); if (r.ok || r.status === 400 || r.status === 403 || r.status === 500) break; } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 240000);

  afterAll(async () => {
    try { backendProc?.kill("SIGTERM"); } catch {}
    try { await pg?.stop(); } catch {}
    try { await minio?.stop(); } catch {}
    try { if (auditPath && existsSync(auditPath)) unlinkSync(auditPath); } catch {}
  });

  beforeEach(() => { try { if (existsSync(auditPath)) unlinkSync(auditPath); } catch {} });

  const cap = JSON.stringify({ kinds: ["content_query","content_match","content_stream","content_lyrics","content_metadata"], formats: ["mp3"], maxBitrate: 128000, region: "cn" });

  it("#1 device-hub + self_hosted query → 200 DONE + 真实 candidates", async () => {
    const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": cap }, body: JSON.stringify({ query: { keywords: ["Sim"] } }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.backend_type).toBe("self_hosted");
    expect(body.completion_state).toBe("DONE");
    expect(body.candidates[0].track_id).toMatch(/^self:/);
  });

  it("#2 device-hub + provider=qq (third_party) → 403 backend_type_not_allowed", async () => {
    const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": cap }, body: JSON.stringify({ provider: "qq", query: { keywords: ["k"] } }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("AUTH_FAILED");
  });

  it("#3 device-hub + content_stream → 200 + presigned URL → 真 HTTP GET 拉 MP3 字节", async () => {
    const r = await fetch(`${backendUrl}/content_stream`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": cap }, body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toMatch(/^http/);
    const mp3Res = await fetch(body.url);
    const buf = Buffer.from(await mp3Res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0] === 0x49 || buf[0] === 0xff).toBe(true);
  });

  it("#4 device-hub + X-Device-Capability 不支持 lyrics → 403 CAPABILITY_UNSUPPORTED", async () => {
    const capNoLyrics = JSON.stringify({ kinds: ["content_query"], formats: ["mp3"], maxBitrate: 128000 });
    const r = await fetch(`${backendUrl}/content_lyrics`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "device-hub", "x-device-capability": capNoLyrics }, body: JSON.stringify({ track_id: "self:track1" }) });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error_code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("#5 伪造 X-Caller-Identity: content-backend → 403 anonymous 归一化", async () => {
    const r = await fetch(`${backendUrl}/content_query`, { method: "POST", headers: { "content-type": "application/json", "x-caller-identity": "content-backend" }, body: JSON.stringify({ query: { keywords: ["any"] } }) });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑 e2e 验证通过**

Run: `npx vitest run test/integration/m3-stage2-e2e.test.ts`
Expected: PASS（5/5）

- [ ] **Step 3: 跑全部测试套件验证无回归**

Run: `pnpm test`
Expected: 全部 PASS（既有 M2b/M2c/M2d 测试 + 新 M3 阶段2 测试）

- [ ] **Step 4: build 验证**

Run: `pnpm build`
Expected: tsc 编译通过，无 type error

- [ ] **Step 5: Commit**

```bash
git add test/integration/m3-stage2-e2e.test.ts
git commit -m "test(m3-stage2): e2e mock device-hub caller + self_hosted 真实曲目 + stream URL 真实拉取

- spawn backend + testcontainers pg+minio + seed 填库
- device-hub caller self_hosted query/stream/lyrics 全链 + capability 筛选
- device-hub + third_party 越权 → 403 backend_type_not_allowed
- stream presigned URL 真 HTTP GET 拉 MP3 字节校验
- 伪造 caller → anonymous 归一化 403 spoof 防御"
```

---

## Self-Review

### 1. Spec coverage
- U1 caller-auth-matrix 扩 device-hub + caller×backend_type → Task 1 ✓
- U2 device-capability-filter → Task 2 ✓
- U3 self-hosted-seed → Task 3 ✓
- U4 5 kind 全接通真实数据 → Task 4（集成测试验证）✓
- U5 content_request 契约提议 → Task 5 ✓
- U6 cloud-ext 不改 → 无 task（spec §6 明确 defer）✓
- U7 e2e → Task 6 ✓
- §3 数据流（device-hub 调用契约 + 5 kind + stream 回流 + third_party defer）→ Task 1/4/6 覆盖 ✓
- §4 错误处理（capability 降级/BLOCKED + backend_type 越权 + fail-closed）→ Task 1/2/6 覆盖 ✓
- §5 测试策略（单测/集成/e2e/跨窗口 defer）→ Task 1-6 覆盖 ✓
- §6 非目标（cloud-ext/device-hub 实现/端侧/schema 落地/真 provider/IAM）→ 各 task "不做" 段落明示 ✓

### 2. Placeholder scan
- 无 TBD/TODO/"implement later"/"add error handling" ✓
- 每个 step 有 exact code block ✓
- royalty-free MP3 用 ffmpeg 生成（明确，无"找曲目"占位）✓

### 3. Type consistency
- `ALLOWED_BACKEND_TYPES` Task 1 定义 → Task 1 route 层消费，类型 `Record<string, BackendType[]>` 一致 ✓
- `authorizeBackendType(caller, backendType)` Task 1 定义 → route 层调用签名一致 ✓
- `DeviceCapability` / `parseDeviceCapability` / `capabilityFilter` / `CapabilityDecision` Task 2 定义 → Task 4/6 测试调用一致 ✓
- `seedSelfHostedCatalog({db, s3, bucket, audioDir})` Task 3 定义 → Task 4/6 调用一致 ✓
- `INBOUND_ALLOWED_CALLERS` Task 1 扩 → `normalizeInboundCaller` 行为一致 ✓
- error_code `CAPABILITY_UNSUPPORTED` / `backend_type_not_allowed`（reason）→ spec §4 一致（注意：`backend_type_not_allowed` 是 reason 非 ErrorCode，route 层返 AUTH_FAILED，spec §4 已说明）✓

### 4. 跨窗口边界
- cloud-ext 零改动（Task 1-6 无 cloud-ext 文件）✓
- device-hub 实现归窗口A（Task 5 契约提议明示）✓
- content_request schema 落地归窗口A（Task 5 明示）✓

无 spec gap，无 placeholder，类型一致。Plan ready。

---

## REVIEW FOLD（plan-eng + fresh-context subagent，2026-07-05）

> plan-eng-review 3 findings + fresh-context subagent 8 findings（codex gpt-5.5 stream disconnect 降级，见 GSTACK REVIEW REPORT）。已 fold 11 项，P3 minor defer。

### plan-eng findings（3，全 fold）
- **A1 (P2)** stream format/bitrate 降级未实现 → **fold**：Task 2 Step 5 stream route 先查 tracks format/bitrate 再调 capability-filter（传 trackFormat/trackBitrate），degraded 传到 envelope（与 P2#4 合并）。**已改 Task 2 Step 5 code**。
- **A3 (P2)** spec U2 "capability_policy 消费" 措辞歧义 → **fold**：修 spec U2 措辞（capability_policy 归端侧 ops 下发，content-backend 消费 device_capability）。**已改 spec**。
- **C1 (P2)** Task 3/4/6 测试 `require("child_process")` ESM 不兼容 → **fold**：implementer 执行 Task 3/4/6 时，`dockerAvailable()`/`ffmpegAvailable()` 改 `import { execSync } from "node:child_process"`（与既有 m2d-e2e.test.ts 一致）。**implementer 指令**。

### fresh-context subagent findings（8，2 false-positive + 6 fold）
- **P1#1 (P1, false positive)** secret-handle-hook.ts 列 Modify 无 step → 验证 `secret-handle-hook.ts:74` !handle 短路**存在** → **fold**：Task 1 Files 从 Modify 移除 secret-handle-hook.ts（不改）。**已改 Task 1 Files**。
- **P1#2 (P1, sim known hole)** device-hub 伪 X-Caller-Identity: cloud-ext + 无 handle → !handle 短路 authorized as cloud-ext → 可调 third_party（矩阵被 header 伪造击穿）。M2d 既有 cloud-ext 无 handle + third_party 200 是设计行为，加 handle 要求会破坏。→ **fold A（老林确认）**：记 sim known hole + Task 6 加 test 验证 spoof 路径（device-hub 伪 cloud-ext + 无 handle + provider=qq → 当前 200，标 known hole）+ mTLS remediation（真机/M5 绑定 caller cert）。与 spec D5 sim 明文 + mTLS defer 一致。**implementer 指令：Task 6 加 #6 test**。
- **P2#3 (P2)** capability-filter fail-closed 探测在 !capability 短路之前 → **fold**：!capability 短路提到 policyStore 探测之前。**已改 Task 2 Step 3 code**。**implementer 指令：Task 2 Step 1 单测加 "无 cap + failStore → 放行" case**（验证短路顺序）。
- **P2#4 (P2)** capabilityFilter 返 degraded 但 route 层 wrapEnvelope 没设 capability_mode=degraded → **fold**：stream route handle() 后覆盖 envelope.capability_mode=degraded + completion_state=DONE_WITH_CONCERNS。**已改 Task 2 Step 5 code**。**implementer 指令：Task 4/6 加 degraded 路径测试**（trackBitrate 320000 + maxBitrate 128000 → DONE_WITH_CONCERNS + capability_mode=degraded）。
- **P2#5 (P2)** spec §5.3 e2e 要求 audit JSONL hash chain 验证，Task 6 无 audit 断言 → **fold**：Task 6 加 #7 test（读 auditPath JSONL，断言 device-hub actor 记录 + hash chain，复用 m2b/m2d audit 校验范式）。**implementer 指令：Task 6 加 #7**。
- **P2#6 (P2)** Task 6 #2 只测 body provider=qq，未测 track_id 前缀驱动 third_party 路径 → **fold**：Task 6 加 #8 test（device-hub + track_id="qq:xxx" 无 provider 字段 → 403 AUTH_FAILED，验证 authorizeBackendType 拦 track_id 前缀解析的 third_party 路径）。**implementer 指令：Task 6 加 #8**。
- **P2#7 (P2, false positive)** Task 4 buildServer({db,s3,bucket}) in-process 注入 → 验证 `index.ts:124 BuildServerOpts` 接受 db/s3/bucket/presign/... → **fold**：plan 注释引用 BuildServerOpts 签名。**已验证接受，implementer 按既有签名注入**。
- **P3#8 (P3)** migration 文件名硬编码 3 处 → **fold**：Task 3/4/6 改 `readdirSync(MIGRATIONS_DIR).sort()` 动态读 migration 文件。**implementer 指令**。

### P3 minor defer（不 fold，sim 可接受）
- A2 latestPolicy 两次调用（capability-filter + drm-guard）——sim 可接受，生产缓存 defer
- C2 5 route authorizeBackendType 重复——surgical 沿用既有 5 route 重复模式，抽 helper defer
- C3 seed SEED_TRACKS hardcoded 2 首——sim 占位可接受
- T1 device-hub caller audit——与 P2#5 合并 fold
- T2 lyrics restricted blocked 集成层——M2b 单测已覆盖 lyricsBusiness restricted 逻辑，集成层 defer
- P1 perf latestPolicy 两次——同 A2
- P2 perf queryTracks ILIKE 全表扫——sim 小库可接受，生产 GIN/trigram 索引 defer

### 降级记录（model-routing §3）— 已补跑闭环
- plan-eng-review 阶段 codex gpt-5.5 实际调用但 stream disconnect（token.longshine.com 网络问题，2 次重试失败），降级 fresh-context 同模型 subagent 替代
- **补跑闭环**：code-review 阶段 codex 成功（97195 tokens high，2C+8I）；plan review 阶段补跑 codex 成功（26323 tokens medium，8 plan-level findings）——跨厂商实际产出，闭环满足

### codex plan review 补跑（26323 tokens medium，8 findings）
plan-eng-review 阶段 codex stream disconnect 后，于 finishing 前补跑成功。8 plan-level findings：

**FIX NOW（spec 内部不一致，2 项，全修）**：
- #6 §5.2 line 181：A3 fold 没改全，§5.2 仍说 capability_policy push 影响 5 kind——与 §U2 矛盾 → 修 spec §5.2（device_capability header 驱动）
- #8 §6 U6：cloud-ext "零改动"不准（schema sync 改了 cloud-ext schema）→ 修 spec U6 措辞（仅 schema sync 无代码改动 + 验证边界）

**DEFER 文档化（跨窗口/sim 边界，6 项）**：
- #1 §3.2 auth 顺序：receiveAndAuthorize 在 resolveProviderPath 前（不依赖 backend_type），authorizeBackendType 在后（依赖）——spec 措辞 gap，实现两阶段 auth 正确
- #2 §U2 per-kind applicability：capability-filter 5 kind 共享但 format/bitrate 降级仅 stream（query/match/lyrics/metadata 只筛 kind）——spec 措辞像所有 kind format/bitrate，实现 per-kind
- #3 §U3 降级 variants：tracks 表一行一 track 无 variants，但 sim 降级是标签（capDec.degraded）非真实转码——plan 注释"sim 不做真实转码"
- #4 §3.3 stream URL 投递契约：device-hub 如何处理 presigned URL（转发/rewrite/proxy/redact/expiry）未定义——跨窗口 contract gap，defer 窗口A + 跨窗口协调
- #5 §U5 migration rule：测试用 header contract，最终 envelope 字段——migration 路径 defer 窗口A schema 落地
- #7 §3.4 third_party mock scope：阶段2 花 budget 在 third_party mock（link4 regression）——T6 #6 known hole 验证需要，可辩护

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | CLEAR | plan review 补跑 8 findings（2 FIX NOW spec + 6 DEFER）+ code review 2C+8I（4 FIX NOW 修） |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 findings, 3 fold (A1/A3/C1) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** plan review 补跑成功（26323 tokens medium）8 findings 全 fold（2 spec 内部不一致 FIX NOW + 6 DEFER 文档化）；code review 成功（97195 tokens high）2C+8I 4 FIX NOW 修（I1 degraded 守卫/I2 verifyChain/I6 regen generated/I7 http-mapping 403）。
- **CROSS-MODEL:** codex plan review 独有 #4 stream URL 投递契约 / #5 migration rule / #7 third_party scope / #8 cloud-ext 边界（fresh-context 未 catch）；codex code review 独有 I6 generated stale / I7 http-mapping 503（fresh-context 未 catch）——跨厂商盲点覆盖到位。
- **VERDICT:** ENG + CODEX CLEARED — plan-eng 3 + fresh-context 6 + codex plan 8 + codex code 2C+8I = 29 findings 全 fold/defer；跨厂商实际产出（plan + code 两阶段）；spec 内部不一致已修。

NO UNRESOLVED DECISIONS
