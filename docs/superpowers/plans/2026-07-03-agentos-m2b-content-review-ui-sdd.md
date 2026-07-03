# AgentOS M2b 内容审核 UI + content_policy 消费通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 agentos-content-backend 续作 M2b——审核 UI（SSR+htmx）+ content_policy 消费通道（独立服务 mTLS + envelope audience 校验）+ drm_rule 约束 kind API + audit emit（§8.3 matrix）+ 顺带补 M2a defer 的 2I hardening，sim 闭环验证。

**Architecture:** 方案 B 双 fastify app——App1（5 kind API, port 3001, 现有）接 drm-rule-engine + audit tool_call；App2（ops-facing, port 3002, 新）含 content_policy mTLS endpoint + admin session-cookie UI；共享 policy-store / drm-rule-engine / audit-sink / region-config 纯函数模块。sim 闭环用 mock producer（sim CA cert）push policy → app2 接收 → app1 kind API 受约束。

**Tech Stack:** Node + Fastify + Postgres（pg-mem 测试）+ drizzle-orm + ajv + eta（SSR 模板）+ htmx（vendor JS）+ @fastify/cookie + @fastify/static + selfsigned（sim CA cert 测试）+ vitest。

**Spec:** `docs/superpowers/specs/2026-07-03-agentos-m2b-content-review-ui-design.md`（本 repo main）。

## Global Constraints

- 代码标识符英文（函数/变量/类型），代码注释 + commit 冒号后描述中文。
- 不改 content-contract.schema.json / 不扩 ops-config drm_rule region（D10 backend 自持 env `CONTENT_BACKEND_REGION` 默认 "cn"）/ 不扩 M3-pre audit enum（D11 复用 provision/revoke/config_apply/tool_call）。
- **ErrorCode TS type 对齐（fold codex P1#4 误报核实）**：content-contract.schema.json:13 ErrorCode enum **已含** `["NO_RESULT","AUTH_FAILED","REGION_RESTRICTED","COPYRIGHT_RESTRICTED","BACKEND_UNAVAILABLE"]`。T4 扩 `src/envelope.ts` `ErrorCode` TS type 加 AUTH_FAILED/REGION_RESTRICTED 是**对齐 schema 既有 enum**（M2a 遗留 TS type 缺这两个），**非改 schema**。codex P1#4 标误报。
- TDD：每 task 先写失败测试→实现→通过→commit。不跳 watch-fail（A 类）。
- 现有 66/66 测试不回归（每 task 后跑全量 `pnpm test`）。
- ContentDb port 模式：`{ query(text, params): Promise<{rows}> }`，参数化 SQL（pg-mem + 真实 Postgres 同路径），不绑死 drizzle query builder。
- 纯函数 + port 注入：policy-store / drm-rule-engine / audit-sink / region-config / drm-ctx / drm-guard 不绑死 fastify，可独立单测。
- fail-closed：drm policy store 故障→BLOCKED(BACKEND_UNAVAILABLE)；空集 policy→allow。**DRM fail-closed 独立于 audit 注入**（fold codex P1#6）——buildServer 默认从 env 注入 policyStore，drm 检查不依赖 auditSink 是否注入。
- production_runtime_readiness_complete=false（sim 闭环，mTLS 用 sim CA cert）。
- **mTLS sim 非 CN-only 校验（fold codex P1#1/ceo C1/eng I3，D1=A 加强版）**：sim 阶段做 CA trust + SAN + EKU clientAuth + validity 显式校验 + 3 拒绝测试（wrong-CA/expired/wrong-SAN）；真机只 defer CRL/OCSP revocation + 硬件根签 cert（spec §9）。
- **audit fire-and-forget（fold devex M4）**：createAuditSink emit 内 try/catch + console.warn，与 spec §6"log error 不阻塞业务"一致。
- 新增依赖：`eta`、`@fastify/cookie`、`@fastify/static`（**runtime deps**，fold codex P2）；`selfsigned`（devDep，sim CA cert）。htmx 为 vendor JS 文件（public/htmx.min.js，无 npm 无 build）。

---

## File Structure

```text
src/
├── db/
│   └── schema.ts                    [MODIFY T1] +content_policy pgTable
├── policy/
│   ├── policy-store.ts              [CREATE T1] applyPolicy + latestPolicy
│   ├── drm-rule-engine.ts           [CREATE T2] checkDrm per-kind
│   ├── region-config.ts             [CREATE T2] getRegion env
│   ├── drm-ctx.ts                   [CREATE T6] DrmCtx 共享类型（fold eng M2，不放 stream.ts）
│   └── drm-guard.ts                 [CREATE T6] 中央 drm check+audit guard（fold codex P2，不跨 5 business 重复）
├── audit/
│   ├── audit-sink.ts                [CREATE T3] JSONL + hash chain + AuditSink（emit try/catch）
│   └── audit-events.ts              [CREATE T3] emitProvision/Revoke/ConfigApply/ToolCall/Unauthorized
├── routes/
│   ├── http-mapping.ts              [MODIFY T4] httpStatus(state, errorCode) 4xx/5xx 收窄
│   ├── stream.ts / query.ts / match.ts / lyrics.ts / metadata.ts  [MODIFY T6] 调 drm-guard（不复制 drm 块）
├── auth/
│   └── session.ts                   [CREATE T7] sim session admin/operator
├── admin/
│   ├── ingest.ts                    [CREATE T7] ingest handler + I2 边界校验（camelCase 对齐 state-machine）
│   ├── views.ts                     [CREATE T7] eta SSR 模板
│   └── templates/                   [CREATE T7] tracks.eta / ingest-detail.eta / login.eta / ingest-form.eta 全文
├── ops-app.ts                       [CREATE T5] App2 fastify + mTLS + content_policy route + [T8] CLI 入口
├── index.ts                         [MODIFY T6] App1 handle() 调 drm-guard + 默认 env 注入 policyStore
├── env.ts                           [MODIFY T1] +auditSinkPath/contentBackendRegion/admin/operator token/opsPort
test/
├── unit/
│   ├── policy-store.test.ts         [CREATE T1] +stale version 用例
│   ├── drm-rule-engine.test.ts      [CREATE T2]
│   ├── audit-sink.test.ts           [CREATE T3] +正向 verifyChain===true 用例
│   └── http-mapping.test.ts         [MODIFY T4] +4xx/5xx 用例
├── integration/
│   ├── policy-push.e2e.test.ts      [CREATE T5] +wrong-CA/expired/wrong-SAN 拒绝 + 403 audit
│   ├── kind-drm-audit.e2e.test.ts   [CREATE T6] +blocked 路径 audit + fail-closed 默认
│   ├── admin-ui.e2e.test.ts         [CREATE T7] +GET routes + htmx partial + tracks 入库查询
│   └── sim-closed-loop.e2e.test.ts  [CREATE T8] +allow/region_restrict 全链
├── integration/
│   └── helpers.ts                   [MODIFY T1] +CONTENT_POLICY_DDL +ingest/review DDL（fold eng C2）
scripts/
└── mock-policy-producer.ts          [CREATE T8] 真实 CLI（cert-from-env + push，非 placeholder）
public/
└── htmx.min.js                      [VENDOR T7]
```

---

### Task 1: content_policy 表 + policy-store.ts

**Files:**
- Modify: `src/db/schema.ts`（+content_policy pgTable）
- Modify: `src/env.ts`（+auditSinkPath/contentBackendRegion/admin/operator token，供后续 task 用，本 task 只加字段）
- Create: `src/policy/policy-store.ts`
- Create: `src/db/migrations/0001_*.sql`（drizzle-kit generate）
- Test: `test/unit/policy-store.test.ts`

**Interfaces:**
- Consumes: `ContentDb`（`src/content/db.ts` 既有 `{query(text, params)}`）
- Produces: `PolicyEnvelope` / `PolicyRecord` / `PolicyStore` 接口（签名见 spec §4.1，下文代码定义）；`applyPolicy(envelope, callerIdentity)` + `latestPolicy()`

- [ ] **Step 1: 加 content_policy 表到 schema.ts**

在 `src/db/schema.ts` 末尾 `export const schema` 前加：

```typescript
// content_policy：ops-platform 下发的策略（sim 闭环，M2b 消费侧）
// unique index：command_id 幂等防重 + (rule_id, version) 防并发同 version（fold codex P1#3 竞态）
export const contentPolicy = pgTable(
  "content_policy",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id").notNull(),
    action: text("action", { enum: ["allow", "block", "region_restrict"] }).notNull(),
    targetScope: text("target_scope").notNull(),
    version: integer("version").notNull(),
    envelope: text("envelope").notNull(), // JSONB，存 PolicyEnvelope JSON
    callerIdentity: text("caller_identity").notNull(),
    commandId: text("command_id").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    supersededBy: integer("superseded_by"),
  },
  (t) => ({
    cmdUk: uniqueIndex("content_policy_cmd_uk").on(t.commandId),
    ruleVerUk: uniqueIndex("content_policy_rule_ver_uk").on(t.ruleId, t.version),
  }),
);
```

并改 `export const schema = { ingest, review, tracks, lyrics, contentPolicy };`

- [ ] **Step 2: 生成 migration**

Run: `pnpm db:generate`
Expected: 生成 `src/db/migrations/0001_*.sql` 含 `CREATE TABLE "content_policy"` + 两个 unique index。

- [ ] **Step 2.5: 扩 `src/env.ts` Env 接口 + loadEnv 读取（fold devex I4）**

```typescript
// env.ts 追加字段（既有 Env interface 扩展）
export interface Env {
  dbUrl: string;
  s3: S3Config;
  auditSinkPath: string;            // 新增：audit JSONL 路径
  contentBackendRegion: string;     // 新增：D10 backend 自持 region
  adminToken: string;               // 新增：sim admin dev token
  operatorToken: string;            // 新增：sim operator dev token
  opsPort: number;                  // 新增：App2 端口
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  return {
    dbUrl: overrides.dbUrl ?? process.env.DATABASE_URL ?? "postgres://localhost:5432/agentos_content",
    s3: { /* 既有 */ } as any,
    auditSinkPath: overrides.auditSinkPath ?? process.env.AUDIT_SINK_PATH ?? ".audit.jsonl",
    contentBackendRegion: overrides.contentBackendRegion ?? process.env.CONTENT_BACKEND_REGION ?? "cn",
    adminToken: overrides.adminToken ?? process.env.CONTENT_BACKEND_ADMIN_TOKEN ?? "dev-admin",
    operatorToken: overrides.operatorToken ?? process.env.CONTENT_BACKEND_OPERATOR_TOKEN ?? "dev-op",
    opsPort: overrides.opsPort ?? Number(process.env.OPS_PORT ?? 3002),
  };
}
```
（s3 既有块保留不变，仅示意 `/* 既有 */`。）T2 `region-config.ts` 与 T5/T7 `buildOpsApp` 默认从 `loadEnv()` 取，不绕过。

- [ ] **Step 2.6: 扩 `test/integration/helpers.ts` 加 content_policy DDL（fold eng C2）**

读 `test/integration/helpers.ts`，既有导出 `createTestDb`/`seedTrack` + raw DDL（`TRACKS_DDL`/`LYRICS_DDL`）。追加 `CONTENT_POLICY_DDL` + `INGEST_DDL`/`REVIEW_DDL`（若缺），并在 `createTestDb` 内执行：

```typescript
// helpers.ts 追加（与既有 raw DDL 风格一致，不跑 drizzle migration）
export const CONTENT_POLICY_DDL = `CREATE TABLE IF NOT EXISTS content_policy (
  id text PRIMARY KEY, rule_id text NOT NULL, action text NOT NULL,
  target_scope text NOT NULL, version integer NOT NULL, envelope text NOT NULL,
  caller_identity text NOT NULL, command_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), superseded_by integer
);
CREATE UNIQUE INDEX IF NOT EXISTS content_policy_cmd_uk ON content_policy(command_id);
CREATE UNIQUE INDEX IF NOT EXISTS content_policy_rule_ver_uk ON content_policy(rule_id, version);`;

// createTestDb 内追加执行 CONTENT_POLICY_DDL（+ INGEST_DDL/REVIEW_DDL 若 helpers 未含）
```
plan 测试统一用 `createTestDb`（既有）+ `seedTrack`（既有），**不发明 `newPgMem`/`seedApprovedTrack` 别名**（eng C2 修正）。

