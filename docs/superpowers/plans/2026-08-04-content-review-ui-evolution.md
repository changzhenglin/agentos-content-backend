# 内容审核 UI 演进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 content-backend ops-app（App2，port 3002）既有 `/admin/*` 审核雏形演进为正式内容审核工作台：队列布局/详情（全元数据+试听+审核历史）/审核操作放宽 operator + 可选理由 + 状态机合法性防御。

**Architecture:** 机制零重写——审核动作仍走 `src/review/state-machine.ts` + `src/admin/ingest.ts` audit emit；UI 只换壳（eta 模板 + htmx SSR）。新增仅三样：review.reason 列、presign 试听懒加载路由、页面布局/详情模板。

**Tech Stack:** Fastify + eta SSR + htmx（无前端构建链，M2b B2）；vitest + pg-mem（ContentDb port `{query(text, params)}`）；drizzle-kit 生成 migration；@aws-sdk/s3-request-presigner（presign 离线签名，测试不需要网络）。

**Spec:** `docs/superpowers/specs/2026-08-04-content-review-ui-evolution-design.md`（commit `e68bc7e`，老林批准）

## Global Constraints

- 机制零重写：`transition()` 状态机与 audit emit（provision/revoke）语义不动，仅扩 reason 参数与合法性校验。
- 不触 frozen 契约：content-request-envelope / content-contract / ops-event / ops-config schema 与 device-hub contract.h 一律不碰。
- `src/index.ts` 的 content_request 五 kind route 零改动；`/content_policy/push` 通道零改动。
- 认证维持 M2b B3：静态 dev token（`CONTENT_BACKEND_ADMIN_TOKEN/OPERATOR_TOKEN`）+ 内存 session，不升级。
- ingest 登记路由（`POST /admin/ingest`）保持 `requireRole("admin")`，本次不动。
- reason 长度上限 1000 字符。
- 模板落 `src/admin/templates/*.eta`（views.ts readFileSync 自包含加载，M2b C2 模式）。
- TDD：每个 task 先写失败测试并 watch-fail，再实现。
- commit 前缀英文 conventional + 冒号后中文描述。
- 测试运行命令：`pnpm test`（vitest run）；构建：`pnpm build`（tsc）。

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/db/schema.ts` | 改 | review 表加 reason 列定义 |
| `src/db/migrations/0003_*.sql` | 新建（drizzle-kit 生成） | review 表加 reason 列 DDL |
| `src/review/state-machine.ts` | 改 | transition +reason 参数 + 合法转换矩阵校验 |
| `src/admin/ingest.ts` | 改 | ingestTransitionAndAudit 透传 reason |
| `src/ops-app.ts` | 改 | 操作门放宽 operator / reason 解析 / 409/400 映射 / 试听路由 / 队列与详情 handler 升级 / opts 加 s3Client |
| `src/admin/views.ts` | 改 | 新渲染函数（页面壳/队列/详情/试听 partial）；删废弃的 renderIngestDetail/renderIngestRow |
| `src/admin/templates/queue.eta` | 新建 | 待审队列页（布局+导航+表格+空态） |
| `src/admin/templates/detail.eta` | 新建 | 审核详情页（元数据+试听区+历史+操作区） |
| `src/admin/templates/audio.eta` | 新建 | 试听 partial（audio 播放器 / 提示两态） |
| `src/admin/templates/tracks.eta` | 改 | 套统一布局导航 |
| `src/admin/templates/ingest-detail.eta` | 删 | 被 queue/detail 取代（Task 6 删除） |
| `test/integration/helpers.ts` | 改 | REVIEW_DDL 加 reason 列 |
| `test/unit/review-state.test.ts` | 改 | DDL 加 reason + reason/合法性测试 |
| `test/integration/admin-ui.e2e.test.ts` | 改 | operator 门/reason/409/400/试听/页面渲染测试 |
| `test/integration/review-ui-acceptance.e2e.test.ts` | 新建 | 验收全链路 e2e |
| `README.md` | 改 | 审核 UI 使用说明节 |

---

### Task 1: review.reason 列 + transition reason 透传

**Files:**
- Modify: `src/db/schema.ts`（review 表，行 19-27）
- Create: `src/db/migrations/0003_*.sql`（`pnpm db:generate` 生成）
- Modify: `src/review/state-machine.ts:55-72`
- Modify: `src/admin/ingest.ts:53-71`
- Modify: `test/integration/helpers.ts:63-69`（REVIEW_DDL）
- Test: `test/unit/review-state.test.ts`（REVIEW_DDL + 新用例）

**Interfaces:**
- Produces: `transition(db, ingestId, action, actor, reason?)`；`ingestTransitionAndAudit(db, auditSink, ingestId, action, actor, reason?)`；review 表可空列 `reason text`

- [ ] **Step 1: 写失败测试**

`test/unit/review-state.test.ts` 中 `REVIEW_DDL` 改为：

```ts
const REVIEW_DDL = `CREATE TABLE review (
  id text PRIMARY KEY,
  ingest_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  reason text,
  at timestamp NOT NULL DEFAULT now()
)`;
```

describe 块内追加两个用例：

```ts
it("transition with reason records it on review row", async () => {
  const db = setup();
  await seedIngest(db, {
    id: "i1",
    trackId: "self:t1",
    source: "self_hosted",
    rawMetadata: META,
    audioObjectKey: "obj/key",
    state: "pending",
  });
  await transition(db, "i1", "reject", "user:admin", "license unclear");
  const { rows } = await db.query(
    "SELECT reason FROM review WHERE ingest_id = 'i1'",
  );
  expect(rows[0].reason).toBe("license unclear");
});

