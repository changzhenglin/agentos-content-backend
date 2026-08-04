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
| `src/ops-app.ts` | 改 | 操作门放宽 operator / reason 解析 / 409/400 映射 / 试听路由（presignFn 注入+CLI 接线）/ 队列与详情 handler 升级 |
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
Expected: 「with reason」用例 FAIL（旧 INSERT 不写 reason 列）；「without reason」用例**此时即 PASS**（新 DDL 列默认 NULL，NULL 路径守护属预期，不是测试写错——fold Eng M3/codex P2-6）；既有用例 PASS。

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

若 db:generate 失败：**停止并报告主窗口**（drizzle-kit 环境问题）。不得手写 migration/journal——手写补 journal 不生成 snapshot 会破坏 drizzle 元数据链完整（后续 generate 报错或重复生成）（fold codex P2-5）。

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

`src/review/state-machine.ts` 顶部 import 加 `import { randomUUID } from "node:crypto";`；`NEXT_STATE` 之后加：

```ts
// 合法转换矩阵（spec §3.5 防御层；UI 按钮显隐是第一层）
const ALLOWED: Record<string, ReviewAction[]> = {
  pending: ["approve", "reject"],
  approved: ["revoke"],
  rejected: ["resubmit"],
  revoked: ["resubmit"],
};
```

transition 内 `if (!i) throw new Error("NOT_FOUND");` 之后加矩阵校验；并把原无条件 UPDATE 改为 **CAS（带旧状态条件）+ RETURNING 所有权判定**，reviewId 改 UUID（fold codex P1-5；fold wave 3：rowCount 契约外→曾改重读比对→重读对同动作并发有伪不变量，终局用 RETURNING，codex r3 P1/Eng NEW-6 双路收敛）：

```ts
  if (!ALLOWED[i.state]?.includes(action)) {
    throw new Error("INVALID_TRANSITION");
  }

  const next = NEXT_STATE[action];

  // CAS：带旧状态条件，并发 approve/reject 只有一个成功（UPDATE 行锁串行化）。
  // RETURNING 证明 UPDATE 所有权：命中方得 rows，miss 方得空数组——
  // 同动作并发下 miss 方重读会看到赢家写入的状态（伪命中），故不可用重读比对。
  // pg-mem 已实证支持 UPDATE...RETURNING（命中 rows=[...]，miss rows=[]）。
  const cas = await db.query(
    "UPDATE ingest SET state = $1 WHERE id = $2 AND state = $3 RETURNING id",
    [next, ingestId, i.state],
  );
  if (cas.rows.length === 0) throw new Error("INVALID_TRANSITION");

  const reviewId = randomUUID();
```

（删除原 `const reviewId = \`r${Date.now()}\`;`——同毫秒可碰撞。）

Step 1 测试块再追加一个 CAS SQL 语义测试（直接验证 RETURNING 命中/未命中行为）：

```ts
it("CAS 语义：RETURNING 命中返行、未命中返空且不改状态（fold wave 3）", async () => {
  const db = setup();
  await seedIngest(db, {
    id: "i1",
    trackId: "self:t1",
    source: "self_hosted",
    rawMetadata: "{}",
    state: "pending",
  });
  // 条件用错误旧状态 → miss → RETURNING 空 rows，状态不变
  const miss = await db.query(
    "UPDATE ingest SET state = $1 WHERE id = $2 AND state = $3 RETURNING id",
    ["approved", "i1", "approved"],
  );
  expect(miss.rows.length).toBe(0);
  expect(await ingestState(db, "i1")).toBe("pending");
  // 正确旧状态 → 命中 → RETURNING 返行（所有权证明）
  const hit = await db.query(
    "UPDATE ingest SET state = $1 WHERE id = $2 AND state = $3 RETURNING id",
    ["approved", "i1", "pending"],
  );
  expect(hit.rows.length).toBe(1);
  expect(await ingestState(db, "i1")).toBe("approved");
});
```

（此用例为 SQL 语义守护：pg-mem 3.0.14 实测支持 UPDATE...RETURNING——主窗口 2026-08-04 已运行时实证。若未来 pg-mem 升级破坏该行为，此测试 RED 即暴露。）

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
- Produces: `POST /admin/ingest/:id/{action}` 接受 form 字段 `reason`（可选，≤1000 字符）；409/400 返自包含 HTML partial（spec §4 定形：400=可重试表单+回填+返回链接，409=当前状态+返回链接；404 保持 JSON errBody=M2b fix #2 先例）；operator 角色可操作

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