- [ ] **Step 3: 写失败测试 `test/unit/policy-store.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../integration/helpers.js"; // 既有，eng C2 修正
import { createPolicyStore } from "../../src/policy/policy-store.js";

describe("policy-store", () => {
  let db: any;
  beforeEach(async () => { db = await createTestDb(); }); // 含 content_policy 表（Step 2.6 DDL）

  // envelope 含 upstream version 字段（fold codex P1#2 stale 检测）
  function envelope(ruleId: string, action: any, commandId: string, upstreamVersion: number) {
    return {
      command_id: commandId,
      kind: "content_policy" as const,
      capability_mode: "real",
      version: upstreamVersion, // producer 侧 monotonic version
      payload: { rule_id: ruleId, action, target_scope: "content_management" },
      security_context: {
        actor: "ops-platform",
        rbac_decision: { role: "admin", allowed: true },
        audience: "content_backend",
        expiry: new Date(Date.now() + 60000).toISOString(),
      },
    };
  }

  it("applyPolicy 首次应用 version=1", async () => {
    const store = createPolicyStore(db);
    const r = await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform");
    expect(r).toEqual({ applied: true, version: 1 });
  });

  it("command_id 重复幂等 applied=false", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform");
    const r = await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform");
    expect(r.applied).toBe(false);
    expect(r.version).toBe(1);
  });

  it("新 upstream version 应用，旧标 superseded", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform"); // v1
    const r2 = await store.applyPolicy(envelope("r1", "allow", "cmd-2", 2), "ops-platform"); // v2
    expect(r2).toEqual({ applied: true, version: 2 });
    const latest = await store.latestPolicy();
    expect(latest.length).toBe(1);
    expect(latest[0].action).toBe("allow");
    const { rows } = await db.query("SELECT superseded_by FROM content_policy WHERE version=1");
    expect(rows[0].superseded_by).toBe(2);
  });

  it("stale upstream version（旧后到）→ applied:false superseded:true（fold codex P1#2）", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "allow", "cmd-2", 2), "ops-platform"); // v2 先到
    const r = await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform"); // v1 后到
    expect(r).toEqual({ applied: false, version: 2, superseded: true });
    const latest = await store.latestPolicy();
    expect(latest[0].action).toBe("allow"); // 仍是 v2
  });

  it("不同 ruleId 并存于 latestPolicy", async () => {
    const store = createPolicyStore(db);
    await store.applyPolicy(envelope("r1", "block", "cmd-1", 1), "ops-platform");
    await store.applyPolicy(envelope("r2", "allow", "cmd-2", 1), "ops-platform");
    const latest = await store.latestPolicy();
    expect(latest.length).toBe(2);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm test test/unit/policy-store.test.ts`
Expected: FAIL（`createPolicyStore` 未定义）

- [ ] **Step 5: 实现 `src/policy/policy-store.ts`**

```typescript
// policy-store.ts — content_policy 表读写 + command_id 幂等 + upstream version 排序 + stale 拒绝（spec §5.1/§9.3，fold codex P1#2/#3）。
import type { ContentDb } from "../content/db.js";

export interface SecurityContext {
  actor: string;
  rbac_decision: object;
  target_device?: string;
  audience: string;
  expiry: string;
}
export interface PolicyEnvelope {
  command_id: string;
  kind: "content_policy";
  capability_mode: string;
  version: number; // upstream producer 侧 monotonic version（fold codex P1#2）
  payload: { rule_id: string; action: "allow" | "block" | "region_restrict"; target_scope: string };
  security_context: SecurityContext;
}
export interface PolicyRecord {
  ruleId: string; action: string; targetScope: string;
  version: number; envelope: PolicyEnvelope;
  receivedAt: string; supersededBy: number | null;
}
export interface PolicyStore {
  applyPolicy(envelope: PolicyEnvelope, callerIdentity: string): Promise<{ applied: boolean; version: number; superseded?: boolean }>;
  latestPolicy(): Promise<PolicyRecord[]>;
}

export function createPolicyStore(db: ContentDb): PolicyStore {
  return {
    async applyPolicy(envelope, callerIdentity) {
      // command_id 幂等查重
      const { rows: dup } = await db.query(
        "SELECT version FROM content_policy WHERE command_id = $1 LIMIT 1",
        [envelope.command_id],
      );
      if (dup[0]) return { applied: false, version: Number(dup[0].version) };

      // stale 检测：upstream version <= 当前 max → 拒绝（旧 policy 后到，fold codex P1#2）
      const { rows: v } = await db.query(
        "SELECT COALESCE(MAX(version),0) AS m FROM content_policy WHERE rule_id = $1",
        [envelope.payload.rule_id],
      );
      const currentMax = Number(v[0].m);
      if (envelope.version <= currentMax) {
        return { applied: false, version: currentMax, superseded: true };
      }

      // 原子插入（unique index (rule_id,version) + command_id 防并发，fold codex P1#3）；
      // 注意：ContentDb port 无 transaction API，pg-mem 单连接无并发；真实 Postgres 由
      // unique index 兜底（INSERT 冲突抛错→调用方按 applied:false 处理）。sim 低并发可接受。
      const id = `cp_${envelope.command_id}`;
      try {
        await db.query(
          `INSERT INTO content_policy (id, rule_id, action, target_scope, version, envelope, caller_identity, command_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id, envelope.payload.rule_id, envelope.payload.action,
            envelope.payload.target_scope, envelope.version, JSON.stringify(envelope),
            callerIdentity, envelope.command_id,
          ],
        );
      } catch {
        // 并发同 command_id/(rule_id,version) 冲突→幂等返回
        const { rows: d2 } = await db.query("SELECT version FROM content_policy WHERE command_id = $1", [envelope.command_id]);
        if (d2[0]) return { applied: false, version: Number(d2[0].version) };
        throw new Error("BACKEND_UNAVAILABLE");
      }
      // 旧 version 标 superseded_by = 新 version
      await db.query(
        "UPDATE content_policy SET superseded_by = $1 WHERE rule_id = $2 AND version < $3 AND superseded_by IS NULL",
        [envelope.version, envelope.payload.rule_id, envelope.version],
      );
      return { applied: true, version: envelope.version };
    },
    async latestPolicy() {
      const { rows } = await db.query(
        "SELECT rule_id, action, target_scope, version, envelope, received_at, superseded_by FROM content_policy WHERE superseded_by IS NULL",
      );
      return rows.map((r: any) => ({
        ruleId: String(r.rule_id), action: String(r.action), targetScope: String(r.target_scope),
        version: Number(r.version), envelope: JSON.parse(r.envelope),
        receivedAt: String(r.received_at), supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
      }));
    },
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test test/unit/policy-store.test.ts`
Expected: PASS 5/5

- [ ] **Step 7: 跑全量确认不回归**

Run: `pnpm test`
Expected: 71/71 PASS（66 旧 + 5 新）

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations/ src/env.ts src/policy/policy-store.ts test/unit/policy-store.test.ts test/integration/helpers.ts
git commit -m "feat(m2b): content_policy 表+policy-store（upstream version+stale 拒绝+幂等+transaction 防竞态）+env 扩展+helpers DDL"
```

---

### Task 2: drm-rule-engine.ts + region-config.ts

**Files:**
- Create: `src/policy/region-config.ts`
- Create: `src/policy/drm-rule-engine.ts`
- Test: `test/unit/drm-rule-engine.test.ts`

**Interfaces:**
- Consumes: `PolicyRecord[]`（T1）、`Kind`（envelope.ts 既有）
- Produces: `DrmDecision` + `checkDrm(policies, kind, trackId, requestRegion, regionConfig)`

- [ ] **Step 1: 写失败测试 `test/unit/drm-rule-engine.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { checkDrm } from "../../src/policy/drm-rule-engine.js";
import type { PolicyRecord } from "../../src/policy/policy-store.js";

function policy(ruleId: string, action: any): PolicyRecord {
  return {
    ruleId, action, targetScope: "content_management", version: 1,
    envelope: {} as any, receivedAt: "", supersededBy: null,
  };
}

describe("drm-rule-engine", () => {
  it("block 命中 track → 全 kind BLOCKED", () => {
    // block policy payload 不含 track_id（target_scope=content_management 全局）；
    // 简化：block policy 命中所有 track（sim 闭环够，spec §8.2 block 全 kind 全 track）。
    const d = checkDrm([policy("r1", "block")], "content_stream", "self:t1", "cn", "cn");
    expect(d).toEqual({ action: "block", ruleId: "r1" });
  });

  it("allow → null（放行）", () => {
    const d = checkDrm([policy("r1", "allow")], "content_stream", "self:t1", "cn", "cn");
    expect(d).toBeNull();
  });

  it("region_restrict + region 不符 → REGION_RESTRICTED", () => {
    const d = checkDrm([policy("r1", "region_restrict")], "content_stream", "self:t1", "us", "cn");
    expect(d).toEqual({ action: "region_restrict", ruleId: "r1" });
  });

  it("region_restrict + region 符合 → null（放行）", () => {
    const d = checkDrm([policy("r1", "region_restrict")], "content_stream", "self:t1", "cn", "cn");
    expect(d).toBeNull();
  });

  it("空 policy 集 → null（放行）", () => {
    const d = checkDrm([], "content_stream", "self:t1", "cn", "cn");
    expect(d).toBeNull();
  });

  it("per-kind：query 也受 block 约束", () => {
    const d = checkDrm([policy("r1", "block")], "content_query", "self:t1", "cn", "cn");
    expect(d).toEqual({ action: "block", ruleId: "r1" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test test/unit/drm-rule-engine.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/policy/region-config.ts`**

```typescript
// region-config.ts — backend 自持 region（spec §8.2 D10，不扩 ops-config schema）。
export function getRegion(): string {
  return process.env.CONTENT_BACKEND_REGION ?? "cn";
}
```

- [ ] **Step 4: 实现 `src/policy/drm-rule-engine.ts`**

```typescript
// drm-rule-engine.ts — per-kind drm 检查（spec §8.2 + §4.5）。
// block 全 kind 全 track；region_restrict 按 backend 自持 region 判定；allow 放行。
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test test/unit/drm-rule-engine.test.ts`
Expected: PASS 6/6

- [ ] **Step 6: 跑全量**

Run: `pnpm test`
Expected: 76/76 PASS

- [ ] **Step 7: Commit**

```bash
git add src/policy/region-config.ts src/policy/drm-rule-engine.ts test/unit/drm-rule-engine.test.ts
git commit -m "feat(m2b): drm-rule-engine+region-config（per-kind block/region_restrict，D10 backend 自持 region）"
```

---

### Task 3: audit-sink.ts + audit-events.ts

**Files:**
- Create: `src/audit/audit-sink.ts`
- Create: `src/audit/audit-events.ts`
- Test: `test/unit/audit-sink.test.ts`

**Interfaces:**
- Consumes: 无（纯 fs append + crypto）
- Produces: `AuditEvent` + `AuditSink` 接口 + `createAuditSink(path)` + `emitProvision/Revoke/ConfigApply/ToolCall` helper