it("transition without reason stores NULL", async () => {
  const db = setup();
  await seedIngest(db, {
    id: "i1",
    trackId: "self:t1",
    source: "self_hosted",
    rawMetadata: META,
    audioObjectKey: "obj/key",
    state: "pending",
  });
  await transition(db, "i1", "approve", "user:admin");
  const { rows } = await db.query(
    "SELECT reason FROM review WHERE ingest_id = 'i1'",
  );
  expect(rows[0].reason).toBeNull();
});
```

同步更新 `test/integration/helpers.ts` 的 `REVIEW_DDL`（加 `reason text,` 行，与上面一致）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/review-state.test.ts`
Expected: 新用例 FAIL（pg-mem 报 column "reason" does not exist 或 INSERT 参数数不匹配）；既有用例 PASS。

- [ ] **Step 3: 实现 schema + 状态机 + ingest 透传**

`src/db/schema.ts` review 表定义内、`at` 行之前加一行：

```ts
  reason: text("reason"),
```

`src/review/state-machine.ts` transition 签名与 INSERT 改为：

```ts
export async function transition(
  db: ContentDb,
  ingestId: string,
  action: ReviewAction,
  actor: string,
  reason?: string,
): Promise<void> {
  const i = await fetchIngest(db, ingestId);
  if (!i) throw new Error("NOT_FOUND");

  const next = NEXT_STATE[action];

  await db.query("UPDATE ingest SET state = $1 WHERE id = $2", [next, ingestId]);

  const reviewId = `r${Date.now()}`;
  await db.query(
    "INSERT INTO review (id, ingest_id, actor, action, reason) VALUES ($1,$2,$3,$4,$5)",
    [reviewId, ingestId, actor, action, reason ?? null],
  );
```

（函数其余部分不动。）

`src/admin/ingest.ts` ingestTransitionAndAudit 签名与调用改为：

```ts
export async function ingestTransitionAndAudit(
  db: ContentDb,
  auditSink: AuditSink | undefined, // I2 fix: pass-through undefined（emit 函数已 guard）
  ingestId: string,
  action: "approve" | "reject" | "revoke",
  actor: string,
  reason?: string,
): Promise<{ trackId: string | null }> {
  // 先取 trackId 再 transition（target 非空，fold eng I1）
  const trackId = await fetchIngestTrackId(db, ingestId);
  await transition(db, ingestId, action, actor, reason);
```

（audit emit 部分不动。）

- [ ] **Step 4: 生成 migration**

Run: `pnpm db:generate`
Expected: `src/db/migrations/0003_<name>.sql` 生成，内容含 `ALTER TABLE "review" ADD COLUMN "reason" text;`；`src/db/migrations/meta/_journal.json` 新增 idx 3 条目；`meta/0003_snapshot.json` 生成。

若 db:generate 失败：手写 `src/db/migrations/0003_review_reason.sql` 内容 `ALTER TABLE "review" ADD COLUMN "reason" text;`，并在 `_journal.json` entries 末尾追加 `{"idx": 3, "version": "7", "when": <当前毫秒时间戳>, "tag": "0003_review_reason", "breakpoints": true}`，同时报告主窗口（drizzle-kit 环境问题需记录）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run test/unit/review-state.test.ts`
Expected: 全 PASS（含 2 个新用例）。

Run: `pnpm test`
Expected: 全量零回归。

Run: `pnpm build`
Expected: tsc exit 0。

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations/ src/review/state-machine.ts src/admin/ingest.ts test/integration/helpers.ts test/unit/review-state.test.ts
git commit -m "feat(content-backend): review 表加 reason 列与 transition 透传"
```

---

### Task 2: 状态机 transition 合法性校验

**Files:**
- Modify: `src/review/state-machine.ts`
- Test: `test/unit/review-state.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `transition(db, ingestId, action, actor, reason?)`
- Produces: 非法转换抛 `new Error("INVALID_TRANSITION")`（HTTP 层 Task 3 映射 409）

- [ ] **Step 1: 写失败测试**

`test/unit/review-state.test.ts` describe 块内追加：

```ts
it("approve on rejected ingest throws INVALID_TRANSITION", async () => {
  const db = setup();
  await seedIngest(db, {
    id: "i1",
    trackId: "self:t1",
    source: "self_hosted",
    rawMetadata: "{}",
    state: "rejected",
  });
  await expect(
    transition(db, "i1", "approve", "user:admin"),
  ).rejects.toThrow("INVALID_TRANSITION");
  expect(await ingestState(db, "i1")).toBe("rejected");
});

it("revoke on pending ingest throws INVALID_TRANSITION", async () => {
  const db = setup();
  await seedIngest(db, {
    id: "i1",
    trackId: "self:t1",
    source: "self_hosted",
    rawMetadata: "{}",
    state: "pending",
  });
  await expect(
    transition(db, "i1", "revoke", "user:admin"),
  ).rejects.toThrow("INVALID_TRANSITION");
});