it("reject 带 reason → review.reason 落库（真实浏览器 + 编码路径，fold codex P1-6）", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-reason", raw_metadata: GOOD },
    headers: { cookie },
  });
  // URLSearchParams 把空格编码为 +（真实浏览器 form 行为）；
  // 旧解析器只 decodeURIComponent 会落库 "license+unclear"
  const r = await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/reject`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ reason: "license unclear" }).toString(),
  });
  expect(r.statusCode).toBe(200);
  const { rows } = await db.query(
    "SELECT reason FROM review WHERE ingest_id = $1",
    [ing.json().id],
  );
  expect(rows[rows.length - 1].reason).toBe("license unclear");
});

it("已 rejected 再 approve → 409 + HTML partial（htmx 可 swap，fold codex P1-2）", async () => {
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
  expect(r.headers["content-type"]).toContain("text/html");
  expect(r.body).toContain("非法操作");
  expect(r.body).toContain("rejected"); // 当前状态（fold Eng NEW-3）
  expect(r.body).toContain("返回详情");
  expect(r.body).not.toContain("重试"); // 409 状态已变，不提供重试
});

it("reason 超 1000 字符 → 400 + HTML partial 含回填（fold codex P1-2）", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-long", raw_metadata: GOOD },
    headers: { cookie },
  });
  const longReason = "x".repeat(1001);
  const r = await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/reject`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ reason: longReason }).toString(),
  });
  expect(r.statusCode).toBe(400);
  expect(r.headers["content-type"]).toContain("text/html");
  expect(r.body).toContain("reason exceeds 1000 chars");
  expect(r.body).toContain(longReason); // 回填
  // 自包含可重试表单（fold wave 2 codex P1-2/Eng NEW-4）
  expect(r.body).toContain(`hx-post="/admin/ingest/${ing.json().id}/reject"`);
  expect(r.body).toContain("重试");
  expect(r.body).toContain("返回详情");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: "operator 可 approve" FAIL（403）；"409" FAIL（200 静默转换或 500）；reason 两用例 FAIL（reason 未落库/未校验）。

- [ ] **Step 3: 实现 transitionRoute 改造 + 解析器修复 + 错误 partial**

**3a. form-urlencoded 解析器修复**（fold codex P1-6）：`src/ops-app.ts` 的 `addContentTypeParser` 内两行解码改为先 `+`→空格再 decodeURIComponent（form-urlencoded 规范：`+` 表示空格，真实浏览器路径；既有 ingest e2e 用 %20 编码未暴露）：

```ts
        for (const pair of String(body).split("&")) {
          if (!pair) continue;
          const eq = pair.indexOf("=");
          const k = decodeURIComponent(
            (eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " "),
          );
          // 无 = 的参数值保持空串（原行为；fold wave 2 codex P2：
          // 上一版误把值取为参数名本身）
          const v = decodeURIComponent(
            (eq < 0 ? "" : pair.slice(eq + 1)).replace(/\+/g, " "),
          );
          out[k] = v;
        }
```

**3b. 错误 partial 模板（自包含可操作形状，fold wave 2 codex P1-2/Eng NEW-4）**：`src/admin/templates/error.eta` 新建——400 带可重试表单（textarea 回填+重试按钮），409 只带返回链接（状态已变重试无意义），均含返回详情链接：

```eta
<div class="error"><%= it.message %></div>
<% if (it.retryAction) { %>
<form hx-post="<%= it.retryAction %>" hx-target="body" hx-swap="innerHTML">
<textarea name="reason" maxlength="1000"><%= it.reason != null ? it.reason : "" %></textarea>
<button type="submit">重试</button>
</form>
<% } %>
<% if (it.backHref) { %><p><a href="<%= it.backHref %>">返回详情</a></p><% } %>
```

`src/admin/views.ts` TEMPLATES 加 `error: readFileSync("src/admin/templates/error.eta", "utf8"),`，导出：

```ts
// 审核操作错误 partial（400/409，htmx swap 进 body；自包含：
// 400=可重试表单，409=返回链接。eta autoEscape 默认开，reason 回填安全）
export const renderTransitionError = (data: {
  message: string;
  reason?: string;
  retryAction?: string;
  backHref?: string;
}) => render("error", data);
```

**3c. transitionRoute** 整段替换为：