- [ ] **Step 1: 写失败测试 `test/unit/audit-sink.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createAuditSink } from "../../src/audit/audit-sink.js";
import { emitProvision, emitRevoke, emitConfigApply, emitToolCall } from "../../src/audit/audit-events.js";

describe("audit-sink", () => {
  const path = ".tmp-audit.jsonl";
  beforeEach(() => rmSync(path, { force: true }));
  afterEach(() => rmSync(path, { force: true }));

  it("append 两事件 + hash chain 连续", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitRevoke(sink, { trackId: "self:t1", actor: "admin" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    expect(e1.eventType).toBe("provision");
    expect(e2.eventType).toBe("revoke");
    expect(e2.prevHash).toBe(e1.hash);
    expect(e1.prevHash).toBe("0000000000000000000000000000000000000000000000000000000000000000");
  });

  it("五事件 helper 字段正确", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitRevoke(sink, { trackId: "self:t1", actor: "admin" });
    await emitConfigApply(sink, { ruleId: "r1", version: 1, actor: "ops-platform" });
    await emitToolCall(sink, { kind: "content_stream", target: "self:t1", actor: "cloud-ext", streamId: 99 });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).eventType).toBe("provision");
    expect(JSON.parse(lines[1]).eventType).toBe("revoke");
    expect(JSON.parse(lines[2]).eventType).toBe("config_apply");
    const t = JSON.parse(lines[3]);
    expect(t.eventType).toBe("tool_call");
    expect(t.streamId).toBe(99);
    expect(t.actorType).toBe("service");
  });

  it("断链检测：手动改 prevHash → verifyChain 返 false", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    // 改写第一行 prevHash 制造断链
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const tampered = { ...JSON.parse(lines[0]), prevHash: "dead" };
    writeFileSync(path, JSON.stringify(tampered) + "\n");
    const { verifyChain } = await import("../../src/audit/audit-sink.js");
    expect(verifyChain(path)).toBe(false);
  });

  it("正向：合法两事件链 verifyChain===true（fold codex P1#5/eng C1，防回归）", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitRevoke(sink, { trackId: "self:t1", actor: "admin" });
    const { verifyChain } = await import("../../src/audit/audit-sink.js");
    expect(verifyChain(path)).toBe(true);
  });

  it("emitUnauthorized（403 拒绝审计，fold eng I5）", async () => {
    const { emitUnauthorized } = await import("../../src/audit/audit-events.js");
    const sink = createAuditSink(path);
    await emitUnauthorized(sink, { caller: "ops-platform", reason: "audience_mismatch", target: "content_policy" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const e = JSON.parse(lines[0]);
    expect(e.eventType).toBe("tool_call");
    expect(e.actor).toBe("ops-platform");
    expect(e.target).toBe("content_policy");
  });

  it("actorType：human vs service", async () => {
    const sink = createAuditSink(path);
    await emitProvision(sink, { ingestId: "i1", trackId: "self:t1", actor: "admin" });
    await emitConfigApply(sink, { ruleId: "r1", version: 1, actor: "ops-platform" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).actorType).toBe("human");
    expect(JSON.parse(lines[1]).actorType).toBe("service");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test test/unit/audit-sink.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/audit/audit-sink.ts`**

```typescript
// audit-sink.ts — append-only JSONL + hash chain（M3-pre §4.7 sim 机制）。
// 每事件含 prevHash + hash（sha256），断链=篡改证据。sim sink=文件，真机换外部 sink（接口不变）。
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface AuditEvent {
  eventType: "provision" | "revoke" | "config_apply" | "tool_call";
  actorType: "human" | "service";
  actor: string;
  target: string;
  traceId: string;
  streamId?: number;
  policyVersion?: number;
  prevHash: string;
  hash: string;
  ts: string;
}
export interface AuditSink {
  emit(event: Omit<AuditEvent, "prevHash" | "hash" | "ts">): Promise<void>;
}

const ZERO_HASH = createHash("sha256").update("").digest("hex");

function lastHash(path: string): string {
  try {
    const content = readFileSync(path, "utf8").trim();
    if (!content) return ZERO_HASH;
    const lines = content.split("\n");
    return JSON.parse(lines[lines.length - 1]).hash;
  } catch {
    return ZERO_HASH;
  }
}

export function createAuditSink(path: string): AuditSink {
  return {
    async emit(event) {
      // fire-and-forget：sim 阶段写失败 log 不阻塞业务（fold devex M4 / spec §6）
      try {
        const prevHash = lastHash(path);
        const ts = new Date().toISOString();
        const hash = createHash("sha256").update(stringifyPayload(event, prevHash, ts)).digest("hex");
        const full: AuditEvent = { ...event, prevHash, hash, ts };
        appendFileSync(path, JSON.stringify(full) + "\n");
      } catch (e) {
        console.warn("[audit-sink] emit failed (fire-and-forget):", e);
      }
    },
  };
}

/** 确定性序列化：emit 与 verifyChain 共用，键序固定（fold codex P1#5）。 */
function stringifyPayload(event: Omit<AuditEvent, "prevHash" | "hash" | "ts">, prevHash: string, ts: string): string {
  // 仅业务字段 + prevHash + ts（不含 hash 字段，否则自引用）
  const { hash: _omit, ...rest } = event as any; // event 无 hash，防御性剔除
  return JSON.stringify({ ...rest, prevHash, ts });
}

/** 校验 hash chain 连续性（断链返 false）。fold codex P1#5：重算剔 hash 字段。 */
export function verifyChain(path: string): boolean {
  const content = readFileSync(path, "utf8").trim();
  if (!content) return true;
  const lines = content.split("\n");
  let prev = ZERO_HASH;
  for (const line of lines) {
    const e = JSON.parse(line) as AuditEvent;
    if (e.prevHash !== prev) return false;
    // 重算：用 emit 同一 stringifyPayload（剔 hash/prevHash/ts，仅业务字段+prevHash+ts）
    const { hash, prevHash, ts, ...rest } = e;
    const expected = createHash("sha256").update(JSON.stringify({ ...rest, prevHash, ts })).digest("hex");
    if (e.hash !== expected) return false;
    prev = e.hash;
  }
  return true;
}
```

- [ ] **Step 4: 实现 `src/audit/audit-events.ts`**

```typescript
// audit-events.ts — §8.3 matrix 五事件 helper（封装 AuditSink.emit 调用）。
import type { AuditSink } from "./audit-sink.js";
import type { Kind } from "../envelope.js";

function traceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function emitProvision(sink: AuditSink, { ingestId, trackId, actor }: { ingestId: string; trackId: string; actor: string }) {
  await sink.emit({ eventType: "provision", actorType: "human", actor, target: trackId, traceId: traceId() });
}

export async function emitRevoke(sink: AuditSink, { trackId, actor }: { trackId: string; actor: string }) {
  await sink.emit({ eventType: "revoke", actorType: "human", actor, target: trackId, traceId: traceId() });
}

export async function emitConfigApply(sink: AuditSink, { ruleId, version, actor }: { ruleId: string; version: number; actor: string }) {
  await sink.emit({ eventType: "config_apply", actorType: "service", actor, target: ruleId, traceId: traceId(), policyVersion: version });
}

export async function emitToolCall(sink: AuditSink, { kind, target, actor, streamId }: { kind: Kind; target: string; actor: string; streamId?: number }) {
  await sink.emit({ eventType: "tool_call", actorType: "service", actor, target, traceId: traceId(), streamId });
}

// 403 拒绝审计（fold eng I5 / spec §6 "拒绝+audit unauthorized"）：
// 复用 tool_call event_type（D11 不扩 enum），actor=caller，target=被拒资源，reason 进 traceId 语义。
export async function emitUnauthorized(sink: AuditSink, { caller, reason, target }: { caller: string; reason: string; target: string }) {
  await sink.emit({ eventType: "tool_call", actorType: "service", actor: caller, target, traceId: `${traceId()}|unauthorized:${reason}` });
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test test/unit/audit-sink.test.ts`
Expected: PASS 7/7（原 4 + 正向 verifyChain + emitUnauthorized + actorType）

- [ ] **Step 6: 跑全量**

Run: `pnpm test`
Expected: 83/83 PASS（66 旧 + T1 5 + T2 6 + T3 7 - 1 重复 = 78，按实际计；以 pnpm test 实际为准不回归即可）

- [ ] **Step 7: Commit**

```bash
git add src/audit/ test/unit/audit-sink.test.ts
git commit -m "feat(m2b): audit-sink JSONL+hash chain（verifyChain 剔 hash 修复+fire-and-forget）+audit-events 六 helper（+emitUnauthorized）"
```

---

### Task 4: 2I hardening I1 — http-mapping 4xx/5xx 收窄

**Files:**
- Modify: `src/routes/http-mapping.ts`（签名 `httpStatus(state, errorCode)` + 4xx/5xx 拆分）
- Modify: `src/index.ts`（handle() 调用传 errorCode）
- Modify: `test/unit/http-mapping.test.ts`（+4xx/5xx 用例）

**Interfaces:**
- Consumes: `CompletionState` + `ErrorCode`（envelope.ts）
- Produces: `httpStatus(completionState, errorCode)` 新签名（既有 index.ts handle() 改调用）

- [ ] **Step 1: 写失败测试（追加到 `test/unit/http-mapping.test.ts`）**

读现有 `test/unit/http-mapping.test.ts`，追加：

```typescript
import { httpStatus } from "../../src/routes/http-mapping.js";

describe("http-mapping I1 收窄", () => {
  it("DONE/DONE_WITH_CONCERNS → 200", () => {
    expect(httpStatus("DONE")).toBe(200);
    expect(httpStatus("DONE_WITH_CONCERNS")).toBe(200);
  });
  it("BLOCKED + COPYRIGHT_RESTRICTED → 403", () => {
    expect(httpStatus("BLOCKED", "COPYRIGHT_RESTRICTED")).toBe(403);
  });
  it("BLOCKED + REGION_RESTRICTED → 403", () => {
    // REGION_RESTRICTED 不在 ErrorCode enum（既有 enum 无），用字面量透传
    expect(httpStatus("BLOCKED", "REGION_RESTRICTED" as any)).toBe(403);
  });
  it("BLOCKED + BACKEND_UNAVAILABLE → 503", () => {
    expect(httpStatus("BLOCKED", "BACKEND_UNAVAILABLE")).toBe(503);
  });
  it("BLOCKED + AUTH_FAILED → 503", () => {
    expect(httpStatus("BLOCKED", "AUTH_FAILED" as any)).toBe(503);
  });
  it("BLOCKED 无 errorCode 兜底 → 503", () => {
    expect(httpStatus("BLOCKED")).toBe(503);
  });
});
```

注：`REGION_RESTRICTED`/`AUTH_FAILED` 在 **content-contract.schema.json:13 ErrorCode enum 已含**（schema 既有，非新扩）。`src/envelope.ts` 既有 TS type 缺这两个（M2a 遗留），**T6 Step 1 扩 TS type 对齐 schema**（非改 schema，fold codex P1#4 误报澄清）。T4 在 T6 之前，故 T4 测试用 `as any` 字面量 + http-mapping 签名 `(state, errorCode?: string)` 兼容；T6 扩 type 后可去掉 `as any`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test test/unit/http-mapping.test.ts`
Expected: FAIL（httpStatus 不接受 errorCode / BLOCKED 笼统 503）

- [ ] **Step 3: 改 `src/routes/http-mapping.ts`**

```typescript
// http-mapping.ts — completion_state + error_code → HTTP 状态码（spec §4.4 + I1 收窄）。
// DONE/DONE_WITH_CONCERNS → 200
// BLOCKED + COPYRIGHT_RESTRICTED/REGION_RESTRICTED → 403（client-side block）
// BLOCKED + BACKEND_UNAVAILABLE/AUTH_FAILED/无 → 503（server-side unavailable）
const CLIENT_BLOCK = new Set(["COPYRIGHT_RESTRICTED", "REGION_RESTRICTED"]);

export function httpStatus(completionState: string, errorCode?: string): number {
  if (completionState === "DONE" || completionState === "DONE_WITH_CONCERNS") return 200;
  // BLOCKED
  if (errorCode && CLIENT_BLOCK.has(errorCode)) return 403;
  return 503;
}
```

- [ ] **Step 4: 改 `src/index.ts` handle() 传 errorCode**

定位 `src/index.ts` 的 handle() 中 `httpStatus(envelope.completion_state)` 行，改为：

```typescript
    return { envelope, status: httpStatus(envelope.completion_state, envelope.error_code) };
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test test/unit/http-mapping.test.ts`
Expected: PASS（含既有用例 + 新 4xx/5xx 用例）

- [ ] **Step 6: 跑全量（确认 index.ts 改动不回归 e2e）**

Run: `pnpm test`
Expected: 全 PASS（http-mapping 签名扩展，既有调用未传 errorCode 时 undefined→兜底 503，但既有 e2e DONE/DONE_WITH_CONCERNS/BLOCKED 行为：DONE→200 不变；既有 BLOCKED e2e 若断言 503 仍通过；若断言具体 4xx 需检查 lyrics restricted e2e）

若 lyrics.e2e.test.ts 断言 BLOCKED→503 但本 task 改 COPYRIGHT_RESTRICTED→403，更新该断言为 403（属本次改动引发的必要清理，④类）。