it("resubmit on approved ingest throws INVALID_TRANSITION", async () => {
  const db = setup();
  await seedIngest(db, {
    id: "i1",
    trackId: "self:t1",
    source: "self_hosted",
    rawMetadata: "{}",
    state: "approved",
  });
  await expect(
    transition(db, "i1", "resubmit", "user:op"),
  ).rejects.toThrow("INVALID_TRANSITION");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/review-state.test.ts`
Expected: 3 个新用例 FAIL（当前状态机无校验，转换静默成功）。

- [ ] **Step 3: 实现合法转换矩阵**

`src/review/state-machine.ts` 在 `NEXT_STATE` 之后加：

```ts
// 合法转换矩阵（spec §3.5 防御层；UI 按钮显隐是第一层）
const ALLOWED: Record<string, ReviewAction[]> = {
  pending: ["approve", "reject"],
  approved: ["revoke"],
  rejected: ["resubmit"],
  revoked: ["resubmit"],
};
```

transition 内 `if (!i) throw new Error("NOT_FOUND");` 之后加：

```ts
  if (!ALLOWED[i.state]?.includes(action)) {
    throw new Error("INVALID_TRANSITION");
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/review-state.test.ts`
Expected: 全 PASS（既有 3 用例的种子状态均与矩阵兼容：pending→approve / approved→revoke / rejected→resubmit）。

Run: `pnpm test`
Expected: 全量零回归（admin-ui.e2e 的 approve/reject 都是 pending 起步，兼容）。

- [ ] **Step 5: Commit**

```bash
git add src/review/state-machine.ts test/unit/review-state.test.ts
git commit -m "feat(content-backend): 状态机 transition 合法性校验"
```

---

### Task 3: ops 路由接线——operator 门放宽 + reason + 409/400

**Files:**
- Modify: `src/ops-app.ts:350-392`（transitionRoute）
- Test: `test/integration/admin-ui.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 `ingestTransitionAndAudit(..., reason?)`；Task 2 `INVALID_TRANSITION` 错误
- Produces: `POST /admin/ingest/:id/{action}` 接受 form 字段 `reason`（可选，≤1000 字符）；409 `errBody("INVALID_TRANSITION", ...)`；400 `errBody("REASON_TOO_LONG", ...)`；operator 角色可操作

- [ ] **Step 1: 写失败测试**

`test/integration/admin-ui.e2e.test.ts` describe 块内追加四个用例：

```ts
it("operator 可 approve（门放宽 admin→operator）→ 200", async () => {
  const adminCookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-op", raw_metadata: GOOD, audioObjectKey: "k-op" },
    headers: { cookie: adminCookie },
  });
  const opCookie = await login("dev-op");
  const r = await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/approve`,
    headers: { cookie: opCookie },
  });
  expect(r.statusCode).toBe(200);
});

it("reject 带 reason → review.reason 落库", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-reason", raw_metadata: GOOD },
    headers: { cookie },
  });
  const r = await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/reject`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: `reason=${encodeURIComponent("license unclear")}`,
  });
  expect(r.statusCode).toBe(200);
  const { rows } = await db.query(
    "SELECT reason FROM review WHERE ingest_id = $1",
    [ing.json().id],
  );
  expect(rows[rows.length - 1].reason).toBe("license unclear");
});

it("已 rejected 再 approve → 409 INVALID_TRANSITION", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-409", raw_metadata: GOOD },
    headers: { cookie },
  });
  await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/reject`,
    headers: { cookie },
  });
  const r = await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/approve`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().error_code).toBe("INVALID_TRANSITION");
});

it("reason 超 1000 字符 → 400 REASON_TOO_LONG", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-long", raw_metadata: GOOD },
    headers: { cookie },
  });
  const r = await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/reject`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: `reason=${"x".repeat(1001)}`,
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().error_code).toBe("REASON_TOO_LONG");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: "operator 可 approve" FAIL（403）；"409" FAIL（200 静默转换或 500）；reason 两用例 FAIL（reason 未落库/未校验）。

- [ ] **Step 3: 实现 transitionRoute 改造**

`src/ops-app.ts` 将 `transitionRoute` 整段替换为：

```ts
    // approve/reject/revoke：operator 门放宽（spec D5：admin+operator 可审）；
    // reason 可选（≤1000 字符）；INVALID_TRANSITION→409（spec §3.5 防御层 HTTP 映射）。
    const transitionRoute = (action: "approve" | "reject" | "revoke") =>
      app.post(
        `/admin/ingest/:id/${action}`,
        { preHandler: requireRole("operator") },
        async (req, reply) => {
          const ingestId = (req.params as any).id;
          const reasonRaw = (req.body as any)?.reason;
          const reason =
            typeof reasonRaw === "string" && reasonRaw.length > 0
              ? reasonRaw
              : undefined;
          if (reason && reason.length > 1000) {
            return reply
              .code(400)
              .send(errBody("REASON_TOO_LONG", "reason exceeds 1000 chars"));
          }
          // transition 内 ingestId 不存在抛 NOT_FOUND；非法状态转换抛
          // INVALID_TRANSITION（state-machine.ts），分别转 404/409。
          let trackId: string | null;
          try {
            ({ trackId } = await ingestTransitionAndAudit(
              opts.db,
              opts.auditSink,
              ingestId,
              action,
              (req as any).user.name,
              reason,
            ));
          } catch (e: any) {
            if (e?.message === "NOT_FOUND") {
              return reply
                .code(404)
                .send(errBody("NOT_FOUND", "ingest not found"));
            }
            if (e?.message === "INVALID_TRANSITION") {
              return reply
                .code(409)
                .send(
                  errBody("INVALID_TRANSITION", "action not allowed in current state"),
                );
            }
            throw e;
          }
          const state =
            action === "approve"
              ? "approved"
              : action === "reject"
                ? "rejected"
                : "revoked";
          return reply.type("text/html").send(
            renderIngestDetail({
              id: ingestId,
              track_id: trackId ?? "",
              state,
            }),
          );
        },
      );
    transitionRoute("approve");
    transitionRoute("reject");
    transitionRoute("revoke");
```