```ts
    // approve/reject/revoke：operator 门放宽（spec D5：admin+operator 可审）；
    // reason 可选（≤1000 字符）；NOT_FOUND→404 JSON（M2b fix #2 先例保持）；
    // INVALID_TRANSITION→409 / REASON_TOO_LONG→400 返 HTML partial
    //（htmx 2.0.4 默认 4xx 不 swap，页面 head responseHandling 配置 T5 加；
    // fold codex P1-2）。
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
              .type("text/html")
              .send(
                renderTransitionError({
                  message: "reason exceeds 1000 chars",
                  reason, // 回填
                  retryAction: `/admin/ingest/${ingestId}/${action}`,
                  backHref: `/admin/ingest/${ingestId}`,
                }),
              );
          }
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
              // 409：带当前状态（spec §4；fold Eng NEW-3），不提供重试（状态已变）
              const cur = await opts.db.query(
                "SELECT state FROM ingest WHERE id=$1",
                [ingestId],
              );
              const curState = cur.rows[0] ? String(cur.rows[0].state) : "unknown";
              return reply
                .code(409)
                .type("text/html")
                .send(
                  renderTransitionError({
                    message: `非法操作：当前状态为 ${curState}，不允许 ${action}`,
                    backHref: `/admin/ingest/${ingestId}`,
                  }),
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

`src/ops-app.ts` views import 块加 `renderTransitionError`。

（本 task 成功路径暂保留 renderIngestDetail 响应壳，Task 6 换成完整详情页。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 全 PASS（既有用例不回归："operator 不能 ingest → 403" 仍 PASS——ingest 门不动）。

Run: `pnpm test`
Expected: 全量零回归。

- [ ] **Step 5: Commit**

```bash
git add src/ops-app.ts src/admin/views.ts src/admin/templates/error.eta test/integration/admin-ui.e2e.test.ts
git commit -m "feat(content-backend): 审核操作门放宽 operator + reason/409/400 路由接线"
```

（git add 清单含本 task 新建的 error.eta 与改动的 views.ts——fold wave 2 codex P1-3：漏 stage 会导致按 plan 提交后运行时 ENOENT。）

---

### Task 4: 试听 presign 懒加载路由

**Files:**
- Modify: `src/ops-app.ts`（BuildOpsAppOpts + imports + 新路由 + **CLI 入口接线**）
- Modify: `src/admin/views.ts`（renderAudio）
- Create: `src/admin/templates/audio.eta`
- Test: `test/integration/admin-ui.e2e.test.ts`

**Interfaces:**
- Consumes: `presignUrl(client, bucket, key)` from `src/storage/presign.ts`；`createS3(endpoint, region, accessKeyId, secretAccessKey)` from `src/storage/s3-client.ts`（仅 CLI 接线用）
- Produces: `GET /admin/ingest/:id/audio`（requireRole("operator")）返回 HTML partial：有音频=`<audio controls src="<presigned>">`；无音频/未配置/失败=提示文案；`BuildOpsAppOpts` 新增可选 `presignFn?: (key: string) => Promise<{ url: string }>`（注入式，对齐 index.ts 既有 PresignFn hexagonal 模式，fold codex P2-2；CLI 默认用 env.s3 构造，fold Eng I1/codex P1-3）

- [ ] **Step 1: 写失败测试**

`test/integration/admin-ui.e2e.test.ts` beforeAll 中 buildOpsApp 参数加一个字段：

```ts
  app = await buildOpsApp({
    db,
    auditSink: createAuditSink(auditPath),
    adminToken: "dev-admin",
    operatorToken: "dev-op",
    presignFn: async (_key: string) => ({
      url: "https://example.test/audio?X-Amz-Signature=abc123",
    }),
  });
```

describe 块内追加：

```ts
it("试听路由：有音频 → <audio> + presigned URL（注入 presignFn）", async () => {
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
  expect(r.body).toContain("X-Amz-Signature=abc123");
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

it("试听路由：presign 失败 → 降级提示不阻塞（catch 分支，fold codex P2-2）", async () => {
  const failApp = await buildOpsApp({
    db,
    adminToken: "dev-admin",
    operatorToken: "dev-op",
    presignFn: async () => {
      throw new Error("s3 down");
    },
  });
  const lr = await failApp.inject({
    method: "POST",
    url: "/admin/login",
    payload: { token: "dev-admin" },
  });
  const cookie = Array.isArray(lr.headers["set-cookie"])
    ? lr.headers["set-cookie"][0]
    : lr.headers["set-cookie"];
  const ing = await failApp.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-s3fail", raw_metadata: GOOD, audioObjectKey: "audio/kf" },
    headers: { cookie },
  });
  const r = await failApp.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}/audio`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("试听获取失败");
  await failApp.close();
});

it("试听路由：未登录 → 401；不存在 → 404；未配置 → 提示", async () => {
  const r1 = await app.inject({ method: "GET", url: "/admin/ingest/i-x/audio" });
  expect(r1.statusCode).toBe(401);
  const cookie = await login("dev-op");
  const r2 = await app.inject({
    method: "GET",
    url: "/admin/ingest/ing_nonexistent_audio/audio",
    headers: { cookie },
  });
  expect(r2.statusCode).toBe(404);
  const app2 = await buildOpsApp({
    db,
    adminToken: "dev-admin",
    operatorToken: "dev-op",
  });
  const lr = await app2.inject({
    method: "POST",
    url: "/admin/login",
    payload: { token: "dev-admin" },
  });
  const cookie2 = Array.isArray(lr.headers["set-cookie"])
    ? lr.headers["set-cookie"][0]
    : lr.headers["set-cookie"];
  const ing = await app2.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: "self:t-nos3", raw_metadata: GOOD, audioObjectKey: "audio/k9" },
    headers: { cookie: cookie2 },
  });
  const a = await app2.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}/audio`,
    headers: { cookie: cookie2 },
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
import { presignUrl } from "./storage/presign.js";
import { createS3 } from "./storage/s3-client.js";
import {
  renderLogin,
  renderTracksList,
  renderIngestDetail,
  renderIngestForm,
  renderAudio,
  renderTransitionError,
} from "./admin/views.js";
```

（原 views import 块替换为上面这段；renderTransitionError 为 T3 已加项，替换块必须保留——fold wave 2 Eng NEW-2。）

`BuildOpsAppOpts` 加一个可选字段（注入式，对齐 index.ts PresignFn 模式）：

```ts
  presignFn?: (key: string) => Promise<{ url: string }>; // 试听 presign（CLI 默认 env.s3 构造；未配置则试听区显示提示，不阻塞审核）
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
        if (!opts.presignFn) {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "试听未配置" }));
        }
        try {
          const { url } = await opts.presignFn(key);
          return reply.type("text/html").send(renderAudio({ url }));
        } catch {
          return reply
            .type("text/html")
            .send(renderAudio({ notice: "试听获取失败，可继续审核" }));
        }
      },
    );