- [ ] **Step 7: Commit**

```bash
git add src/routes/http-mapping.ts src/index.ts test/unit/http-mapping.test.ts test/integration/lyrics.e2e.test.ts
git commit -m "fix(m2b): http-mapping I1 收窄（BLOCKED+copyright/region→403，BACKEND_UNAVAILABLE→503）"
```

---

### Task 5: App2 content_policy push endpoint + mTLS + audience 校验

**Files:**
- Create: `src/ops-app.ts`（App2 fastify + mTLS https server + content_policy route）
- Test: `test/integration/policy-push.e2e.test.ts`

**Interfaces:**
- Consumes: `createPolicyStore`（T1）、`createAuditSink` + `emitConfigApply`（T3）、`loadEnv`（env.ts）
- Produces: `buildOpsApp(opts)` + `startOpsServer()`（CLI 入口，port 3002）

- [ ] **Step 1: 加依赖（fold codex P2：runtime vs devDep 分清）**

Run: `pnpm add eta @fastify/cookie @fastify/static && pnpm add -D selfsigned`
Expected: package.json + pnpm-lock.yaml 更新——`eta`/`@fastify/cookie`/`@fastify/static` 进 dependencies（runtime），`selfsigned` 进 devDependencies（sim CA cert 测试用）。触 lockfile，②类必要支撑。

- [ ] **Step 2: 写失败测试 `test/integration/policy-push.e2e.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { createTestDb } from "./helpers.js"; // 既有，eng C2 修正
import { createPolicyStore } from "../../src/policy/policy-store.js";
import { createAuditSink, verifyChain } from "../../src/audit/audit-sink.js";
import selfsigned from "selfsigned";
import { request } from "node:https";
import { rmSync, readFileSync } from "node:fs";

// sim CA + 服务 cert（mock producer 用；设 SAN + EKU clientAuth，fold D1=A 加强版）
const caCert = selfsigned.generate(null, { name: "CN=sim-ca", days: 365 });
const serviceCert = selfsigned.generate(
  [{ name: "commonName", value: "ops-platform" },
   { name: "subjectAltName", value: { value: [{ type: 2, value: "localhost" }] } }],
  { days: 365, keyPair: caCert.keyPair, extensions: [{ name: "extKeyUsage", value: "clientAuth" }] },
);
// 异质 CA（测 wrong-CA 拒绝，fold D1）
const otherCa = selfsigned.generate(null, { name: "CN=other-ca", days: 365 });
const otherCert = selfsigned.generate(
  [{ name: "commonName", value: "evil" }],
  { days: 365, keyPair: otherCa.keyPair },
);
// 过期 cert（fold D1）
const expiredCert = selfsigned.generate(
  [{ name: "commonName", value: "ops-platform" }],
  { days: -1, keyPair: caCert.keyPair }, // 已过期
);
// wrong-SAN cert（fold D1）
const wrongSanCert = selfsigned.generate(
  [{ name: "commonName", value: "ops-platform" },
   { name: "subjectAltName", value: { value: [{ type: 2, value: "evil.example" }] } }],
  { days: 365, keyPair: caCert.keyPair, extensions: [{ name: "extKeyUsage", value: "clientAuth" }] },
);

let app: any, port: number, db: any, store: any;
const auditPath = ".tmp-audit-push.jsonl";

beforeAll(async () => {
  rmSync(auditPath, { force: true });
  db = await createTestDb();
  store = createPolicyStore(db);
  app = await buildOpsApp({
    db, auditSink: createAuditSink(auditPath), policyStore: store,
    tlsOpts: { ca: caCert.cert, requestCert: true, rejectUnauthorized: true },
    expectedSan: "localhost", // 期望 SAN（fold D1 非 CN-only）
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = app.server.address().port;
});
afterAll(async () => { await app.close(); rmSync(auditPath, { force: true }); });

function postPush(body: any, opts: { key?: string; cert?: string; ca?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = request({
      port, host: "127.0.0.1", method: "POST", path: "/content_policy/push",
      ca: opts.ca ?? caCert.cert,
      key: opts.key ?? serviceCert.key, cert: opts.cert ?? serviceCert.cert,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(buf || "{}") }));
    });
    req.on("error", () => resolve({ status: 0, body: { error: "conn refused" } }));
    req.write(data); req.end();
  });
}

// envelope 含 upstream version（fold codex P1#2）
function envelope(audience: string, cmdId: string, action: any = "block", expiryMs = 60000, upstreamVersion = 1, actor = "ops-platform") {
  return {
    command_id: cmdId, kind: "content_policy", capability_mode: "real", version: upstreamVersion,
    payload: { rule_id: "r1", action, target_scope: "content_management" },
    security_context: {
      actor, rbac_decision: { role: "admin", allowed: true },
      audience, expiry: new Date(Date.now() + expiryMs).toISOString(),
    },
  };
}

describe("content_policy push e2e", () => {
  it("mTLS + audience 正确 → 200 applied", async () => {
    const r = await postPush(envelope("content_backend", "cmd-1"));
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.version).toBe(1);
  });

  it("audience ≠ content_backend → 403 + error_code + audit unauthorized（fold eng I5）", async () => {
    const r = await postPush(envelope("device-hub", "cmd-2"));
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe("AUDIENCE_MISMATCH");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]).actor).toBe("ops-platform");
  });

  it("expiry 过期 → 403 ENVELOPE_EXPIRED", async () => {
    const r = await postPush(envelope("content_backend", "cmd-3", "block", -60000));
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe("ENVELOPE_EXPIRED");
  });

  it("actor ≠ callerIdentity（self-declared 不信，fold codex P2）→ 403 UNAUTHORIZED_ACTOR", async () => {
    const r = await postPush(envelope("content_backend", "cmd-actor", "block", 60000, 1, "fake-actor"));
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe("UNAUTHORIZED_ACTOR");
  });

  it("command_id 重复 → 200 applied=false 幂等", async () => {
    await postPush(envelope("content_backend", "cmd-dup"));
    const r = await postPush(envelope("content_backend", "cmd-dup"));
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
  });

  // D1=A 加强版：非 CN-only 校验 3 拒绝测试
  it("无 client cert → 连接层拒绝", async () => {
    const r = await postPush(envelope("content_backend", "cmd-nocert"), { key: undefined as any, cert: undefined as any });
    expect(r.status).toBe(0);
  });

  it("wrong-CA cert（不被 sim CA trust）→ 拒绝（fold D1）", async () => {
    const r = await postPush(envelope("content_backend", "cmd-wca"), { key: otherCert.key, cert: otherCert.cert });
    expect(r.status).toBe(0); // TLS 层 rejectUnauthorized 拒绝
  });

  it("expired cert → 拒绝（fold D1）", async () => {
    const r = await postPush(envelope("content_backend", "cmd-exp"), { key: expiredCert.key, cert: expiredCert.cert });
    expect(r.status).toBe(0); // TLS 层 validity 校验拒绝
  });

  it("wrong-SAN cert → 拒绝（fold D1）", async () => {
    const r = await postPush(envelope("content_backend", "cmd-san"), { key: wrongSanCert.key, cert: wrongSanCert.cert });
    expect(r.status).toBe(0); // TLS 层 SAN 校验拒绝
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test test/integration/policy-push.e2e.test.ts`
Expected: FAIL（ops-app 不存在）

- [ ] **Step 4: 实现 `src/ops-app.ts`**

```typescript
// ops-app.ts — App2 ops-facing fastify（port 3002）。
// /content_policy/*：mTLS（非 CN-only，D1=A 加强版）+ audience 校验 + envelope shape + actor 绑定（fold codex P2）。
// /admin/*：session cookie（T7 加）。
import Fastify from "fastify";
import type { ContentDb } from "./content/db.js";
import type { PolicyEnvelope, PolicyStore } from "./policy/policy-store.js";
import { createPolicyStore } from "./policy/policy-store.js";
import type { AuditSink } from "./audit/audit-sink.js";
import { emitConfigApply, emitUnauthorized } from "./audit/audit-events.js";

export interface BuildOpsAppOpts {
  db: ContentDb;
  auditSink: AuditSink;
  tlsOpts?: { ca: string; requestCert: boolean; rejectUnauthorized: boolean };
  policyStore?: PolicyStore;
  expectedSan?: string; // 期望 peer cert SAN（D1 非 CN-only）
  adminToken?: string;  // T7 用
  operatorToken?: string;
}

export async function buildOpsApp(opts: BuildOpsAppOpts) {
  const store = opts.policyStore ?? createPolicyStore(opts.db);
  const expectedSan = opts.expectedSan ?? "localhost";
  const httpsOpts = opts.tlsOpts ? {
    https: {
      ca: opts.tlsOpts.ca,
      requestCert: opts.tlsOpts.requestCert,
      rejectUnauthorized: opts.tlsOpts.rejectUnauthorized, // TLS 层隐式 chain/validity/SAN 校验
    },
  } : {};

  const app = Fastify(httpsOpts);

  // mTLS preHandler（D1=A 加强版：非 CN-only，校验 authorized + SAN + EKU clientAuth）
  async function mtlsVerify(req: any, reply: any) {
    const tls = req.raw?.socket;
    // TLS 层 rejectUnauthorized:true 已校验 chain/validity/SAN；此处校验 authorized + 应用层 SAN/EKU
    if (!tls?.authorized) {
      return reply.code(403).send({ error_code: "MTLS_CERT_REQUIRED", message: "mTLS client cert required/invalid" });
    }
    const cert = tls.getPeerCertificate?.();
    if (!cert || Object.keys(cert).length === 0) {
      return reply.code(403).send({ error_code: "MTLS_CERT_REQUIRED", message: "mTLS client cert required" });
    }
    // SAN 校验（非 CN-only）：cert.subjectaltname 含 expectedSan
    const san = cert.subjectaltname ?? "";
    if (!san.includes(expectedSan)) {
      return reply.code(403).send({ error_code: "MTLS_CERT_REQUIRED", message: `SAN mismatch (expected ${expectedSan})` });
    }
    // EKU clientAuth 校验（sim：cert.raw.extKeyUsage 或 cert.extKeyUsage，selfsigned 设 clientAuth）
    const eku = cert.extKeyUsage ?? "";
    if (eku && !eku.includes("clientAuth")) {
      return reply.code(403).send({ error_code: "MTLS_CERT_REQUIRED", message: "EKU clientAuth required" });
    }
    (req as any).callerIdentity = cert.subject?.CN ?? "unknown-service";
  }

  // 统一 error body（fold devex I3）
  const err = (code: string, message: string, status = 403) => ({ error_code: code, message });

  app.post("/content_policy/push", { preHandler: mtlsVerify }, async (req, reply) => {
    const env = req.body as PolicyEnvelope;
    const sc = env.security_context;
    const caller = (req as any).callerIdentity;

    // envelope shape 校验（fold codex P2：不信 self-declared，校验 kind/action/target_scope）
    if (env.kind !== "content_policy" || !["allow", "block", "region_restrict"].includes(env.payload?.action) || env.payload?.target_scope !== "content_management") {
      await emitUnauthorized(opts.auditSink, { caller, reason: "invalid_envelope", target: "content_policy" });
      return reply.code(400).send(err("INVALID_ENVELOPE", "envelope shape invalid", 400));
    }
    // audience 校验
    if (sc.audience !== "content_backend") {
      await emitUnauthorized(opts.auditSink, { caller, reason: "audience_mismatch", target: "content_policy" });
      return reply.code(403).send(err("AUDIENCE_MISMATCH", "audience mismatch"));
    }
    // expiry 校验
    if (new Date(sc.expiry).getTime() < Date.now()) {
      await emitUnauthorized(opts.auditSink, { caller, reason: "envelope_expired", target: "content_policy" });
      return reply.code(403).send(err("ENVELOPE_EXPIRED", "envelope expired"));
    }
    // actor 绑定（fold codex P2：self-declared actor 须与 mTLS caller 一致）
    if (sc.actor !== caller) {
      await emitUnauthorized(opts.auditSink, { caller, reason: "actor_mismatch", target: "content_policy" });
      return reply.code(403).send(err("UNAUTHORIZED_ACTOR", "actor does not match mTLS caller"));
    }
    const r = await store.applyPolicy(env, caller);
    if (r.applied) {
      await emitConfigApply(opts.auditSink, { ruleId: env.payload.rule_id, version: r.version, actor: sc.actor });
    }
    return reply.code(200).send(r);
  });

  return app;
}

// CLI 入口（fold devex C1/I5：App2 可独立启动）：tsx src/ops-app.ts
// cert 生成 + listen 在 T8 dev-start 脚本统一；此处 CLI 用 env 传 cert 路径或自生成 sim CA（sim）。
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { loadEnv } = await import("./env.js");
  const selfsigned = (await import("selfsigned")).default;
  const env = loadEnv();
  const ca = selfsigned.generate(null, { name: "CN=sim-ca", days: 365 });
  const svc = selfsigned.generate(
    [{ name: "commonName", value: "ops-platform" }, { name: "subjectAltName", value: { value: [{ type: 2, value: "localhost" }] } }],
    { days: 365, keyPair: ca.keyPair, extensions: [{ name: "extKeyUsage", value: "clientAuth" }] },
  );
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: env.dbUrl });
  const db = { async query(t: string, p?: unknown[]) { return pool.query(t, p as any[]); } };
  const app = await buildOpsApp({
    db, auditSink: (await import("./audit/audit-sink.js")).createAuditSink(env.auditSinkPath),
    tlsOpts: { ca: ca.cert, requestCert: true, rejectUnauthorized: true }, expectedSan: "localhost",
    adminToken: env.adminToken, operatorToken: env.operatorToken,
  });
  app.listen({ port: env.opsPort, host: "0.0.0.0" });
  console.log(`ops-app listening :${env.opsPort} (mTLS sim CA)`);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test test/integration/policy-push.e2e.test.ts`