（本 task 暂保留 renderIngestDetail 响应壳，Task 6 换成完整详情页。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 全 PASS（既有用例不回归："operator 不能 ingest → 403" 仍 PASS——ingest 门不动）。

Run: `pnpm test`
Expected: 全量零回归。

- [ ] **Step 5: Commit**

```bash
git add src/ops-app.ts test/integration/admin-ui.e2e.test.ts
git commit -m "feat(content-backend): 审核操作门放宽 operator + reason/409/400 路由接线"
```

---

### Task 4: 试听 presign 懒加载路由

**Files:**
- Modify: `src/ops-app.ts`（BuildOpsAppOpts + imports + 新路由）
- Modify: `src/admin/views.ts`（renderAudio）
- Create: `src/admin/templates/audio.eta`
- Test: `test/integration/admin-ui.e2e.test.ts`

**Interfaces:**
- Consumes: `presignUrl(client, bucket, key)` from `src/storage/presign.ts`；`createS3(endpoint, region, accessKeyId, secretAccessKey)` from `src/storage/s3-client.ts`
- Produces: `GET /admin/ingest/:id/audio`（requireRole("operator")）返回 HTML partial：有音频=`<audio controls src="<presigned>">`；无音频/未配置/失败=提示文案；`BuildOpsAppOpts` 新增可选 `s3Client?: S3Client`、`s3Bucket?: string`

- [ ] **Step 1: 写失败测试**

`test/integration/admin-ui.e2e.test.ts` 顶部 import 加：

```ts
import { createS3 } from "../../src/storage/s3-client.js";
```

beforeAll 中 buildOpsApp 参数加两个字段：

```ts
  app = await buildOpsApp({
    db,
    auditSink: createAuditSink(auditPath),
    adminToken: "dev-admin",
    operatorToken: "dev-op",
    s3Client: createS3("http://localhost:9999", "us-east-1", "test", "test"),
    s3Bucket: "test-bucket",
  });
```

（presign 是离线签名，不发起网络请求，localhost:9999 无需真实存在。）

describe 块内追加：

```ts
it("试听路由：有音频 → <audio> + presigned URL", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-audio", raw_metadata: GOOD, audioObjectKey: "audio/k1" },
    headers: { cookie },
  });
  const r = await app.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}/audio`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("<audio");
  expect(r.body).toContain("X-Amz-Signature");
});

it("试听路由：无音频 → 提示仅元数据审核", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-noaudio", raw_metadata: GOOD },
    headers: { cookie },
  });
  const r = await app.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}/audio`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("无音频");
});

it("试听路由：未登录 → 401；不存在 → 404", async () => {
  const r1 = await app.inject({ method: "GET", url: "/admin/ingest/i-x/audio" });
  expect(r1.statusCode).toBe(401);
  const cookie = await login("dev-op");
  const r2 = await app.inject({
    method: "GET",
    url: "/admin/ingest/ing_nonexistent_audio/audio",
    headers: { cookie },
  });
  expect(r2.statusCode).toBe(404);
});

it("试听路由：s3 未配置 → 提示未配置（不阻塞审核）", async () => {
  const app2 = await buildOpsApp({
    db,
    adminToken: "dev-admin",
    operatorToken: "dev-op",
  });
  const r = await app2.inject({
    method: "POST",
    url: "/admin/login",
    payload: { token: "dev-admin" },
  });
  const cookie = Array.isArray(r.headers["set-cookie"])
    ? r.headers["set-cookie"][0]
    : r.headers["set-cookie"];
  const ing = await app2.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-nos3", raw_metadata: GOOD, audioObjectKey: "audio/k9" },
    headers: { cookie },
  });
  const a = await app2.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}/audio`,
    headers: { cookie },
  });
  expect(a.statusCode).toBe(200);
  expect(a.body).toContain("试听未配置");
  await app2.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 4 个新用例 FAIL（路由不存在 → 404）。

- [ ] **Step 3: 实现**

`src/admin/templates/audio.eta` 新建：

```eta
<% if (it.url) { %>
<audio controls src="<%= it.url %>"></audio>
<% } else { %>
<div class="audio-notice"><%= it.notice %></div>
<% } %>
```

`src/admin/views.ts`：TEMPLATES 记录加一行：

```ts
  audio: readFileSync("src/admin/templates/audio.eta", "utf8"),
```

文件末尾加渲染函数：

```ts
// 试听 partial：有 url 出播放器，否则出提示（无音频/未配置/取失败）
export const renderAudio = (data: { url?: string; notice?: string }) =>
  render("audio", data);
```

`src/ops-app.ts`：imports 区加：

```ts
import type { S3Client } from "@aws-sdk/client-s3";
import { presignUrl } from "./storage/presign.js";
import {
  renderLogin,
  renderTracksList,
  renderIngestDetail,
  renderIngestForm,
  renderAudio,
} from "./admin/views.js";
```

（原 views import 块替换为上面这段。）

`BuildOpsAppOpts` 加两个可选字段：

```ts
  s3Client?: S3Client; // 试听 presign 用（未配置则试听区显示提示，不阻塞审核）
  s3Bucket?: string;
```

GET routes 区（`/admin/tracks` 之后、POST routes 之前）加：