```

**CLI 接线（fold Eng I1/codex P1-3——缺这步真实启动的 app 试听恒「未配置」）**：文件尾部 CLI 块（`if (import.meta.url === ...)` 段）在 `const app = await buildOpsApp({` 之前加：

```ts
  const s3 = createS3(
    env.s3.endpoint,
    env.s3.region,
    env.s3.accessKeyId,
    env.s3.secretAccessKey,
  );
```

buildOpsApp 调用参数追加：

```ts
    presignFn: (key: string) =>
      presignUrl(s3, env.s3.bucket, key).then((r) => ({ url: r.url })),
```

注：CLI 接线无自动化测试（模块入口，spec known hole 8），T7 记录手动验证项。

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
- Produces: `renderQueuePage(items: {id, track_id, state, title, artist, created_at}[])`（完整 HTML 页，含导航/标题/艺人/徽标/空态）；导航文案固定「待审核」「已发布曲目」

- [ ] **Step 1: 写失败测试**

`test/integration/admin-ui.e2e.test.ts` describe 块内追加：

```ts
it("队列页：自建条目 → 导航/链接/标题/艺人/徽标/空态文案齐（fold Eng I3/codex P1-4/P2-4）", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: {
      track_id: "self:t-queue",
      raw_metadata: { ...GOOD, title: "QueueSong", artist: "QueueArtist" },
    },
    headers: { cookie },
  });
  const r = await app.inject({
    method: "GET",
    url: "/admin/ingests",
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain("待审核");
  expect(r.body).toContain("已发布曲目");
  expect(r.body).toContain(`/admin/ingest/${ing.json().id}`);
  expect(r.body).toContain("QueueSong");
  expect(r.body).toContain("QueueArtist");
  expect(r.body).toContain("responseHandling"); // htmx 4xx swap 配置在 head（fold codex P1-2）
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

`src/admin/templates/queue.eta` 新建（head 含 htmx 4xx swap 配置，fold codex P1-2；标题/艺人列 fold Eng I3/codex P1-4）：

```eta
<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script><script>htmx.config.responseHandling = [{ code: ".*", swap: true }];</script></head><body>
<nav><a href="/admin/ingests">待审核</a> | <a href="/admin/tracks">已发布曲目</a></nav>
<h1>待审核 ingest</h1>
<% if (it.items.length === 0) { %>
<p>无待审核 ingest</p>
<% } else { %>
<table>
<tr><th>track_id</th><th>标题</th><th>艺人</th><th>提交时间</th><th>状态</th></tr>
<% it.items.forEach(i => { %>
<tr>
<td><a href="/admin/ingest/<%= i.id %>"><%= i.track_id %></a></td>
<td><%= i.title %></td>
<td><%= i.artist %></td>
<td><%= i.created_at %></td>
<td><span class="badge badge-<%= i.state %>"><%= i.state %></span></td>
</tr>
<% }) %>
</table>
<% } %>
</body></html>
```

`src/admin/templates/tracks.eta` 替换为（**移除 M2b 遗留 10s 自刷新**——原实现整页响应 swap 进 div 有嵌套/重复 ID bug，审核场景手动刷新足够，fold codex P1-1；head 带 responseHandling 配置）：

```eta
<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script><script>htmx.config.responseHandling = [{ code: ".*", swap: true }];</script></head><body>
<nav><a href="/admin/ingests">待审核</a> | <a href="/admin/tracks">已发布曲目</a></nav>
<h1>已发布 tracks</h1>
<table><tr><th>track_id</th><th>title</th><th>artist</th></tr>
<% it.tracks.forEach(t => { %><tr><td><%= t.track_id %></td><td><%= t.title %></td><td><%= t.artist %></td></tr><% }) %>
</table></body></html>
```

`src/admin/views.ts` TEMPLATES 加：

```ts
  queue: readFileSync("src/admin/templates/queue.eta", "utf8"),
```

渲染函数加：

```ts
export const renderQueuePage = (
  items: {
    id: string;
    track_id: string;
    state: string;
    title: string;
    artist: string;
    created_at: string;
  }[],
) => render("queue", { items });
```

`src/ops-app.ts` `/admin/ingests` handler 替换为（标题/艺人从 raw_metadata 解析 + 显式 LIMIT 100，fold Eng I3/codex P1-4）：

```ts
    app.get(
      "/admin/ingests",
      { preHandler: requireRole("operator") },
      async (_req, reply) => {
        const { rows } = await opts.db.query(
          "SELECT id, track_id, state, raw_metadata, created_at FROM ingest WHERE state='pending' ORDER BY created_at LIMIT 100",
        );
        const items = rows.map((r: any) => {
          let title = "";
          let artist = "";
          try {
            const meta = JSON.parse(String(r.raw_metadata ?? "{}"));
            title = meta.title != null ? String(meta.title) : "";
            artist = meta.artist != null ? String(meta.artist) : "";
          } catch {
            // raw_metadata 异常不阻塞队列渲染
          }
          return {
            id: String(r.id),
            track_id: String(r.track_id),
            state: String(r.state),
            title,
            artist,
            created_at: String(r.created_at ?? ""),
          };
        });
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
- Produces: `renderDetailPage(data: {ingest: {id, track_id, state, meta: Record<string, unknown>}, history: {actor, action, reason, at}[]})`（代码块为准，fold Eng M4 散文同步）；操作响应返回完整详情页 HTML；状态文案沿用「已审核」「已拒」，revoked 用「已下架」

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
  // 详情页是审核操作发生的页面，必须带 4xx swap 配置
  //（fold wave 2 Eng NEW-1/codex P1-1：首轮 fold 漏了此页）
  expect(r.body).toContain("responseHandling");
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
  // 断言 approve 按钮不存在（历史区 <td>approve</td> 含 ">approve<" 子串，
  // 不能拿它断言按钮隐藏——fold Eng I2）
  expect(r.body).not.toContain(`hx-post="/admin/ingest/${ing.json().id}/approve"`);
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
    payload: new URLSearchParams({ reason: "history check" }).toString(),
  });
  const r = await app.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}`,
    headers: { cookie },
  });
  expect(r.body).toContain("reject");
  expect(r.body).toContain("history check");
});