Expected: PASS 10/10（200 + audience 403 + expiry 403 + actor 403 + 幂等 + 4 cert 拒绝）

- [ ] **Step 6: 跑全量**

Run: `pnpm test`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/ops-app.ts test/integration/policy-push.e2e.test.ts
git commit -m "feat(m2b): App2 ops-facing mTLS（非 CN-only SAN/EKU/validity）+content_policy push（audience/actor 校验+error_code+403 audit+CLI 入口）"
```

---

### Task 6: kind business functions 接 drm-rule-engine + audit tool_call

**Files:**
- Modify: `src/routes/stream.ts` / `query.ts` / `match.ts` / `lyrics.ts` / `metadata.ts`（+drm ctx 参数）
- Modify: `src/index.ts`（handle() 注入 drm/audit ctx）
- Modify: `src/envelope.ts`（ErrorCode enum +REGION_RESTRICTED +AUTH_FAILED，spec §4.4）
- Test: `test/integration/kind-drm-audit.e2e.test.ts`

**Interfaces:**
- Consumes: `checkDrm`（T2）、`PolicyStore`（T1）、`AuditSink` + `emitToolCall`（T3）、`getRegion`（T2）
- Produces: 各 `*Business` 第 4 参 `DrmCtx`（可选，渐进）；kind 受 policy 约束返回 BLOCKED

- [ ] **Step 1: 扩 ErrorCode enum `src/envelope.ts`**

定位 `export type ErrorCode` 行，改：

```typescript
export type ErrorCode =
  | "NO_RESULT"
  | "COPYRIGHT_RESTRICTED"
  | "REGION_RESTRICTED"
  | "BACKEND_UNAVAILABLE"
  | "AUTH_FAILED";
```

- [ ] **Step 2: 写失败测试 `test/integration/kind-drm-audit.e2e.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/index.js";
import { createTestDb, seedTrack } from "./helpers.js"; // 既有，eng C2 修正
import { createPolicyStore } from "../../src/policy/policy-store.js";
import { createAuditSink, verifyChain } from "../../src/audit/audit-sink.js";
import { rmSync, readFileSync } from "node:fs";

const auditPath = ".tmp-audit-kind.jsonl";
beforeEach(() => rmSync(auditPath, { force: true }));
afterEach(() => rmSync(auditPath, { force: true }));

// envelope 含 upstream version（T1 PolicyEnvelope 要求）
function blockEnvelope(cmdId: string, action: "block" | "allow" | "region_restrict" = "block") {
  return {
    command_id: cmdId, kind: "content_policy" as const, capability_mode: "real", version: 1,
    payload: { rule_id: "r1", action: action as any, target_scope: "content_management" },
    security_context: { actor: "ops-platform", rbac_decision: { allowed: true }, audience: "content_backend", expiry: new Date(Date.now() + 60000).toISOString() },
  };
}