```ts
    // 试听懒加载：presign 有过期时间，现取现用（spec §3.2）
    app.get(
      "/admin/ingest/:id/audio",
      { preHandler: requireRole("operator") },
      async (req, reply) => {
        const { rows } = await opts.db.query(
          "SELECT audio_object_key FROM ingest WHERE id=$1",
          [(req.params as any).id],
        );
        if (!rows[0]) {
          return reply
            .code(404)
            .send(errBody("NOT_FOUND", "ingest not found"));
        }
        const key =
          rows[0].audio_object_key == null
            ? null
            : String(rows[0].audio_object_key);
        if (!key) {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "无音频，仅元数据审核" }));
        }
        if (!opts.s3Client || !opts.s3Bucket) {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "试听未配置（S3 缺失）" }));
        }
        try {
          const { url } = await presignUrl(opts.s3Client, opts.s3Bucket, key);
          return reply.type("text/html").send(renderAudio({ url }));
        } catch {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "试听获取失败，可继续审核" }));
        }
      },
    );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 全 PASS。

Run: `pnpm test && pnpm build`
Expected: 全量零回归 + tsc exit 0。

- [ ] **Step 5: Commit**

```bash
git add src/ops-app.ts src/admin/views.ts src/admin/templates/audio.eta test/integration/admin-ui.e2e.test.ts
git commit -m "feat(content-backend): 审核详情试听 presign 懒加载路由"
```

---

### Task 5: 布局导航 + 队列页 + tracks 页升级

**Files:**
- Modify: `src/admin/views.ts`（页面壳 + renderQueuePage + renderTracksPage）
- Create: `src/admin/templates/queue.eta`
- Modify: `src/admin/templates/tracks.eta`
- Modify: `src/ops-app.ts`（`/admin/ingests` handler）
- Test: `test/integration/admin-ui.e2e.test.ts`

**Interfaces:**
- Consumes: Task 4 后的 views.ts 渲染体系
- Produces: `renderQueuePage(items: {id, track_id, created_at}[])`（完整 HTML 页，含导航/空态）；导航文案固定「待审核」「已发布曲目」

- [ ] **Step 1: 写失败测试**

`test/integration/admin-ui.e2e.test.ts` describe 块内追加：

```ts
it("队列页含布局导航/条目链接/空态", async () => {
  const cookie = await login("dev-admin");
  const r = await app.inject({
    method: "GET",
    url: "/admin/ingests",
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("待审核");
  expect(r.body).toContain("已发布曲目");
  expect(r.body).toContain("/admin/ingest/"); // 条目链接进详情页
});

it("队列页空态（无 pending）", async () => {
  const emptyApp = await buildOpsApp({
    db: createTestDb(),
    adminToken: "dev-admin",
    operatorToken: "dev-op",
  });
  const lr = await emptyApp.inject({
    method: "POST",
    url: "/admin/login",
    payload: { token: "dev-admin" },
  });
  const cookie = Array.isArray(lr.headers["set-cookie"])
    ? lr.headers["set-cookie"][0]
    : lr.headers["set-cookie"];
  const r = await emptyApp.inject({
    method: "GET",
    url: "/admin/ingests",
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("无待审核 ingest");
  await emptyApp.close();
});

it("tracks 页含布局导航", async () => {
  const cookie = await login("dev-admin");
  const r = await app.inject({
    method: "GET",
    url: "/admin/tracks",
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("待审核");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 新用例 FAIL（无导航文案/无空态）。

- [ ] **Step 3: 实现**

`src/admin/templates/queue.eta` 新建：

```eta
<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script></head><body>
<nav><a href="/admin/ingests">待审核</a> | <a href="/admin/tracks">已发布曲目</a></nav>
<h1>待审核 ingest</h1>
<% if (it.items.length === 0) { %>
<p>无待审核 ingest</p>
<% } else { %>
<table>
<tr><th>track_id</th><th>提交时间</th><th>状态</th></tr>
<% it.items.forEach(i => { %>
<tr>
<td><a href="/admin/ingest/<%= i.id %>"><%= i.track_id %></a></td>
<td><%= i.created_at %></td>
<td><%= i.state %></td>
</tr>
<% }) %>
</table>
<% } %>
</body></html>
```

`src/admin/templates/tracks.eta` 替换为（自刷新用 hx-select 只取表格 div，避免整页嵌套 nav）：

```eta
<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script></head><body>
<nav><a href="/admin/ingests">待审核</a> | <a href="/admin/tracks">已发布曲目</a></nav>
<h1>已发布 tracks</h1>
<div id="tracks-table" hx-get="/admin/tracks" hx-trigger="every 10s" hx-swap="innerHTML" hx-select="#tracks-table">
<table><tr><th>track_id</th><th>title</th><th>artist</th></tr>
<% it.tracks.forEach(t => { %><tr><td><%= t.track_id %></td><td><%= t.title %></td><td><%= t.artist %></td></tr><% }) %>
</table></div></body></html>
```

`src/admin/views.ts` TEMPLATES 加：

```ts
  queue: readFileSync("src/admin/templates/queue.eta", "utf8"),
```

渲染函数加：

```ts
export const renderQueuePage = (
  items: { id: string; track_id: string; state: string; created_at: string }[],
) => render("queue", { items });
```

`src/ops-app.ts` `/admin/ingests` handler 替换为：

```ts
    app.get(
      "/admin/ingests",
      { preHandler: requireRole("operator") },
      async (_req, reply) => {
        const { rows } = await opts.db.query(
          "SELECT id, track_id, state, created_at FROM ingest WHERE state='pending' ORDER BY created_at",
        );
        const items = rows.map((r: any) => ({
          id: String(r.id),
          track_id: String(r.track_id),
          state: String(r.state),
          created_at: String(r.created_at ?? ""),
        }));
        return reply.type("text/html").send(renderQueuePage(items));
      },
    );
```

imports 区 views 导入加 `renderQueuePage`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 全 PASS（既有"GET /admin/ingests 渲染 pending queue"用例断言 body 含 "htmx"——新页面含 htmx script，兼容）。

Run: `pnpm test`
Expected: 全量零回归。

- [ ] **Step 5: Commit**

```bash
git add src/admin/views.ts src/admin/templates/queue.eta src/admin/templates/tracks.eta src/ops-app.ts test/integration/admin-ui.e2e.test.ts
git commit -m "feat(content-backend): 审核 UI 布局导航与队列页升级"
```

---

### Task 6: 详情页升级（元数据/试听区/历史/操作区）+ 废弃旧行模板

**Files:**
- Create: `src/admin/templates/detail.eta`
- Delete: `src/admin/templates/ingest-detail.eta`
- Modify: `src/admin/views.ts`（renderDetailPage；删 renderIngestDetail/renderIngestRow）
- Modify: `src/ops-app.ts`（`/admin/ingest/:id` handler + transitionRoute 响应换完整详情页）
- Test: `test/integration/admin-ui.e2e.test.ts`

**Interfaces:**
- Consumes: Task 4 试听路由（详情页 hx-get 懒加载）；Task 1 review.reason；Task 3 操作路由（form 提交 reason）
- Produces: `renderDetailPage(data: {ingest: {id, track_id, state, created_at, meta: Record<string, unknown>, hasAudio: boolean}, history: {actor, action, reason, at}[]})`；操作响应返回完整详情页 HTML；状态文案沿用「已审核」「已拒」，revoked 用「已下架」

- [ ] **Step 1: 写失败测试**

`test/integration/admin-ui.e2e.test.ts` describe 块内追加：

```ts
const FULL_META = {
  title: "Full",
  artist: "Meta",
  album: "Al",
  durationMs: 3000,
  coverUrl: "http://cover/x.png",
  format: "mp3",
  bitrate: 320000,
  isrc: "USRC17607839",
  license: "CC-BY",
  regionPolicy: "cn",
};

it("详情页渲染全元数据 + 试听懒加载区 + reason 输入", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-detail", raw_metadata: FULL_META, audioObjectKey: "audio/kd" },
    headers: { cookie },
  });
  const r = await app.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("Full");
  expect(r.body).toContain("CC-BY");
  expect(r.body).toContain("USRC17607839");
  expect(r.body).toContain(`hx-get="/admin/ingest/${ing.json().id}/audio"`);
  expect(r.body).toContain("textarea");
  expect(r.body).toContain("approve");
  expect(r.body).toContain("reject");
});

it("详情页 approved 状态显示 revoke、隐藏 approve", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-app", raw_metadata: GOOD },
    headers: { cookie },
  });
  await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/approve`,
    headers: { cookie },
  });
  const r = await app.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}`,
    headers: { cookie },
  });
  expect(r.body).toContain("revoke");
  expect(r.body).not.toContain(">approve<");
  expect(r.body).toContain("已审核");
});

it("详情页审核历史含 actor/action/reason", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-hist", raw_metadata: GOOD },
    headers: { cookie },
  });
  await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/reject`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: `reason=${encodeURIComponent("history check")}`,
  });
  const r = await app.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}`,
    headers: { cookie },
  });
  expect(r.body).toContain("reject");
  expect(r.body).toContain("history check");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 新用例 FAIL（详情页当前是行 partial，无元数据/试听区/历史）。

- [ ] **Step 3: 实现**

`src/admin/templates/detail.eta` 新建：

```eta
<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script></head><body>
<nav><a href="/admin/ingests">待审核</a> | <a href="/admin/tracks">已发布曲目</a></nav>
<h1>审核详情 <%= it.ingest.track_id %></h1>
<div id="detail-main">
<p>状态：<%= it.ingest.state === 'approved' ? '已审核' : it.ingest.state === 'rejected' ? '已拒' : it.ingest.state === 'revoked' ? '已下架' : 'pending' %></p>
<h2>元数据</h2>
<table>
<% for (const k of ["title","artist","album","durationMs","coverUrl","format","bitrate","isrc","license","regionPolicy"]) { %>
<tr><th><%= k %></th><td><%= it.ingest.meta[k] != null ? it.ingest.meta[k] : '未提供' %></td></tr>
<% } %>
</table>
<h2>试听</h2>
<div hx-get="/admin/ingest/<%= it.ingest.id %>/audio" hx-trigger="load" hx-swap="innerHTML">试听加载中…</div>
<h2>审核历史</h2>
<% if (it.history.length === 0) { %>
<p>暂无审核记录</p>
<% } else { %>
<table>
<tr><th>时间</th><th>操作人</th><th>动作</th><th>理由</th></tr>
<% it.history.forEach(h => { %>
<tr><td><%= h.at %></td><td><%= h.actor %></td><td><%= h.action %></td><td><%= h.reason != null ? h.reason : '' %></td></tr>
<% }) %>
</table>
<% } %>
<h2>操作</h2>
<% if (it.ingest.state === 'pending') { %>
<button hx-post="/admin/ingest/<%= it.ingest.id %>/approve" hx-target="body" hx-swap="innerHTML">approve</button>
<form hx-post="/admin/ingest/<%= it.ingest.id %>/reject" hx-target="body" hx-swap="innerHTML">
<textarea name="reason" maxlength="1000" placeholder="拒绝理由（可选）"></textarea>
<button type="submit">reject</button>
</form>
<% } else if (it.ingest.state === 'approved') { %>
<form hx-post="/admin/ingest/<%= it.ingest.id %>/revoke" hx-target="body" hx-swap="innerHTML">
<textarea name="reason" maxlength="1000" placeholder="下架理由（可选）"></textarea>
<button type="submit">revoke</button>
</form>
<% } else { %>
<p>当前状态无可用操作</p>
<% } %>
</div>
</body></html>
```

`src/admin/views.ts`：TEMPLATES 加：

```ts
  detail: readFileSync("src/admin/templates/detail.eta", "utf8"),
```

删除 `renderIngestDetail` 与 `renderIngestRow` 两个导出及 TEMPLATES 中 `"ingest-detail"` 行；加：

```ts
export const renderDetailPage = (data: {
  ingest: {
    id: string;
    track_id: string;
    state: string;
    meta: Record<string, unknown>;
  };
  history: { actor: string; action: string; reason: string | null; at: string }[];
}) => render("detail", data);
```

删除文件 `src/admin/templates/ingest-detail.eta`。

`src/ops-app.ts`：views 导入改为：

```ts
import {
  renderLogin,
  renderTracksList,
  renderIngestForm,
  renderAudio,
  renderQueuePage,
  renderDetailPage,
} from "./admin/views.js";
```

（移除 renderIngestDetail 导入。）

加一个详情数据组装 helper（放在 buildOpsApp 外、errBody 附近）：

```ts
async function loadDetail(db: ContentDb, ingestId: string) {
  const { rows } = await db.query(
    "SELECT id, track_id, state, raw_metadata, created_at FROM ingest WHERE id=$1",
    [ingestId],
  );
  if (!rows[0]) return null;
  const hist = await db.query(
    "SELECT actor, action, reason, at FROM review WHERE ingest_id=$1 ORDER BY at",
    [ingestId],
  );
  return {
    ingest: {
      id: String(rows[0].id),
      track_id: String(rows[0].track_id),
      state: String(rows[0].state),
      meta: JSON.parse(String(rows[0].raw_metadata)) as Record<string, unknown>,
    },
    history: hist.rows.map((h: any) => ({
      actor: String(h.actor),
      action: String(h.action),
      reason: h.reason == null ? null : String(h.reason),
      at: String(h.at ?? ""),
    })),
  };
}
```

`/admin/ingest/:id` GET handler 替换为：

```ts
    app.get(
      "/admin/ingest/:id",
      { preHandler: requireRole("operator") },
      async (req, reply) => {
        const detail = await loadDetail(opts.db, (req.params as any).id);
        if (!detail) {
          return reply
            .code(404)
            .send({ error_code: "NOT_FOUND", message: "ingest not found" });
        }
        return reply.type("text/html").send(renderDetailPage(detail));
      },
    );
```

transitionRoute 的成功响应段（`const state = ...` 到 `renderIngestDetail(...)` 一段）替换为：

```ts
          const detail = await loadDetail(opts.db, ingestId);
          if (!detail) {
            return reply
              .code(404)
              .send(errBody("NOT_FOUND", "ingest not found"));
          }
          return reply.type("text/html").send(renderDetailPage(detail));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 全 PASS。既有 approve 用例断言 body 含 "已审核"——新详情页状态文案保留该词，兼容。

Run: `pnpm test && pnpm build`
Expected: 全量零回归 + tsc exit 0（renderIngestDetail 引用全部清除）。

- [ ] **Step 5: Commit**

```bash
git add -A src/admin/ src/ops-app.ts test/integration/admin-ui.e2e.test.ts
git commit -m "feat(content-backend): 审核详情页升级（元数据/试听/历史/操作区）"
```

---

### Task 7: sim e2e 验收 + 全量回归 + README

**Files:**
- Create: `test/integration/review-ui-acceptance.e2e.test.ts`
- Modify: `README.md`（审核 UI 使用节）

**Interfaces:**
- Consumes: Task 1-6 全部产物
- Produces: spec §6 验收标准 1/2/3/4/5 的自动化证据（验收标准 6「presign 现取」由 Task 4 测试覆盖）

- [ ] **Step 1: 写验收 e2e（先跑一遍确认除新文件外无失败）**

`test/integration/review-ui-acceptance.e2e.test.ts` 新建：

```ts
// review-ui-acceptance.e2e.test.ts — spec §6 验收全链路：
// ingest → 队列可见 → 详情试听 → approve → tracks 可见 → revoke → tracks 消失。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { createTestDb } from "./helpers.js";
import { createS3 } from "../../src/storage/s3-client.js";
import { createAuditSink } from "../../src/audit/audit-sink.js";
import { rmSync, readFileSync } from "node:fs";

let app: any, db: any;
const auditPath = ".tmp-audit-acceptance.jsonl";

beforeAll(async () => {
  db = createTestDb();
  app = await buildOpsApp({
    db,
    auditSink: createAuditSink(auditPath),
    adminToken: "dev-admin",
    operatorToken: "dev-op",
    s3Client: createS3("http://localhost:9999", "us-east-1", "test", "test"),
    s3Bucket: "test-bucket",
  });
});

afterAll(async () => {
  await app.close();
  rmSync(auditPath, { force: true });
});

async function login(token: string) {
  const r = await app.inject({ method: "POST", url: "/admin/login", payload: { token } });
  const sc = r.headers["set-cookie"];
  return Array.isArray(sc) ? sc[0] : sc;
}

const META = {
  title: "Acceptance",
  artist: "Song",
  durationMs: 5000,
  format: "mp3",
  bitrate: 192000,
  license: "CC-BY",
};

describe("审核 UI 验收全链路", () => {
  it("ingest → 队列可见 → 详情试听 → operator approve → tracks 可见", async () => {
    const adminCookie = await login("dev-admin");
    const ing = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: "self:acc1", raw_metadata: META, audioObjectKey: "audio/acc1" },
      headers: { cookie: adminCookie },
    });
    const id = ing.json().id;

    const queue = await app.inject({
      method: "GET",
      url: "/admin/ingests",
      headers: { cookie: adminCookie },
    });
    expect(queue.body).toContain("self:acc1");

    const audio = await app.inject({
      method: "GET",
      url: `/admin/ingest/${id}/audio`,
      headers: { cookie: adminCookie },
    });
    expect(audio.body).toContain("<audio");

    const opCookie = await login("dev-op");
    const ap = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/approve`,
      headers: { cookie: opCookie },
    });
    expect(ap.statusCode).toBe(200);
    expect(ap.body).toContain("已审核");

    const tracks = await app.inject({
      method: "GET",
      url: "/admin/tracks",
      headers: { cookie: opCookie },
    });
    expect(tracks.body).toContain("self:acc1");
  });

  it("revoke → tracks 消失 + 审核历史含记录", async () => {
    const opCookie = await login("dev-op");
    const { rows } = await db.query(
      "SELECT id FROM ingest WHERE track_id = 'self:acc1'",
    );
    const id = String(rows[0].id);
    const rv = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/revoke`,
      headers: { cookie: opCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `reason=${encodeURIComponent("acceptance takedown")}`,
    });
    expect(rv.statusCode).toBe(200);

    const tracks = await app.inject({
      method: "GET",
      url: "/admin/tracks",
      headers: { cookie: opCookie },
    });
    expect(tracks.body).not.toContain("self:acc1");

    const detail = await app.inject({
      method: "GET",
      url: `/admin/ingest/${id}`,
      headers: { cookie: opCookie },
    });
    expect(detail.body).toContain("acceptance takedown");
    expect(detail.body).toContain("已下架");
  });

  it("audit JSONL 含 provision/revoke 事件", async () => {
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    expect(events.some((e) => e.eventType === "provision")).toBe(true);
    expect(events.some((e) => e.eventType === "revoke")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑验收测试确认通过**

Run: `pnpm vitest run test/integration/review-ui-acceptance.e2e.test.ts`
Expected: 3/3 PASS。若 FAIL：逐个定位是 Task 1-6 哪个环节回归，修复后重跑（不新增实现，验收只验证既有产物）。

- [ ] **Step 3: 全量回归 + 构建**

Run: `pnpm test`
Expected: 全 PASS，零回归。

Run: `pnpm build`
Expected: tsc exit 0。

- [ ] **Step 4: README 补审核工作台小节**

README.md 已有 `## M2b 审核 UI + content_policy 消费通道` 节（约 line 75 起）。在该节末尾追加子节：

```markdown
### 审核工作台（2026-08-04 演进）

`/admin/*` 已演进为正式内容审核工作台（spec `docs/superpowers/specs/2026-08-04-content-review-ui-evolution-design.md`）：

- 页面：`/admin/ingests`（待审队列，带导航/空态）/ `/admin/ingest/:id`（详情：全元数据/试听/审核历史/操作区）/ `/admin/tracks`（已发布曲目）
- 角色：admin+operator 均可审核（approve/reject/revoke，reject/revoke 可选理由 ≤1000 字符）；ingest 登记仍仅 admin
- 试听：音频存 S3（`audioObjectKey`），详情页懒加载 presign URL（现取现用，受 `S3_*` env 影响）
- 状态机防御：非法状态转换返 409 INVALID_TRANSITION
- sim 边界不变：认证为 sim dev token + 内存 session（B3），生产由 M1c OIDC/idP 替换
```

- [ ] **Step 5: Commit**

```bash
git add test/integration/review-ui-acceptance.e2e.test.ts README.md
git commit -m "test(content-backend): 审核 UI sim e2e 验收与 README 使用说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3.1 页面交互→T5/T6；§3.2 试听→T4；§3.3 角色门→T3；§3.4 reason→T1/T3/T6；§3.5 状态机防御→T2/T3；§3.6 数据流→T1-T6 整体；§4 错误处理表→T2/T3/T4（404/409/400/presign 降级/401/403 既有）；§5 测试矩阵 9 项→T1-T7 逐项对应（1→T5，2→T6，3→T4，4→T3/T7，5→T1/T3/T7，6→T7 audit，7→T3，8→T2/T3，9→T3）；§6 验收标准→T7；§9 known holes 属 spec 标注无需实现。
- **Placeholder scan**：无 TBD/TODO；每步含代码或命令+预期。
- **类型一致性**：`transition(db, ingestId, action, actor, reason?)` 与 `ingestTransitionAndAudit(db, auditSink, ingestId, action, actor, reason?)` 全 plan 一致；`renderDetailPage` 入参形状 T6 定义、T6 内消费一致；`renderAudio({url?|notice?})` T4 一致。