it("reason/元数据 XSS：eta autoEscape 回归（fold codex P2-7）", async () => {
  const cookie = await login("dev-admin");
  const ing = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: {
      track_id: "self:t-xss",
      raw_metadata: { ...GOOD, title: '<img src=x onerror=alert(1)>' },
    },
    headers: { cookie },
  });
  await app.inject({
    method: "POST",
    url: `/admin/ingest/${ing.json().id}/reject`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    // 覆盖 < > " & 四类字符（fold wave 2 codex P2：首轮只锁 < >）
    payload: new URLSearchParams({ reason: '"><script>alert(1)</script> & "quoted"' }).toString(),
  });
  const r = await app.inject({
    method: "GET",
    url: `/admin/ingest/${ing.json().id}`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain("<script>alert(1)</script>");
  expect(r.body).not.toContain("<img src=x");
  expect(r.body).toContain("&lt;script&gt;"); // eta 4.x autoEscape 默认开，锁定防回归
  expect(r.body).toContain("&lt;img");
  expect(r.body).toContain("&amp;"); // & 转义锁定
  expect(r.body).toContain("&quot;"); // 引号转义锁定
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/admin-ui.e2e.test.ts`
Expected: 新用例 FAIL（详情页当前是行 partial，无元数据/试听区/历史）。

- [ ] **Step 3: 实现**

`src/admin/templates/detail.eta` 新建：

```eta
<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script><script>htmx.config.responseHandling = [{ code: ".*", swap: true }];</script></head><body>
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
  renderTransitionError,
} from "./admin/views.js";
```

（移除 renderIngestDetail 导入；renderTransitionError 为 T3 已加项必须保留——fold wave 2 Eng NEW-2。）

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
import { createAuditSink } from "../../src/audit/audit-sink.js";
import { rmSync, readFileSync } from "node:fs";

let app: any, db: any;
// RUN=本次运行标识：隔离 audit 文件名（并行进程不互踩）；
// track id 的随机后缀在每个用例内部生成（vitest retry 同模块复用 RUN，
// 用例级随机才能保证 attempt 间不撞 tracks.track_id 主键）——fold wave 3 codex r3 P2
const RUN = Math.random().toString(36).slice(2, 8);
const auditPath = `.tmp-audit-acceptance-${RUN}.jsonl`;

beforeAll(async () => {
  rmSync(auditPath, { force: true }); // 清前次残留
  db = createTestDb();
  app = await buildOpsApp({
    db,
    auditSink: createAuditSink(auditPath),
    adminToken: "dev-admin",
    operatorToken: "dev-op",
    presignFn: async (_key: string) => ({
      url: "https://example.test/audio?X-Amz-Signature=acc-test",
    }),
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
    const trackId = `self:acc1-${Math.random().toString(36).slice(2, 8)}`; // 每 attempt 唯一
    const adminCookie = await login("dev-admin");
    const ing = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: trackId, raw_metadata: META, audioObjectKey: "audio/acc1" },
      headers: { cookie: adminCookie },
    });
    const id = ing.json().id;

    const queue = await app.inject({
      method: "GET",
      url: "/admin/ingests",
      headers: { cookie: adminCookie },
    });
    expect(queue.body).toContain(trackId);

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
    expect(tracks.body).toContain(trackId);
  });

  it("approve 后 revoke → tracks 消失 + 审核历史含理由（独立种子，fold codex P2-3）", async () => {
    const trackId = `self:acc2-${Math.random().toString(36).slice(2, 8)}`; // 每 attempt 唯一
    const adminCookie = await login("dev-admin");
    const ing = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: trackId, raw_metadata: { ...META, title: "Acc2" }, audioObjectKey: "audio/acc2" },
      headers: { cookie: adminCookie },
    });
    const id = ing.json().id;
    await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/approve`,
      headers: { cookie: adminCookie },
    });
    const rv = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/revoke`,
      headers: { cookie: adminCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ reason: "acceptance takedown" }).toString(),
    });
    expect(rv.statusCode).toBe(200);

    const tracks = await app.inject({
      method: "GET",
      url: "/admin/tracks",
      headers: { cookie: adminCookie },
    });
    expect(tracks.body).not.toContain(trackId);

    const detail = await app.inject({
      method: "GET",
      url: `/admin/ingest/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(detail.body).toContain("acceptance takedown");
    expect(detail.body).toContain("已下架");
  });

  it("audit JSONL 含 provision/revoke 事件（独立种子 + 按 target 过滤，fold codex P2-3）", async () => {
    const trackId = `self:acc3-${Math.random().toString(36).slice(2, 8)}`; // 每 attempt 唯一
    const adminCookie = await login("dev-admin");
    const ing = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: trackId, raw_metadata: { ...META, title: "Acc3" } },
      headers: { cookie: adminCookie },
    });
    await app.inject({
      method: "POST",
      url: `/admin/ingest/${ing.json().id}/approve`,
      headers: { cookie: adminCookie },
    });
    await app.inject({
      method: "POST",
      url: `/admin/ingest/${ing.json().id}/revoke`,
      headers: { cookie: adminCookie },
    });
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const events = lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.target === trackId);
    expect(events.some((e) => e.eventType === "provision")).toBe(true);
    expect(events.some((e) => e.eventType === "revoke")).toBe(true);
  });
});
```

（三个用例各自独立种子/独立断言，单跑、筛选、重试均不依赖前序用例——fold codex P2-3。）

- [ ] **Step 2: 跑验收测试确认通过**

Run: `pnpm vitest run test/integration/review-ui-acceptance.e2e.test.ts`
Expected: 3/3 PASS。若 FAIL：逐个定位是 Task 1-6 哪个环节回归，修复后重跑（不新增实现，验收只验证既有产物）。

- [ ] **Step 3: 全量回归 + 构建**

Run: `pnpm test`
Expected: 全 PASS，零回归。

Run: `pnpm build`
Expected: tsc exit 0。

- [ ] **Step 4: CLI 试听接线手动验证（spec known hole 8 承接项，fold wave 2 Eng NEW-5）**

本地有 pg 环境时执行一次，并把验证结果记入 **SDD 阶段进度 ledger**（`.superpowers/sdd/<task 目录>/progress.md`，SDD 执行段开始时建立，沿用 J1/M3 SDD 先例；fold wave 3 codex r3 P2：原表述未定义 ledger）；无 pg 环境则在 ledger 记「环境不具备，known hole 8 保持」：

```bash
# 启动 App2（默认连 postgres://localhost:5432/agentos_content，需先建库跑 migrations）
pnpm tsx src/ops-app.ts
```

手动验证项：登录（admin token）→ POST /admin/ingest 建一条带 audioObjectKey 的 ingest → GET 详情页 → 试听区出现 `<audio>`（presign 懒加载成功）或出现「试听获取失败」（S3 未起）——两者之一即证明 CLI 接线生效（不再是「试听未配置」）。

- [ ] **Step 5: README 补审核工作台小节 + 修 stale 描述**

先修 stale 行（fold Eng M5）：README.md 环境变量表约 line 101 `CONTENT_BACKEND_OPERATOR_TOKEN` 描述从「operator token（只读审核队列）」改为「operator token（可执行审核操作 approve/reject/revoke）」。

再在已有 `## M2b 审核 UI + content_policy 消费通道` 节（约 line 75 起）末尾追加子节：