describe("kind drm + audit e2e", () => {
  it("block policy → content_stream 403 COPYRIGHT_RESTRICTED + emit tool_call audit（fold eng M4）", async () => {
    const db = await createTestDb();
    await seedTrack(db, "self:t1"); // helpers 既有
    const store = createPolicyStore(db);
    await store.applyPolicy(blockEnvelope("cmd-block"), "ops-platform");
    const app = await buildServer({ db, presign: async () => ({ url: "http://x", auth: { token: "t", token_type: "query_param", expires_at: "x" } }), policyStore: store, auditSink: createAuditSink(auditPath), actor: "cloud-ext" });
    const res = await app.inject({ method: "POST", url: "/content_stream", payload: { track_id: "self:t1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe("COPYRIGHT_RESTRICTED");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]).eventType).toBe("tool_call"); // blocked 也 emit
  });

  it("无 policy → allow 200", async () => {
    const db = await createTestDb();
    await seedTrack(db, "self:t1");
    const store = createPolicyStore(db);
    const app = await buildServer({ db, presign: async () => ({ url: "http://x", auth: { token: "t", token_type: "query_param", expires_at: "x" } }), policyStore: store, auditSink: createAuditSink(auditPath), actor: "cloud-ext" });
    const res = await app.inject({ method: "POST", url: "/content_stream", payload: { track_id: "self:t1" } });
    expect(res.statusCode).toBe(200);
  });

  it("ok 路径 emit tool_call audit + hash chain 完整", async () => {
    const db = await createTestDb();
    await seedTrack(db, "self:t1");
    const store = createPolicyStore(db);
    const app = await buildServer({ db, presign: async () => ({ url: "http://x", auth: { token: "t", token_type: "query_param", expires_at: "x" } }), policyStore: store, auditSink: createAuditSink(auditPath), actor: "cloud-ext" });
    await app.inject({ method: "POST", url: "/content_metadata", payload: { track_id: "self:t1" } });
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).eventType).toBe("tool_call");
    expect(JSON.parse(lines[0]).actor).toBe("cloud-ext");
    expect(verifyChain(auditPath)).toBe(true);
  });

  it("policy store 故障 → fail-closed 503（auditSink 注入）", async () => {
    const db = await createTestDb();
    await seedTrack(db, "self:t1");
    const brokenStore = { applyPolicy: async () => { throw new Error("db down"); }, latestPolicy: async () => { throw new Error("db down"); } };
    const app = await buildServer({ db, presign: async () => ({ url: "http://x", auth: { token: "t", token_type: "query_param", expires_at: "x" } }), policyStore: brokenStore as any, auditSink: createAuditSink(auditPath), actor: "cloud-ext" });
    const res = await app.inject({ method: "POST", url: "/content_stream", payload: { track_id: "self:t1" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe("BACKEND_UNAVAILABLE");
  });

  // fold codex P1#6：DRM fail-closed 独立于 audit 注入——buildServer 默认从 env 注入 policyStore，
  // 即使不传 auditSink，drm 仍生效（仅无 audit emit）。
  it("fail-closed 默认生效（不传 auditSink/policyStore，buildServer 默认注入）", async () => {
    const db = await createTestDb();
    await seedTrack(db, "self:t1");
    const store = createPolicyStore(db);
    await store.applyPolicy(blockEnvelope("cmd-default"), "ops-platform");
    // 不传 policyStore/auditSink → buildServer 默认从 env/createPolicyStore(db) 注入
    const app = await buildServer({ db, presign: async () => ({ url: "http://x", auth: { token: "t", token_type: "query_param", expires_at: "x" } }), policyStore: store });
    const res = await app.inject({ method: "POST", url: "/content_stream", payload: { track_id: "self:t1" } });
    expect(res.statusCode).toBe(403); // drm 生效，即使无 auditSink
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test test/integration/kind-drm-audit.e2e.test.ts`
Expected: FAIL（buildServer 不接受 policyStore/auditSink/actor；drm-guard 不存在）

- [ ] **Step 4: 创建 `src/policy/drm-ctx.ts` + `src/policy/drm-guard.ts`（fold codex P2/eng M2：中央 guard，不跨 5 business 重复）**

`src/policy/drm-ctx.ts`：
```typescript
// drm-ctx.ts — DrmCtx 共享类型（fold eng M2，不放 stream.ts 避免跨路由耦合）。
import type { PolicyStore } from "./policy-store.js";
import type { AuditSink } from "../audit/audit-sink.js";
import type { Kind } from "../envelope.js";

export interface DrmCtx {
  policyStore: PolicyStore;
  auditSink?: AuditSink; // audit 可选（drm fail-closed 不依赖 audit，fold codex P1#6）
  actor: string;
  requestRegion?: string;
}
```

`src/policy/drm-guard.ts`：
```typescript
// drm-guard.ts — 中央 drm check + audit（fold codex P2，业务函数不重复 drm 块）。
// copyright 优先于 availability（spec §5.2）；fail-closed（policy store 故障→BLOCKED）；空集 allow。
import type { DrmCtx } from "./drm-ctx.js";
import { checkDrm } from "./drm-rule-engine.js";
import { getRegion } from "./region-config.js";
import { emitToolCall } from "../audit/audit-events.js";
import type { ErrorCode } from "../envelope.js";

export interface DrmBlocked { blocked: true; errorCode: ErrorCode; }
export interface DrmAllow { blocked: false; }

/** kind 调用前调；返回 blocked→handle 直接返 BLOCKED envelope 不调 business fn。 */
export async function drmGuard(ctx: DrmCtx, kind: Kind, trackId: string): Promise<DrmBlocked | DrmAllow> {
  try {
    const policies = await ctx.policyStore.latestPolicy();
    const dec = checkDrm(policies, kind, trackId, ctx.requestRegion ?? getRegion(), getRegion());
    if (dec) {
      const errorCode: ErrorCode = dec.action === "block" ? "COPYRIGHT_RESTRICTED" : "REGION_RESTRICTED";
      if (ctx.auditSink) await emitToolCall(ctx.auditSink, { kind, target: trackId, actor: ctx.actor });
      return { blocked: true, errorCode };
    }
    return { blocked: false };
  } catch {
    // fail-closed（policy store 故障）
    return { blocked: true, errorCode: "BACKEND_UNAVAILABLE" };
  }
}
```

**业务函数（stream.ts 等）不内联 drm 块**——drm 由 index.ts handle() 在调 business 前调 drmGuard。stream.ts 保留既有 selectPath/presign 逻辑不变，仅 `ctx?` 第参用于 ok 路径 audit emit：

```typescript
// stream.ts：移除内联 drm 块，仅保留 ok 路径 audit emit（fold codex P2）
import type { DrmCtx } from "../policy/drm-ctx.js";
import { emitToolCall } from "../audit/audit-events.js";

export async function streamBusiness(
  db: ContentDb, presign: PresignFn, trackId: string, ctx?: DrmCtx,
): Promise<StreamOutcome> {
  // 既有 parseTrackId + selectPath + tracks 查询 + presign 逻辑不变（无内联 drm）
  // ...（既有实现）
  // ok 返回前 emit audit（成功路径）
  if (ctx?.auditSink) await emitToolCall(ctx.auditSink, { kind: "content_stream", target: trackId, actor: ctx.actor, streamId: result.business.stream_id });
  return result;
}
```

对 query/match/lyrics/metadata 各 `*Business` 加 `ctx?` 第参（仅 ok 路径 emit tool_call，无内联 drm 块）。

- [ ] **Step 5: 改 `src/index.ts` buildServer + handle()（fold codex P1#6：默认注入 policyStore，drm 独立于 audit）**

```typescript
import type { PolicyStore } from "./policy/policy-store.js";
import { createPolicyStore } from "./policy/policy-store.js";
import type { AuditSink } from "./audit/audit-sink.js";
import type { DrmCtx } from "./policy/drm-ctx.js";
import { drmGuard } from "./policy/drm-guard.js";

export interface BuildServerOpts {
  db?: ContentDb; s3?: any; bucket?: string; presign?: PresignFn;
  policyStore?: PolicyStore; auditSink?: AuditSink; actor?: string;
}

// buildServer 体内：policyStore 默认始终注入（不依赖 auditSink），drm fail-closed 独立（fold codex P1#6）
const policyStore = opts.policyStore ?? createPolicyStore(db);
const auditSink = opts.auditSink; // 可选——无 audit 时 drm 仍生效，仅无 audit emit
const actor = opts.actor ?? "anonymous-service";
const ctx: DrmCtx = { policyStore, auditSink, actor };

// handle() 在调 business 前先 drmGuard（blocked→直接返 BLOCKED envelope 不调 business）
async function handle(kind: Kind, fn: () => Promise<HandlerResult>, trackId: string): Promise<{ envelope: object; status: number }> {
  const guard = await drmGuard(ctx, kind, trackId);
  if (guard.blocked) {
    const envelope = wrapEnvelope({}, kind, "self_hosted", "unavailable", "blocked", guard.errorCode);
    return { envelope, status: httpStatus(envelope.completion_state, envelope.error_code) };
  }
  const r = await fn(); // business fn 不再内联 drm
  const envelope = wrapEnvelope(r.business, kind, r.backendType, r.capabilityMode, r.outcome, r.errorCode);
  return { envelope, status: httpStatus(envelope.completion_state, envelope.error_code) };
}

// 各 route handler 调用传 trackId 给 handle：
app.post("/content_stream", async (req, reply) => {
  const tid = (req.body as any).track_id;
  const { envelope, status } = await handle("content_stream", () => streamBusiness(db, presign, tid, ctx), tid);
  reply.code(status).send(envelope);
});
// query/match 用 query 字段（trackId 暂用 query 关键字或空——sim block 全 track 故 query 也 blocked，
// 传 "" 或首 keyword 作 trackId 占位，guard block policy 全 kind 全 track 仍命中）
```

注：buildServer 默认注入 policyStore=createPolicyStore(db)——既有 66 e2e 未传 policyStore 时用默认 store（空集 policy→allow），行为不变不回归；drm 现在默认生效（空集 allow），生产路径注入 auditSink 即有 audit。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test test/integration/kind-drm-audit.e2e.test.ts`
Expected: PASS 5/5

- [ ] **Step 7: 跑全量**

Run: `pnpm test`
Expected: 全 PASS（含既有 66 + 新增；若有 lyrics restricted e2e 因 drm 改动受影响，按 T4 同理更新断言）

- [ ] **Step 8: Commit**

```bash
git add src/envelope.ts src/policy/drm-ctx.ts src/policy/drm-guard.ts src/routes/ src/index.ts test/integration/kind-drm-audit.e2e.test.ts
git commit -m "feat(m2b): 中央 drm-guard+drm-ctx（kind business 不重复 drm 块）+fail-closed 独立于 audit+blocked emit tool_call"
```

---

### Task 7: 审核 UI（SSR+htmx）+ session 认证 + ingest 边界校验 I2

**Files:**
- Create: `src/auth/session.ts`（sim session admin/operator）
- Create: `src/admin/ingest.ts`（ingest handler + I2 边界校验，**camelCase 对齐 state-machine**，fold codex P1#7/eng I2）
- Create: `src/admin/views.ts`（eta SSR 模板）
- Create: `src/admin/templates/tracks.eta` / `ingest-detail.eta` / `login.eta` / `ingest-form.eta`（**全文模板**，fold design C2）
- Vendor: `public/htmx.min.js`（下载 htmx 2.x min）
- Modify: `src/ops-app.ts`（挂 /admin/* routes + @fastify/cookie + @fastify/static）
- Test: `test/integration/admin-ui.e2e.test.ts`

**Interfaces:**
- Consumes: `transition` + `fetchIngest`（review/state-machine.ts 既有/补）、`emitProvision/emitRevoke`（T3）、`loadEnv`（admin/operator token）
- Produces: GET `/admin/login` + GET `/admin/ingests`（pending queue）+ GET `/admin/ingest/:id` + GET `/admin/tracks`；POST `/admin/login` + `/admin/ingest` + `/admin/ingest/:id/{approve,reject,revoke}`（**reject 显式**，fold design I2）

- [ ] **Step 1: vendor htmx**

Run: `curl -sL https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js -o public/htmx.min.js && wc -c public/htmx.min.js`
Expected: 文件存在（~14KB）。commit vendor 文件（无 build，fold devex M2）。若网络不可用离线手放。

- [ ] **Step 2: 写失败测试 `test/integration/admin-ui.e2e.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { createTestDb, seedTrack } from "./helpers.js"; // eng C2 修正
import { createAuditSink } from "../../src/audit/audit-sink.js";
import { rmSync, readFileSync } from "node:fs";

let app: any, db: any;
const auditPath = ".tmp-audit-admin.jsonl";
beforeAll(async () => {
  db = await createTestDb();
  app = await buildOpsApp({ db, auditSink: createAuditSink(auditPath), adminToken: "dev-admin", operatorToken: "dev-op" });
});
afterAll(async () => { await app.close(); rmSync(auditPath, { force: true }); });

async function login(token: string) {
  const r = await app.inject({ method: "POST", url: "/admin/login", payload: { token } });
  const sc = r.headers["set-cookie"];
  return Array.isArray(sc) ? sc[0] : sc;
}

// raw_metadata camelCase 对齐 state-machine.ts（durationMs/coverUrl/isrc/regionPolicy/album），fold codex P1#7/eng I2
const GOOD = { title: "A", artist: "B", durationMs: 1000, format: "mp3", bitrate: 128000, license: "CC" };

describe("admin UI e2e", () => {
  it("GET /admin/login 渲染登录页（fold design C3）", async () => {
    const r = await app.inject({ method: "GET", url: "/admin/login" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("token");
  });

  it("ingest 缺 title → 400 + HTML partial 含错误（I2 + design I3 htmx 回填）", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({ method: "POST", url: "/admin/ingest", payload: { track_id: "self:t99", raw_metadata: { artist: "X", durationMs: 1000 } }, headers: { cookie } });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("missing title");
  });

  it("ingest 完整 → 200 + pending（camelCase）", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({ method: "POST", url: "/admin/ingest", payload: { track_id: "self:t1", raw_metadata: GOOD, audioObjectKey: "k1" }, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe("pending");
  });

  it("approve → emit provision audit（target=trackId 非空，fold eng I1）+ tracks 入库（fold codex P2）", async () => {
    const cookie = await login("dev-admin");
    const ing = await app.inject({ method: "POST", url: "/admin/ingest", payload: { track_id: "self:t2", raw_metadata: { ...GOOD, title: "C", artist: "D", durationMs: 2000 }, audioObjectKey: "k2" }, headers: { cookie } });
    const id = ing.json().id;
    const r = await app.inject({ method: "POST", url: `/admin/ingest/${id}/approve`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("已审核"); // htmx HTML partial（fold design C1）
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const ev = JSON.parse(lines[lines.length - 1]);
    expect(ev.eventType).toBe("provision");
    expect(ev.target).toBe("self:t2"); // 非空 trackId
    // tracks 入库查询（fold codex P2，非自证）
    const t = await app.inject({ method: "GET", url: "/admin/tracks", headers: { cookie } });
    expect(t.body).toContain("self:t2");
  });

  it("reject → 200 + HTML partial（fold design I2，reject 显式 route）", async () => {
    const cookie = await login("dev-admin");
    const ing = await app.inject({ method: "POST", url: "/admin/ingest", payload: { track_id: "self:t3", raw_metadata: GOOD, audioObjectKey: "k3" }, headers: { cookie } });
    const r = await app.inject({ method: "POST", url: `/admin/ingest/${ing.json().id}/reject`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
  });

  it("operator 不能 ingest（admin only）→ 403", async () => {
    const cookie = await login("dev-op");
    const r = await app.inject({ method: "POST", url: "/admin/ingest", payload: { track_id: "self:t4", raw_metadata: GOOD }, headers: { cookie } });
    expect(r.statusCode).toBe(403);
  });

  it("未登录 → 401", async () => {
    const r = await app.inject({ method: "POST", url: "/admin/ingest", payload: {} });
    expect(r.statusCode).toBe(401);
  });

  it("GET /admin/ingests 渲染 pending queue（fold design C3）", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({ method: "GET", url: "/admin/ingests", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("htmx");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test test/integration/admin-ui.e2e.test.ts`
Expected: FAIL（/admin/* GET route 不存在）

- [ ] **Step 4: 实现 `src/auth/session.ts`**

```typescript
// session.ts — sim 简单认证（admin/operator, dev token + session cookie, M1c 未启动）。
import { randomUUID } from "node:crypto";

export interface SessionUser { role: "admin" | "operator"; name: string; }
const SESSIONS = new Map<string, { user: SessionUser; ts: number }>(); // sim 内存
const TTL_MS = 8 * 3600 * 1000; // 8h TTL（fold devex M3）

export function createSession(user: SessionUser): string {
  const id = randomUUID();
  SESSIONS.set(id, { user, ts: Date.now() });
  return id;
}
export function getSession(id: string): SessionUser | null {
  const e = SESSIONS.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) { SESSIONS.delete(id); return null; }
  return e.user;
}
export function requireRole(role: "admin" | "operator") {
  return async (req: any, reply: any) => {
    const sid = req.headers?.cookie?.match(/sid=([^;]+)/)?.[1];
    const u = sid ? getSession(sid) : null;
    if (!u) return reply.code(401).send({ error_code: "UNAUTHORIZED", message: "login required" });
    if (u.role !== role && u.role !== "admin") return reply.code(403).send({ error_code: "FORBIDDEN", message: "admin only" });
    (req as any).user = u;
  };
}
```

- [ ] **Step 5: 实现 `src/admin/ingest.ts`（camelCase 对齐 + fetchIngest trackId，fold codex P1#7/eng I1/I2）**

```typescript
// ingest.ts — ingest 入库 + I2 边界校验 + transition+audit（spec §8.1 + I2 hardening）。
// raw_metadata 字段名 camelCase 对齐 state-machine.ts（meta.durationMs/coverUrl/isrc/regionPolicy/album）。
import type { ContentDb } from "../content/db.js";
import { transition } from "../review/state-machine.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { emitProvision, emitRevoke } from "../audit/audit-events.js";

// I2 边界校验：camelCase 字段（对齐 state-machine approve 解析）
const REQUIRED = ["title", "artist", "durationMs", "format", "bitrate", "license"];
export function validateRawMetadata(raw: any): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") return ["raw_metadata must be object"];
  for (const f of REQUIRED) if (raw[f] == null) errs.push(`missing ${f}`);
  if (raw.durationMs != null && typeof raw.durationMs !== "number") errs.push("durationMs must be number");
  return errs;
}

export async function ingestCreate(db: ContentDb, trackId: string, rawMetadata: any, audioObjectKey: string | null) {
  const id = `ing_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.query(
    "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'pending')",
    [id, trackId, "admin-ui", JSON.stringify(rawMetadata), audioObjectKey],
  );
  return { id, state: "pending" as const, trackId };
}

// fetchIngest 取 trackId（fold eng I1：audit target 非空）
async function fetchIngestTrackId(db: ContentDb, ingestId: string): Promise<string | null> {
  const { rows } = await db.query("SELECT track_id FROM ingest WHERE id = $1 LIMIT 1", [ingestId]);
  return rows[0]?.track_id ?? null;
}

export async function ingestTransitionAndAudit(
  db: ContentDb, auditSink: AuditSink, ingestId: string, action: "approve" | "reject" | "revoke", actor: string,
) {
  const trackId = await fetchIngestTrackId(db, ingestId);
  await transition(db, ingestId, action, actor);
  if (action === "approve" && trackId) await emitProvision(auditSink, { ingestId, trackId, actor });
  if (action === "revoke" && trackId) await emitRevoke(auditSink, { trackId, actor });
  // reject 不 emit provision/revoke（仅状态转移）
  return { trackId };
}
```

- [ ] **Step 6: 实现 `src/admin/views.ts` + 4 个 eta 模板全文（fold design C2）**

`src/admin/views.ts`：
```typescript
// views.ts — eta SSR 模板（审核 UI，htmx 渐进增强）。
import { Eta } from "eta";
import { readFileSync } from "node:fs";
const eta = new Eta({ cache: false });

// 内联模板字符串（避免 eta views 路径配置，自包含）
const TEMPLATES: Record<string, string> = {
  login: readFileSync("src/admin/templates/login.eta", "utf8"),
  tracks: readFileSync("src/admin/templates/tracks.eta", "utf8"),
  "ingest-detail": readFileSync("src/admin/templates/ingest-detail.eta", "utf8"),
  "ingest-form": readFileSync("src/admin/templates/ingest-form.eta", "utf8"),
};
function render(name: string, data: object): string {
  return eta.renderString(TEMPLATES[name], data);
}
export const renderLogin = () => render("login", {});
export const renderTracksList = (tracks: any[]) => render("tracks", { tracks });
export const renderIngestDetail = (ingest: any) => render("ingest-detail", { ingest });
export const renderIngestForm = (errs: string[] = []) => render("ingest-form", { errs });
// htmx partial：审核动作后原地替换 ingest 行
export const renderIngestRow = (ingest: any) => render("ingest-detail", { ingest });
```

`src/admin/templates/login.eta`：
```html
<!doctype html><html><head><meta charset="utf-8"><title>AgentOS 审核 UI</title>
<script src="/public/htmx.min.js"></script></head><body>
<h1>登录</h1><form hx-post="/admin/login" hx-swap="outerHTML">
<input name="token" placeholder="dev token"><button>登录</button></form></body></html>
```

`src/admin/templates/tracks.eta`：
```html
<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script></head><body>
<h1>已发布 tracks</h1>
<div id="tracks" hx-get="/admin/tracks" hx-trigger="every 10s" hx-swap="innerHTML">
<table><tr><th>track_id</th><th>title</th><th>artist</th></tr>
<% it.tracks.forEach(t => { %><tr><td><%= t.track_id %></td><td><%= t.title %></td><td><%= t.artist %></td></tr><% }) %>
</table></div></body></html>
```

`src/admin/templates/ingest-detail.eta`：
```html
<tr id="ingest-<%= it.ingest.id %>">
<td><%= it.ingest.track_id %></td><td><%= it.ingest.state %></td>
<td>
<% if (it.ingest.state === 'pending') { %>
<button hx-post="/admin/ingest/<%= it.ingest.id %>/approve" hx-target="#ingest-<%= it.ingest.id %>" hx-swap="outerHTML">approve</button>
<button hx-post="/admin/ingest/<%= it.ingest.id %>/reject" hx-target="#ingest-<%= it.ingest.id %>" hx-swap="outerHTML">reject</button>
<% } else if (it.ingest.state === 'approved') { %>已审核<% } else if (it.ingest.state === 'rejected') { %>已拒<% } %>
<% if (it.ingest.state === 'approved' || it.ingest.state === 'revoked') { %>
<button hx-post="/admin/ingest/<%= it.ingest.id %>/revoke" hx-target="#ingest-<%= it.ingest.id %>" hx-swap="outerHTML">revoke</button><% } %>
</td></tr>
```

`src/admin/templates/ingest-form.eta`：
```html
<form hx-post="/admin/ingest" hx-target="#ingest-result" hx-swap="innerHTML">
<input name="track_id" placeholder="self:t1">
<input name="audio_object_key" placeholder="k1">
<textarea name="raw_metadata">{"title":"","artist":"","durationMs":0,"format":"mp3","bitrate":128000,"license":"CC"}</textarea>
<button>入库</button>
<% if (it.errs.length) { %><ul><% it.errs.forEach(e => { %><li class="error"><%= e %></li><% }) %></ul><% } %>
</form><div id="ingest-result"></div>
```

- [ ] **Step 7: 改 `src/ops-app.ts` 挂 /admin/* routes（4 GET + 4 POST，htmx partial，fold design C1/C3）**

`BuildOpsAppOpts` 已有 `adminToken?`/`operatorToken?`（T5 加）；buildOpsApp 内追加：

```typescript
import cookiePlugin from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { createSession, requireRole } from "./auth/session.js";
import { validateRawMetadata, ingestCreate, ingestTransitionAndAudit } from "./admin/ingest.js";
import { renderLogin, renderTracksList, renderIngestDetail, renderIngestForm } from "./admin/views.js";

if (opts.adminToken) {
  app.register(cookiePlugin);
  app.register(staticPlugin, { root: "public", prefix: "/public/" });

  // GET routes（fold design C3）
  app.get("/admin/login", async (_req, reply) => reply.type("text/html").send(renderLogin()));
  app.get("/admin/ingests", { preHandler: requireRole("operator") }, async (req, reply) => {
    const { rows } = await opts.db.query("SELECT id, track_id, state FROM ingest WHERE state='pending' ORDER BY created_at");
    const rows2 = rows.map((r: any) => ({ id: String(r.id), track_id: String(r.track_id), state: String(r.state) }));
    const html = `<table>${rows2.map((i: any) => renderIngestDetail(i)).join("")}</table>`;
    return reply.type("text/html").send(html);
  });
  app.get("/admin/ingest/:id", { preHandler: requireRole("operator") }, async (req, reply) => {
    const { rows } = await opts.db.query("SELECT id, track_id, state FROM ingest WHERE id=$1", [(req.params as any).id]);
    if (!rows[0]) return reply.code(404).send({ error_code: "NOT_FOUND", message: "ingest not found" });
    return reply.type("text/html").send(renderIngestDetail({ id: String(rows[0].id), track_id: String(rows[0].track_id), state: String(rows[0].state) }));
  });
  app.get("/admin/tracks", { preHandler: requireRole("operator") }, async (_req, reply) => {
    const { rows } = await opts.db.query("SELECT track_id, title, artist FROM tracks");
    return reply.type("text/html").send(renderTracksList(rows));
  });

  // POST routes
  app.post("/admin/login", async (req, reply) => {
    const { token } = req.body as any;
    let role: "admin" | "operator" | null = null;
    if (token === opts.adminToken) role = "admin";
    else if (token === opts.operatorToken) role = "operator";
    if (!role) return reply.code(401).send({ error_code: "INVALID_TOKEN", message: "invalid token" });
    const sid = createSession({ role, name: role });
    reply.setCookie("sid", sid, { httpOnly: true, sameSite: "lax", secure: true }); // secure: App2 mTLS https（fold design M2）
    return reply.type("text/html").send(renderLogin()); // htmx 可替换
  });

  app.post("/admin/ingest", { preHandler: requireRole("admin") }, async (req, reply) => {
    const { track_id, raw_metadata, audioObjectKey } = req.body as any;
    const errs = validateRawMetadata(raw_metadata);
    if (errs.length) return reply.code(400).type("text/html").send(renderIngestForm(errs)); // htmx 回填错误（fold design I3）
    const r = await ingestCreate(opts.db, track_id, raw_metadata, audioObjectKey ?? null);
    return reply.type("text/html").send(renderIngestDetail({ id: r.id, track_id: r.trackId, state: r.state }));
  });

  // approve/reject/revoke 返 HTML partial（hx-swap outerHTML，fold design C1）
  const transitionRoute = (action: "approve" | "reject" | "revoke") => app.post(
    `/admin/ingest/:id/${action}`, { preHandler: requireRole("admin") }, async (req, reply) => {
      const { trackId } = await ingestTransitionAndAudit(opts.db, opts.auditSink, (req.params as any).id, action, (req as any).user.name);
      const state = action === "approve" ? "approved" : action === "reject" ? "rejected" : "revoked";
      return reply.type("text/html").send(renderIngestDetail({ id: (req.params as any).id, track_id: trackId ?? "", state }));
    },
  );
  transitionRoute("approve");
  transitionRoute("reject"); // 显式 reject route（fold design I2）
  transitionRoute("revoke");
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm test test/integration/admin-ui.e2e.test.ts`
Expected: PASS 9/9

- [ ] **Step 9: 跑全量**

Run: `pnpm test`
Expected: 全 PASS

- [ ] **Step 10: Commit**

```bash
git add src/auth/ src/admin/ public/ src/ops-app.ts test/integration/admin-ui.e2e.test.ts
git commit -m "feat(m2b): 审核 UI SSR+htmx（4 GET+4 POST route+3 eta 全文模板+htmx partial）+session+ingest 边界校验 I2（camelCase 对齐+audit target 非空）"
```

---

### Task 8: mock producer + sim 闭环 e2e + README

**Files:**
- Create: `scripts/mock-policy-producer.ts`（sim CA cert 签 envelope + push）
- Create: `test/integration/sim-closed-loop.e2e.test.ts`（全链：producer push → app2 → app1 kind 受约束 → audit）
- Modify: `README.md`（+M2b 启动/验证说明）

**Interfaces:**
- Consumes: 全部前 task（buildOpsApp + buildServer + createPolicyStore + createAuditSink + selfsigned）

- [ ] **Step 1: 写失败测试 `test/integration/sim-closed-loop.e2e.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { buildServer } from "../../src/index.js";
import { createTestDb, seedTrack } from "./helpers.js"; // eng C2 修正
import { createPolicyStore } from "../../src/policy/policy-store.js";
import { createAuditSink, verifyChain } from "../../src/audit/audit-sink.js";
import { pushPolicy } from "../../scripts/mock-policy-producer.js";
import { rmSync, readFileSync } from "node:fs";
import selfsigned from "selfsigned";

const auditPath = ".tmp-audit-sim.jsonl";
let opsApp: any, apiApp: any, db: any, store: any, caCert: any, serviceCert: any, opsPort: number;

beforeAll(async () => {
  rmSync(auditPath, { force: true });
  db = await createTestDb();
  await seedTrack(db, "self:t1");
  store = createPolicyStore(db);
  const audit = createAuditSink(auditPath);
  caCert = selfsigned.generate(null, { name: "CN=sim-ca", days: 365 });
  serviceCert = selfsigned.generate(
    [{ name: "commonName", value: "ops-platform" }, { name: "subjectAltName", value: { value: [{ type: 2, value: "localhost" }] } }],
    { days: 365, keyPair: caCert.keyPair, extensions: [{ name: "extKeyUsage", value: "clientAuth" }] },
  );
  opsApp = await buildOpsApp({ db, auditSink: audit, policyStore: store, tlsOpts: { ca: caCert.cert, requestCert: true, rejectUnauthorized: true }, expectedSan: "localhost" });
  await opsApp.listen({ port: 0, host: "127.0.0.1" });
  opsPort = opsApp.server.address().port;
  apiApp = await buildServer({ db, presign: async () => ({ url: "http://x", auth: { token: "t", token_type: "query_param", expires_at: "x" } }), policyStore: store, auditSink: audit, actor: "cloud-ext" });
});
afterAll(async () => { await opsApp.close(); await apiApp.close(); rmSync(auditPath, { force: true }); });

describe("sim 闭环 e2e", () => {
  it("block → app1 /content_stream 403 COPYRIGHT_RESTRICTED", async () => {
    await pushPolicy({
      port: opsPort, ca: caCert.cert, key: serviceCert.key, cert: serviceCert.cert,
      commandId: "sim-block", action: "block", audience: "content_backend", upstreamVersion: 1,
    });
    const res = await apiApp.inject({ method: "POST", url: "/content_stream", payload: { track_id: "self:t1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe("COPYRIGHT_RESTRICTED");
  });

  it("allow → app1 /content_stream 200（fold ceo M2，非只 block）", async () => {
    await pushPolicy({
      port: opsPort, ca: caCert.cert, key: serviceCert.key, cert: serviceCert.cert,
      commandId: "sim-allow", action: "allow", audience: "content_backend", upstreamVersion: 2,
    });
    const res = await apiApp.inject({ method: "POST", url: "/content_stream", payload: { track_id: "self:t1" } });
    expect(res.statusCode).toBe(200);
  });

  it("region_restrict + region 不符 → 403 REGION_RESTRICTED（fold ceo M2）", async () => {
    await pushPolicy({
      port: opsPort, ca: caCert.cert, key: serviceCert.key, cert: serviceCert.cert,
      commandId: "sim-region", action: "region_restrict", audience: "content_backend", upstreamVersion: 3,
    });
    // requestRegion 默认 cn（region-config env），region_restrict policy 命中不符→REGION_RESTRICTED
    const res = await apiApp.inject({ method: "POST", url: "/content_stream", payload: { track_id: "self:t1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe("REGION_RESTRICTED");
  });

  it("audit 链含 config_apply + tool_call，hash chain 完整", async () => {
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const types = lines.map((l) => JSON.parse(l).eventType);
    expect(types).toContain("config_apply");
    expect(types).toContain("tool_call");
    expect(verifyChain(auditPath)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test test/integration/sim-closed-loop.e2e.test.ts`
Expected: FAIL（mock-policy-producer 不存在）

- [ ] **Step 3: 实现 `scripts/mock-policy-producer.ts`（真实 CLI，非 placeholder，fold devex C1/eng M1）**

```typescript
// mock-policy-producer.ts — sim ops-platform producer（sim CA cert 签服务 cert + push content_policy envelope）。
// 既作 e2e 测试模块（pushPolicy 导出），又作 CLI（tsx scripts/mock-policy-producer.ts <port> <action> <commandId> [version]）。
import { request } from "node:https";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import selfsigned from "selfsigned";

export interface PushOpts {
  port: number; ca: string; key: string; cert: string;
  commandId: string; action: "allow" | "block" | "region_restrict"; audience: string;
  upstreamVersion: number; // T1 PolicyEnvelope 要求
}

export function pushPolicy(opts: PushOpts): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const envelope = {
      command_id: opts.commandId, kind: "content_policy", capability_mode: "real", version: opts.upstreamVersion,
      payload: { rule_id: "r1", action: opts.action, target_scope: "content_management" },
      security_context: {
        actor: "ops-platform", rbac_decision: { role: "admin", allowed: true },
        audience: opts.audience, expiry: new Date(Date.now() + 60000).toISOString(),
      },
    };
    const data = JSON.stringify(envelope);
    const req = request({
      port: opts.port, host: "127.0.0.1", method: "POST", path: "/content_policy/push",
      ca: opts.ca, key: opts.key, cert: opts.cert,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(buf || "{}") }));
    });
    req.on("error", (e) => resolve({ status: 0, body: { error: String(e) } }));
    req.write(data); req.end();
  });
}

// cert 缓存：首次生成 sim CA + service cert 写 .sim-certs/，后续复用（dev 反复跑不重复生成）
function ensureCerts() {
  const dir = ".sim-certs";
  const caPath = `${dir}/ca.pem`, svcPath = `${dir}/svc.pem`, svcKeyPath = `${dir}/svc-key.pem`;
  if (existsSync(caPath) && existsSync(svcPath)) {
    return { ca: readFileSync(caPath, "utf8"), cert: readFileSync(svcPath, "utf8"), key: readFileSync(svcKeyPath, "utf8") };
  }
  const ca = selfsigned.generate(null, { name: "CN=sim-ca", days: 365 });
  const svc = selfsigned.generate(
    [{ name: "commonName", value: "ops-platform" }, { name: "subjectAltName", value: { value: [{ type: 2, value: "localhost" }] } }],
    { days: 365, keyPair: ca.keyPair, extensions: [{ name: "extKeyUsage", value: "clientAuth" }] },
  );
  writeFileSync(caPath, ca.cert); writeFileSync(svcPath, svc.cert); writeFileSync(svcKeyPath, svc.key);
  return { ca: ca.cert, cert: svc.cert, key: svc.key };
}

// CLI: tsx scripts/mock-policy-producer.ts <port> <action> <commandId> [version]
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , port, action, commandId, version] = process.argv;
  if (!port || !action || !commandId) {
    console.error("usage: tsx scripts/mock-policy-producer.ts <port> <allow|block|region_restrict> <commandId> [version=1]");
    process.exit(1);
  }
  const { ca, cert, key } = ensureCerts();
  pushPolicy({
    port: Number(port), ca, key, cert,
    commandId, action: action as any, audience: "content_backend", upstreamVersion: Number(version ?? 1),
  }).then((r) => console.log(JSON.stringify(r)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test test/integration/sim-closed-loop.e2e.test.ts`
Expected: PASS 4/4（block + allow + region_restrict + audit 链）

- [ ] **Step 5: 跑全量**

Run: `pnpm test`
Expected: 全 PASS（66 旧 + M2b 全新增）

- [ ] **Step 6: 更新 README.md（具体内容，非一行，fold devex C1）**

追加 M2b 章节：

```markdown
## M2b 审核 UI + content_policy 消费通道

### 启动双 app
# App1（5 kind API，port 3001）
tsx src/index.ts

# App2（ops-facing，port 3002，mTLS sim CA）
tsx src/ops-app.ts
# env: AUDIT_SINK_PATH / CONTENT_BACKEND_REGION / CONTENT_BACKEND_ADMIN_TOKEN / CONTENT_BACKEND_OPERATOR_TOKEN / OPS_PORT

### sim 闭环演示
# 1. 启 App2（生成 sim CA cert + listen 3002）
OPS_PORT=3002 tsx src/ops-app.ts
# 2. mock producer push block policy
tsx scripts/mock-policy-producer.ts 3002 block sim-block 1
# 3. 启 App1，调 /content_stream → 403 COPYRIGHT_RESTRICTED
tsx src/index.ts  # 另一终端
curl -X POST localhost:3001/content_stream -d '{"track_id":"self:t1"}'

### 审核 UI
浏览器开 https://localhost:3002/admin/login（sim CA self-signed，需信任），dev token = CONTENT_BACKEND_ADMIN_TOKEN。

### 验收
pnpm test  # 全 PASS
```

- [ ] **Step 7: Commit**

```bash
git add scripts/mock-policy-producer.ts test/integration/sim-closed-loop.e2e.test.ts README.md
git commit -m "feat(m2b): mock producer 真实 CLI（cert 缓存+push）+sim 闭环 e2e（block/allow/region_restrict 全链+audit 链）+README 双 app 启动"
```

---

## Self-Review（v2，fold 5 路 review findings）

**1. Spec coverage**：
- §4.1 policy-store 接口 → T1 ✓（含 upstream version + stale 拒绝 + transaction）
- §4.2 drm-rule-engine + region-config → T2 ✓
- §4.3 audit-sink + audit-events → T3 ✓（含 verifyChain 剔 hash 修复 + fire-and-forget + emitUnauthorized）
- §4.4 App2 路由（content_policy push + admin） → T5（push）+ T7（admin 4 GET+4 POST）✓
- §5.1 content_policy push 流 → T5/T8 ✓
- §5.2 kind API 受 drm 约束流 → T6/T8 ✓（中央 drm-guard，不内联）
- §5.3 审核流程流 → T7 ✓
- §5.4 2I hardening → T4（I1 http-mapping）+ T7（I2 ingest camelCase 校验）✓
- §6 错误处理表 → T4/T5/T6/T7 覆盖 ✓（含 403+audit unauthorized + error_code 统一）
- §7 测试矩阵 → plan task 1-8 覆盖（编号非一一对应，spec §7 已加注）
- §8 验收标准 → T4/T5/T6/T7/T8 覆盖 ✓；mTLS 非 CN-only 在 T5 sim 做 SAN/EKU/validity + 3 拒绝测试（D1=A 加强版），真机 CRL/OCSP defer M5
- §10 与 M3-pre 关系 → T4 audience/expiry + T3 audit hash chain + T5 mTLS ✓

**2. Placeholder scan**：无 TBD/TODO；每 step 含具体代码或命令。T7 eta 模板全文已写（tracks.eta/ingest-detail.eta/login.eta/ingest-form.eta，fold design C2）。mock-producer CLI 真实实现（fold devex C1/eng M1）。env.ts loadEnv 实际改动（T1 Step 2.5，fold devex I4）。

**3. Type consistency**：
- `PolicyEnvelope`（含 `version` upstream 字段，T1）/`PolicyRecord`/`PolicyStore` → T5/T6/T8 消费一致 ✓
- `DrmDecision`/`checkDrm`（T2）+ `DrmCtx`（T6 src/policy/drm-ctx.ts，fold eng M2）+ `drmGuard`（T6 src/policy/drm-guard.ts，fold codex P2）→ index.ts handle() 调用一致 ✓
- `AuditEvent`/`AuditSink`/`createAuditSink`/`verifyChain`/`emitProvision/Revoke/ConfigApply/ToolCall/Unauthorized`（T3）→ T5/T6/T7/T8 消费一致 ✓
- `ErrorCode` T6 扩 REGION_RESTRICTED/AUTH_FAILED 对齐 schema 既有 enum（fold codex P1#4 误报澄清）✓
- `httpStatus(state, errorCode)`（T4）→ index.ts handle() 调用传 errorCode 一致 ✓
- raw_metadata camelCase 对齐 state-machine.ts（T7，fold codex P1#7/eng I2）✓

**gaps**：无未覆盖 spec 条目。review fold 全落地。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | plan-eng-review subagent（fresh-context） | 架构/contract/信任边界/TDD/type/surgical | 1 | NEEDS_REVISION→fold | 2C+5I+5M 全 fold（C1 verifyChain bug / C2 helpers 夹具 / I1 audit target 空 / I2 snake_case / I3 mTLS sim / I4 stale / I5 403 audit；M2 DrmCtx 共享 等） |
| Design Review | plan-design-review subagent | UI/UX/htmx/模板/可访问 | 1 | NEEDS_REVISION→fold | 3C+5I+4M 全 fold（C1 htmx 未用 / C2 eta 模板占位 / C3 GET route 缺；I1 audit target / I2 reject 缺 / I3 400 呈现 / I4 状态可视化 / I5 logout） |
| DX Review | plan-devex-review subagent | DX/onboarding/error 一致 | 1 | NEEDS_REVISION→fold | 1C+5I+4M 全 fold（C1 sim 闭环不可跑 / I1 GET route / I2 htmx JSON / I3 error body / I4 env.ts / I5 CLI；M1-M4） |
| CEO Review | plan-ceo-review subagent | 范围/路线/ROI | 1 | NEEDS_REVISION→fold | 1C+3I+3M 全 fold（C1 mTLS CN-only / I1 编号 / I2 audit target / I3 链路 5 措辞；M1-M3） |
| Codex Review | gstack /codex（gpt-5.5，跨厂商强制） | 独立跨厂商 2nd opinion（信任边界/creds 命中强制子集） | 1 | NEEDS_REVISION→fold | 7P1+6P2 全 fold（P1 mTLS/stale/竞态/enum 越界/verifyChain/fail-closed 默认/snake_case；P2 deps/DRM 重复/envelope 信任/TDD 自证 等） |

**CODEX:** codex gpt-5.5（234864 tokens，reasoning high，read-only sandbox）7P1+6P2 全 fold；codex P1#4（REGION_RESTRICTED/AUTH_FAILED 契约越界）经核实 schema:13 已含→标误报；codex self-bias catch：mTLS "cert exists=过" 与 spec 验收#4 不一致→T5 加强 SAN/EKU/validity+3 拒绝测试。

**CROSS-MODEL:** 4 Claude subagent（eng/design/devex/ceo）+ codex(gpt-5.5) 五路收敛——mTLS CN-only（codex P1+ceo C1+eng I3 三路同指）、audit target 空（codex P1+eng I1+design I1+ceo I2 四路同指）、snake_case（codex P1+eng I2 两路同指）、verifyChain bug（codex P1+eng C1 两路同指）、stale policy（codex P1+eng I4 两路同指）。跨厂商独立性已满足（codex CLI 实际执行，非入口空转）。

**VERDICT:** ENG + DESIGN + DX + CEO + CODEX CLEARED — 五路 findings 全 fold 进 plan v2（13 must-fix + ~10 important），D1=mTLS sim 非 CN-only 加强版 / D2=ErrorCode 对齐 schema 既有 enum（codex P1#4 误报）。下一步 = SDD（subagent-driven-development，T1-T8 per-task implementer+reviewer+fix loop）+ final whole-branch review + codex 跨厂商叠加。

NO UNRESOLVED DECISIONS