```markdown
### 审核工作台（2026-08-04 演进）

`/admin/*` 已演进为正式内容审核工作台（spec `docs/superpowers/specs/2026-08-04-content-review-ui-evolution-design.md`）：

- 页面：`/admin/ingests`（待审队列，带导航/空态）/ `/admin/ingest/:id`（详情：全元数据/试听/审核历史/操作区）/ `/admin/tracks`（已发布曲目）
- 角色：admin+operator 均可审核（approve/reject/revoke，reject/revoke 可选理由 ≤1000 字符）；ingest 登记仍仅 admin
- 试听：音频存 S3（`audioObjectKey`），详情页懒加载 presign URL（现取现用，受 `S3_*` env 影响）
- 状态机防御：非法状态转换返 409 INVALID_TRANSITION
- sim 边界不变：认证为 sim dev token + 内存 session（B3），生产由 M1c OIDC/idP 替换
```

- [ ] **Step 6: Commit**

```bash
git add test/integration/review-ui-acceptance.e2e.test.ts README.md
git commit -m "test(content-backend): 审核 UI sim e2e 验收与 README 使用说明"
```

---

## Fold 记录（plan v4，2026-08-04 fold wave 3：第三轮 scoped re-review 收敛——Eng 5/5 CLOSED + codex 6/8 RESOLVED，CAS 竞态两路独立收敛）

| 来源 | finding | 处置 |
|---|---|---|
| codex r3 P1 × Eng NEW-6（两路独立收敛） | CAS 重读比对对同动作并发有伪不变量（miss 方重读看到赢家状态误判命中） | fold 终局：`UPDATE...RETURNING id` + rows.length 判定所有权（rows-only 契约安全；pg-mem 支持已运行时实证：命中 rows=[...]，miss rows=[]）；CAS 语义测试升级验证命中/未命中两分支；spec §3.5 同步定局并删 rowCount 残留措辞 |
| codex r3 P2（RUN retry 隔离不完整） | RUN 模块级常量，vitest retry 复用同值仍撞主键 | fold：track id 改每用例 attempt 内随机生成；RUN 仅用于 audit 文件名隔离并行进程 |
| codex r3 P2（T3 Interfaces 散文 stale） | 仍写 409/400 返 errBody | fold：Interfaces 改 HTML partial 定形描述，与 spec §4 一致 |
| codex r3 P2（ledger 未定义） | T7 手动验证「记入 ledger」无承接实体 | fold：明确为 SDD 阶段进度 ledger（.superpowers/sdd/<task 目录>/progress.md，J1/M3 先例） |

## Fold 记录（plan v3，2026-08-04 fold wave 2：scoped re-review 收敛——Eng 7/8 CLOSED + codex 11/13 RESOLVED，余下全 fold）

| 来源 | finding | 处置 |
|---|---|---|
| Eng M1/NEW-1 = codex r2 P1-1 | detail.eta 缺 responseHandling（审核操作就发生在详情页） | fold：detail.eta head 加配置 + T6 测试加锁定断言 |
| codex r2 P1-2 × Eng NEW-4 | 错误 partial 经 hx-target=body 整页替换后不可操作（裸 textarea 无表单） | fold：error.eta 改自包含形状——400=重试表单（textarea 回填+重试按钮）+返回链接，409=返回链接（状态已变不重试）；T3 测试断言重试表单/返回链接/409 无重试 |
| Eng NEW-3 | 409 partial 缺当前状态（spec §4 明文） | fold：T3 catch 分支查当前 state 入错误文案 |
| codex r2 P1-3 | T3 commit 漏 stage error.eta/views.ts | fold：git add 清单补全 + 注记 |
| Eng NEW-2 | T4/T6 views import 替换块丢 renderTransitionError（照做两次 tsc break） | fold：两处 import 块补名 + 注记 |
| codex r2 P2（CAS rowCount） | ContentDb 契约只保证 rows，rowCount 是契约外依赖 | fold：CAS 改「UPDATE 后重读比对」（rows-only 契约安全）+ CAS miss SQL 语义测试 |
| codex r2 P2（解析器无=分支） | fold wave 1 把无 = 参数值误改为参数名本身 | fold：恢复空串行为，保留 + →空格修复 |
| codex r2 P2（XSS 断言不全） | 只锁 < >，未锁 " & | fold：payload 加引号/&，断言 &quot;/&amp; |
| codex r2 P2（T7 retry 隔离） | audit 文件未清 + 固定 track id retry 撞主键 | fold：beforeAll rmSync + RUN 随机后缀 |
| Eng NEW-5 | known hole 8 手动验证项无承接步骤 | fold：T7 加 Step 4 CLI 手动验证（含环境不具备的诚实分支） |
| codex r2 P2-1（统一错误页） | 仍属明确驳回（404 JSON = M2b fix #2 先例 + 既有测试依赖） | 驳回维持，spec §4 措辞已定形 |

## Fold 记录（plan v2，2026-08-04：Eng 3I/5M + codex 跨厂商 7P1/6P2 全 fold）

| 来源 | finding | 处置 |
|---|---|---|
| Eng I1 = codex P1-3 | CLI 入口缺试听接线 | fold：T4 加 CLI 接线步骤（createS3+presignFn），known hole 8 标注无自动化测试 |
| Eng I2 | `not.toContain(">approve<")` 自相矛盾 | fold：T6 断言改查 approve 按钮 hx-post 不存在 |
| Eng I3 = codex P1-4 | 队列缺标题/艺人列（codex 另指出无 LIMIT） | fold：T5 SELECT raw_metadata 解析 + 两列 + 徽标 + LIMIT 100 |
| Eng M1 × codex P1-2 | 400/409 JSON + htmx 2.0.4 默认 4xx 不 swap（实证） | fold：T3 改 HTML error partial（error.eta + renderTransitionError）；T5/T6 页面 head 加 responseHandling 配置；测试断言 HTML；spec §4/§4.1 更新 |
| Eng M2 = codex P1-7 | spec 未登录「重定向」失实（现状 401） | fold：spec §4 改 401；plan 测试不动 |
| Eng M3 = codex P2-6 | T1 watch-fail 预期失准 | fold：T1 Step 2 预期改 1 FAIL/1 PASS（NULL 守护） |
| Eng M4 | Interfaces 散文签名不一致 | fold：T5/T6 Interfaces 与代码块同步 |
| Eng M5 | README:101 stale | fold：T7 顺手改 |
| codex P1-1 | tracks 10s 自刷新 + hx-select 嵌套风险 | fold（YAGNI 路线）：移除自刷新（M2b 原实现本有嵌套 bug）；spec §3.1 更新 |
| codex P1-5 | transition TOCTOU + reviewId 碰撞 | fold：T2 CAS UPDATE（带旧状态条件+rowCount）+ randomUUID；无事务边界入 spec known hole 6 |
| codex P1-6 | form-urlencoded `+`→空格解析 bug（现状真 bug） | fold：T3 解析器修复 + URLSearchParams 测试；spec known hole 7 |
| codex P2-1 | 统一 HTML 错误页 | 部分驳回：404 保持 JSON errBody（M2b fix #2 先例+既有测试），transition 错误走 HTML partial；spec §4 措辞更新 |
| codex P2-2 | presign catch 分支无测试 | fold：T4 改 presignFn 注入（对齐 index.ts PresignFn 模式）+ 抛错注入测试 |
| codex P2-3 | 验收用例互相依赖 | fold：T7 三用例独立种子/独立断言 |
| codex P2-4 | 队列链接测试依赖前序数据 | fold：T5 用例内自建 pending 条目 + 精确断言 |
| codex P2-5 | migration fallback 伪造 journal | fold：T1 移除手写 fallback，失败即停报告 |
| codex P2-7 | XSS 无回归测试 | fold：T6 加 eta autoEscape 回归测试（eta 4.x autoEscape 默认开已实证）+ spec §5 #10/#11 |

## Self-Review 记录（v4）

- **wave 3 增量核验**：CAS=RETURNING 所有权判定（命中/miss 两分支测试守护，pg-mem 实证支持）；spec §3.5 与 plan CAS 语义一致（rowCount 措辞已删）；T7 track id 每 attempt 随机+audit 文件按 RUN 隔离；T3 Interfaces 与 spec §4 错误响应定形一致；T7 手动验证 ledger 落点明确。
- **wave 2 增量核验**：responseHandling 三页齐（queue/tracks/detail）；错误 partial 自包含可操作（400 重试/409 返回）；解析器无=分支空串；T3 commit stage 完整；T4/T6 import 含 renderTransitionError；XSS 四字符锁定；T7 retry 隔离（RUN 后缀+audit 清理）；T7 手动验证承接 known hole 8。
- **Spec 覆盖**：§3.1 页面交互→T5/T6（队列 5 列齐+LIMIT）；§3.2 试听→T4（含 CLI 接线+T7 手动验证）；§3.3 角色门→T3；§3.4 reason→T1/T3/T6；§3.5 状态机防御（含 CAS RETURNING）→T2/T3；§3.6 数据流→T1-T7；§4 错误处理表（含 §4.1 responseHandling + 自包含 partial 形状）→T2/T3/T5/T6；§5 测试矩阵 11 项→T1-T7 逐项对应；§6 验收→T7；§9 known holes 6/7/8 对应 T2/T3/T4 边界。
- **Placeholder scan**：无 TBD/TODO；每步含代码或命令+预期。
- **类型一致性**：`transition(db, ingestId, action, actor, reason?)` / `ingestTransitionAndAudit(db, auditSink, ingestId, action, actor, reason?)` 全 plan 一致；`renderDetailPage` 入参 T6 定义与消费一致；`renderAudio({url?|notice?})`、`renderTransitionError({message, reason?, retryAction?, backHref?})`、`presignFn?: (key) => Promise<{url: string}>` 各处一致。
