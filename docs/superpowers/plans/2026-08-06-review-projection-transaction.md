# 审核操作投影事务化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ContentDb port 增加回调式事务能力（withTransaction），把审核状态机的 CAS+审计行+tracks 投影包进同一数据库事务，根治 PR#12 codex P1（进程内并发交错产生「revoked 但曲目仍发布」第三态）。

**Architecture:** 类型分层 Queryable ⊂ ContentDb ⊂ TransactionalContentDb（ContentDb 结构不变，既有消费者零感知）；生产实现 wrapPgPool 用 pool.connect() 专用连接保证 BEGIN→回调→COMMIT/ROLLBACK→release 全链同连接；正确性依赖 READ COMMITTED 行锁串行化 + CAS 条件重检（spec §5 论证）。

**Tech Stack:** TypeScript ESM / fastify / vitest 2.1.9 / pg-mem 3.0.14（测试替身，无事务语义——spike 实证）/ pg ^8（生产）/ @testcontainers/postgresql ^12.0.4（Layer 3 真 pg 验收）。

**Spec:** `docs/superpowers/specs/2026-08-06-review-projection-transaction-design.md`（commit `519ddcc`，D1-D7 冻结，review 不得重议）

## Global Constraints

- **零 DDL**：不改 schema.ts / src/db/migrations/；不改任何 frozen 契约（shared-protocols / *-envelope.schema.json / device-hub contract.h 零触碰）
- **禁触清单**：README.md 与 app layout templates（窗口 C T2 区域）；src/index.ts onSend 区域与 src/auth/token-verify-hook.ts（窗口 C T3 区域）；src/index.ts 其余部分也零改动（不调 buildOpsApp，无需动）
- **回归基线只增不减**：改动前基线 269 passed / 29 skipped + 4 个既有环境依赖失败文件（test/db/seed.test.ts 需 Docker+ffmpeg / test/integration/token-verify.e2e.test.ts 需真 IAM seed / m3-stage2×2 需 device-hub 直连）；此后每 task 全量跑，新增用例只增不减，4 文件集合不变
- **验证命令**：`pnpm test`（vitest run）；`pnpm build`（tsc -p tsconfig.json）必须 exit 0
- **SDD 写码门禁（Task 1 开工前）**：确认窗口 C T2/T3 已 merge → `git -c https.proxy= fetch` → worktree rebase 到最新 content-backend main（spec §3 D7）；若窗口 C 未 merge，报主窗口裁决，不自决开工
- **commit 规范**：英文 conventional 前缀 + 冒号后中文描述；代码标识符英文，代码注释中文
- **诚实证据**：Layer 3 无 Docker 时 describe.skip（不是删除测试）；任何验证失败如实记录，不虚构输出

---

### Task 1: 事务 port 扩展 + wrapPgPool 生产实现 + Layer 1 契约测试

**Files:**
- Modify: `src/content/db.ts`（加 Queryable / TransactionalContentDb，ContentDb 结构不变）
- Create: `src/db/transaction.ts`（wrapPgPool + PgPoolLike/PgClientLike）
- Create: `test/unit/db-transaction.test.ts`（Layer 1 fake pool 契约测试 5 用例）

**Interfaces:**
- Consumes: 无（本 task 不依赖其他 task）
- Produces: `Queryable`（`{ query(text, params?): Promise<{ rows: QueryResultRow[] }>`）；`TransactionalContentDb`（ContentDb + `withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>`）；`wrapPgPool(pool: PgPoolLike): TransactionalContentDb`；`PgPoolLike`/`PgClientLike`——Task 2/3 全部消费这些名字与签名

- [ ] **Step 1: 环境准备（setup，仅首次）**

```bash
cd /Users/lcz/projects/agentos-content-backend/.claude/worktrees/content-review-projection-tx
pnpm install --frozen-lockfile
# drift.test.ts 依赖 ../AgentOS 相对路径（worktree 内不存在），建 sibling symlink（不入 git，PR#12 setup 先例）
ln -s /Users/lcz/projects/AgentOS /Users/lcz/projects/agentos-content-backend/.claude/worktrees/AgentOS
```

- [ ] **Step 2: 记录回归基线**

Run: `pnpm test`
Expected: 269 passed / 29 skipped；4 个既有环境依赖失败文件集合与 Global Constraints 所列一致。记录实际数字到 report（后续每 task 只增不减的锚点）。`pnpm build` exit 0。

- [ ] **Step 3: 写失败测试（Layer 1 契约，5 用例）**

创建 `test/unit/db-transaction.test.ts`：

```ts
// db-transaction.test.ts — Layer 1 wrapper 契约测试（spec §8 Layer 1）。
// fake PgPoolLike 记录调用序列：连接亲和性/COMMIT/ROLLBACK/release 保证。
// 本层与 pg-mem 无关——pg-mem 无事务语义（spec §8 spike 实证），契约必须用 fake 验证。
import { describe, it, expect } from "vitest";
import { wrapPgPool, type PgPoolLike } from "../../src/db/transaction.js";

interface FakeClient {
  queries: { text: string; params?: unknown[] }[];
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

function fakePool(opts: { failClientQuery?: string } = {}) {
  const clients: FakeClient[] = [];
  const released: FakeClient[] = [];
  const poolQueries: string[] = [];
  const pool: PgPoolLike = {
    async query(text) {
      poolQueries.push(text);
      return { rows: [] };
    },
    async connect() {
      const client: FakeClient = {
        queries: [],
        async query(text, params) {
          if (opts.failClientQuery && text === opts.failClientQuery) {
            throw new Error("boom:" + text);
          }
          client.queries.push({ text, params });
          return { rows: [] };
        },
        release() {
          released.push(client);
        },
      };
      clients.push(client);
      return client;
    },
  };
  return { pool, clients, released, poolQueries };
}

describe("wrapPgPool 契约（Layer 1）", () => {
  it("成功路径：connect×1→BEGIN→queries 全经同一 client→COMMIT→release，返回值透传", async () => {
    const { pool, clients, released, poolQueries } = fakePool();
    const db = wrapPgPool(pool);
    const out = await db.withTransaction(async (tx) => {
      await tx.query("SELECT 1 AS a", [1]);
      await tx.query("UPDATE t SET x=$1", ["v"]);
      return "done";
    });
    expect(out).toBe("done");
    expect(clients.length).toBe(1); // 恰好一次 connect
    const seq = clients[0].queries.map((q) => q.text);
    expect(seq[0]).toBe("BEGIN");
    expect(seq).toContain("SELECT 1 AS a");
    expect(seq).toContain("UPDATE t SET x=$1");
    expect(seq[seq.length - 1]).toBe("COMMIT");
    expect(poolQueries.length).toBe(0); // 无 pool.query 旁路
    expect(released.length).toBe(1); // 连接已还
  });

  it("回调抛错：ROLLBACK→release→原错误透传", async () => {
    const { pool, clients, released } = fakePool();
    const db = wrapPgPool(pool);
    await expect(
      db.withTransaction(async (tx) => {
        await tx.query("SELECT 1");
        throw new Error("INVALID_TRANSITION");
      }),
    ).rejects.toThrow("INVALID_TRANSITION");
    const seq = clients[0].queries.map((q) => q.text);
    expect(seq[0]).toBe("BEGIN");
    expect(seq[seq.length - 1]).toBe("ROLLBACK");
    expect(seq).not.toContain("COMMIT");
    expect(released.length).toBe(1);
  });

  it("ROLLBACK 自身失败：不遮盖原错误，release 仍被调", async () => {
    const { pool, released } = fakePool({ failClientQuery: "ROLLBACK" });
    const db = wrapPgPool(pool);
    await expect(
      db.withTransaction(async () => {
        throw new Error("biz-error");
      }),
    ).rejects.toThrow("biz-error");
    expect(released.length).toBe(1);
  });

  it("COMMIT 失败：尝试 ROLLBACK + 抛原错误 + release", async () => {
    const { pool, clients, released } = fakePool({ failClientQuery: "COMMIT" });
    const db = wrapPgPool(pool);
    await expect(
      db.withTransaction(async (tx) => {
        await tx.query("SELECT 1");
      }),
    ).rejects.toThrow("boom:COMMIT");
    const seq = clients[0].queries.map((q) => q.text);
    expect(seq).toContain("ROLLBACK");
    expect(released.length).toBe(1);
  });

  it("非事务 query() 仍走 pool.query（既有行为零变化）", async () => {
    const { pool, poolQueries, clients } = fakePool();
    const db = wrapPgPool(pool);
    await db.query("SELECT 2");
    expect(poolQueries).toEqual(["SELECT 2"]);
    expect(clients.length).toBe(0); // 未动用 connect
  });
});
```

- [ ] **Step 4: 跑测试确认 RED**

Run: `pnpm vitest run test/unit/db-transaction.test.ts`
Expected: FAIL——`src/db/transaction.ts` 不存在，import 解析失败（5 用例全红）

- [ ] **Step 5: port 类型扩展**

`src/content/db.ts` 改为（保留原头部注释，接口区重写）：

```ts
export interface QueryResultRow {
  [column: string]: unknown;
}

// Queryable：最小查询接口——池与事务句柄同形（spec §4.1）
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}

// ContentDb：结构不变（仍 {query}）；extends Queryable 使既有实现可直接传给 transition(Queryable)
export interface ContentDb extends Queryable {}

// TransactionalContentDb：带事务能力的 ContentDb（spec §4.1）
export interface TransactionalContentDb extends ContentDb {
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
```

- [ ] **Step 6: wrapPgPool 最小实现**

创建 `src/db/transaction.ts`：

```ts
// transaction.ts — ContentDb 事务包裹（生产实现，spec §4.2）。
//
// 根治点：朴素 BEGIN/COMMIT 走 Pool.query() 连接不安全（每次 query 可能拿到不同连接）。
// wrapPgPool 用 pool.connect() 拿专用连接：BEGIN → 回调 → COMMIT（抛错→ROLLBACK）→ finally release。
// 回调内所有 query 都经同一 client；连接泄漏不可能（release 在 finally）。
// 正确性论证（行锁串行化 + CAS 重检）见 spec §5。
import type { Queryable, QueryResultRow, TransactionalContentDb } from "../content/db.js";

export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  release(): void;
}

export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  connect(): Promise<PgClientLike>;
}

export function wrapPgPool(pool: PgPoolLike): TransactionalContentDb {
  return {
    query: (text, params) => pool.query(text, params),
    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: (text, params) => client.query(text, params),
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        // COMMIT 失败同样走此路径（COMMIT 失败后 ROLLBACK 安全）
        try {
          await client.query("ROLLBACK");
        } catch {
          // ROLLBACK 失败（连接断等）：不遮盖原错误，连接回收靠 finally release
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
```

- [ ] **Step 7: 跑测试确认 GREEN + 全量回归 + tsc**

Run: `pnpm vitest run test/unit/db-transaction.test.ts` → Expected: 5 passed
Run: `pnpm test` → Expected: 274 passed（基线 269 + 本 task 5）/ 29 skipped / 4 既有环境失败文件不变
Run: `pnpm build` → Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add src/content/db.ts src/db/transaction.ts test/unit/db-transaction.test.ts
git commit -m "feat(review): ContentDb 事务 port 扩展 + wrapPgPool 包裹 + Layer 1 契约测试"
```

---

### Task 2: 事务化切换（状态机放宽 + ingest 包裹 + ops-app 接线 + Layer 2 亲和断言）

**Files:**
- Modify: `src/review/state-machine.ts`（transition/fetchIngest 入参 ContentDb→Queryable，SQL 零改动）
- Modify: `src/admin/ingest.ts`（ingestTransitionAndAudit 包 withTransaction；fetchIngestTrackId 放宽 Queryable）
- Modify: `src/ops-app.ts`（BuildOpsAppOpts.db: TransactionalContentDb；CLI 入口 wrapPgPool 接线）
- Modify: `test/integration/helpers.ts`（createTestDb 返回 TransactionalContentDb）
- Create: `test/unit/review-tx-affinity.test.ts`（Layer 2 通道亲和断言 2 用例）

**Interfaces:**
- Consumes: Task 1 的 `Queryable` / `TransactionalContentDb` / `wrapPgPool`（签名见 Task 1 Produces）
- Produces: `ingestTransitionAndAudit(db: TransactionalContentDb, ...)`（签名变化，ops-app 内部消费）；`transition(db: Queryable, ...)`（放宽后签名）；helpers `createTestDb(): TransactionalContentDb`——Task 3 e2e 消费

- [ ] **Step 1: 写失败测试（Layer 2 亲和断言）**

创建 `test/unit/review-tx-affinity.test.ts`：

```ts
// review-tx-affinity.test.ts — Layer 2 通道亲和断言（spec §8 Layer 2）。
// 断言 ingestTransitionAndAudit 的全部语句经 tx 句柄、零 pool 旁路。
// pg-mem 3.0.14 无事务语义（spec §8 spike 实证），本层只测序列通道，回滚语义不归本层。
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import type { TransactionalContentDb } from "../../src/content/db.js";
import { ingestTransitionAndAudit } from "../../src/admin/ingest.js";

// DDL 与 test/unit/review-state.test.ts 同源
const INGEST_DDL = `CREATE TABLE ingest (
  id text PRIMARY KEY,
  track_id text NOT NULL,
  source text NOT NULL,
  raw_metadata text NOT NULL,
  audio_object_key text,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamp NOT NULL DEFAULT now()
)`;

const REVIEW_DDL = `CREATE TABLE review (
  id text PRIMARY KEY,
  ingest_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  reason text,
  at timestamp NOT NULL DEFAULT now()
)`;

const TRACKS_DDL = `CREATE TABLE tracks (
  track_id text PRIMARY KEY,
  title text NOT NULL,
  artist text NOT NULL,
  album text,
  duration_ms integer NOT NULL,
  cover_url text,
  audio_object_key text NOT NULL,
  format text NOT NULL,
  bitrate integer NOT NULL,
  isrc text UNIQUE,
  license text NOT NULL,
  region_policy text,
  published_at timestamp NOT NULL DEFAULT now()
)`;

const META = JSON.stringify({
  title: "A",
  artist: "B",
  durationMs: 1000,
  format: "mp3",
  bitrate: 128000,
  license: "CC",
});

function makeRecordingDb(): {
  db: TransactionalContentDb;
  rec: { txQueries: string[]; bypassDuringTx: string[] };
} {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  pool.query(INGEST_DDL);
  pool.query(REVIEW_DDL);
  pool.query(TRACKS_DDL);
  const rec = { txQueries: [] as string[], bypassDuringTx: [] as string[] };
  let inTx = false;
  const db: TransactionalContentDb = {
    query(text, params) {
      if (inTx) rec.bypassDuringTx.push(text);
      return pool.query(text, params as any[]);
    },
    // pg-mem 无事务语义：直通 + 句柄分离（记录需要）
    async withTransaction(fn) {
      inTx = true;
      try {
        return await fn({
          query: (text, params) => {
            rec.txQueries.push(text);
            return pool.query(text, params as any[]);
          },
        });
      } finally {
        inTx = false;
      }
    },
  };
  return { db, rec };
}

describe("事务通道亲和（Layer 2）", () => {
  it("approve：全部语句经 tx 句柄，零 pool 旁路", async () => {
    const { db, rec } = makeRecordingDb();
    await db.query(
      "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'pending')",
      ["i1", "self:t1", "admin-ui", META, "obj/k"],
    );
    rec.txQueries.length = 0; // 种子不计入
    await ingestTransitionAndAudit(db, undefined, "i1", "approve", "user:admin");
    // trackId SELECT + transition 内 fetchIngest SELECT + CAS UPDATE + review INSERT + tracks INSERT = 5 句
    //（fold Eng review C：transition() 内部自带一句 fetchIngest SELECT——spec §4.3 SQL 零改动，不得砍）
    expect(rec.txQueries.length).toBe(5);
    expect(rec.txQueries.some((q) => q.startsWith("UPDATE ingest"))).toBe(true);
    expect(rec.bypassDuringTx.length).toBe(0);
    const { rows } = await db.query("SELECT count(*)::int AS c FROM tracks");
    expect(Number(rows[0].c)).toBe(1);
  });

  it("revoke：全部语句经 tx 句柄（含 tracks DELETE）", async () => {
    const { db, rec } = makeRecordingDb();
    await db.query(
      "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'approved')",
      ["i1", "self:t1", "admin-ui", META, "obj/k"],
    );
    await db.query(
      "INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      ["self:t1", "A", "B", 1000, "obj/k", "mp3", 128000, "CC"],
    );
    rec.txQueries.length = 0;
    await ingestTransitionAndAudit(db, undefined, "i1", "revoke", "user:admin");
    expect(rec.txQueries.some((q) => q.startsWith("DELETE FROM tracks"))).toBe(true);
    expect(rec.bypassDuringTx.length).toBe(0);
    const { rows } = await db.query("SELECT count(*)::int AS c FROM tracks");
    expect(Number(rows[0].c)).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `pnpm vitest run test/unit/review-tx-affinity.test.ts`
Expected: FAIL——现 ingestTransitionAndAudit 不调 withTransaction，rec.txQueries.length=0 ≠ 5（2 用例红）。若出现编译错误（TransactionalContentDb 传入旧签名 ContentDb 参数应兼容，不应报错；若报错说明 Task 1 类型未落，先修）

- [ ] **Step 3: state-machine.ts 入参放宽（SQL 零改动）**

`src/review/state-machine.ts` 三处修改：

import 行：
```ts
import type { Queryable } from "../content/db.js";
```
（替换原 `import type { ContentDb } from "../content/db.js";`）

头部注释块末尾追加一行：
```ts
// 2026-08-06 事务化：入参放宽 Queryable，由 withTransaction 包裹调用（spec §4.3）；SQL 与语义零改动。
```

两个签名：
```ts
async function fetchIngest(
  db: Queryable,
  ingestId: string,
): Promise<IngestRow | null> {
```
```ts
export async function transition(
  db: Queryable,
  ingestId: string,
  action: ReviewAction,
  actor: string,
  reason?: string,
): Promise<void> {
```

- [ ] **Step 4: admin/ingest.ts 事务包裹**

`src/admin/ingest.ts` 修改后全文关键段：

import 区替换为：
```ts
import type { ContentDb, Queryable, TransactionalContentDb } from "../content/db.js";
import { transition } from "../review/state-machine.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { emitProvision, emitRevoke } from "../audit/audit-events.js";
```

`validateRawMetadata` 与 `ingestCreate` 原样不动（ingestCreate 保持 `db: ContentDb`，单语句天然原子，spec §2 非目标）。

`fetchIngestTrackId` 签名放宽：
```ts
async function fetchIngestTrackId(
  db: Queryable,
  ingestId: string,
): Promise<string | null> {
```
（函数体不动）

`ingestTransitionAndAudit` 替换为：
```ts
export async function ingestTransitionAndAudit(
  db: TransactionalContentDb,
  auditSink: AuditSink | undefined, // I2 fix: pass-through undefined（emit 函数已 guard）
  ingestId: string,
  action: "approve" | "reject" | "revoke",
  actor: string,
  reason?: string,
): Promise<{ trackId: string | null }> {
  // CAS + review + tracks 投影同一连接/事务（spec §4.4）：
  // 并发转换由 pg 行锁串行化，回滚保证无局部残留（P1 根治）。
  const { trackId } = await db.withTransaction(async (tx) => {
    const tid = await fetchIngestTrackId(tx, ingestId); // trackId 读取进事务（一致性读）
    await transition(tx, ingestId, action, actor, reason);
    return { trackId: tid };
  });
  // audit 仅 COMMIT 后 emit（spec §7/D4）：失败/回滚的审核动作不进 audit
  if (action === "approve" && trackId) {
    await emitProvision(auditSink, { ingestId, trackId, actor });
  }
  // fold codex P1#4：spec §8.3 audit matrix 行"审核拒绝/下架（rejected/revoked）→revoke"——reject 也 emit revoke
  if ((action === "reject" || action === "revoke") && trackId) {
    await emitRevoke(auditSink, { trackId, actor });
  }
  return { trackId };
}
```

- [ ] **Step 5: ops-app.ts 接线（类型 + CLI）**

`src/ops-app.ts` 三处修改：

import 区追加（`import type { ContentDb } from "./content/db.js";` 一行替换为）：
```ts
import type { ContentDb, TransactionalContentDb } from "./content/db.js";
import { wrapPgPool } from "./db/transaction.js";
```

`BuildOpsAppOpts` 接口：
```ts
export interface BuildOpsAppOpts {
  db: TransactionalContentDb;
  // 其余字段不动
```
（接口其余行原样）

CLI 入口段（原 `const { Pool } = await import("pg"); ... const db: ContentDb = {...};` 块）替换为：
```ts
const { Pool } = await import("pg");
const pool = new Pool({ connectionString: env.dbUrl });
// 事务化 port（spec §4.5）：显式适配器包裹 pg Pool（params as any[] 对齐仓内既有姿势）
const db = wrapPgPool({
  query: (text, params) => pool.query(text, params as any[]),
  connect: async () => {
    const c = await pool.connect();
    return {
      query: (text: string, params?: unknown[]) => c.query(text, params as any[]),
      release: () => c.release(),
    };
  },
});
```
（CLI 段其余代码不动）

- [ ] **Step 6: helpers.ts 测试适配器升级**

`test/integration/helpers.ts` 两处修改：

import 行替换为：
```ts
import type { ContentDb, Queryable, TransactionalContentDb } from "../../src/content/db.js";
```

`createTestDb` 返回类型与 db 字面量：
```ts
export function createTestDb(opts: { withLyrics?: boolean; withIngest?: boolean } = {}): TransactionalContentDb {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  const db: TransactionalContentDb = {
    async query(text: string, params?: unknown[]) {
      return pool.query(text, params as any[]);
    },
    // pg-mem 3.0.14 无事务语义（spec §8 spike 实证：ROLLBACK 不撤销、事务内写立即可见）——
    // 直通实现仅满足 SQL 序列测试；回滚语义由 Layer 1 fake pool 契约 + Layer 3 真 pg 担当。
    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn({
        query: (text: string, params?: unknown[]) => pool.query(text, params as any[]),
      });
    },
  };
  // 建表段原样不动（TRACKS_DDL/LYRICS/CONTENT_POLICY/INGEST/REVIEW）
```
（seedTrack/seedLyrics 保持 `db: ContentDb` 不动）

- [ ] **Step 7: 跑测试确认 GREEN + 全量回归 + tsc**

Run: `pnpm vitest run test/unit/review-tx-affinity.test.ts` → Expected: 2 passed
Run: `pnpm vitest run test/unit/review-state.test.ts` → Expected: 10 passed（既有用例不改动通过，类型兼容验证）
Run: `pnpm vitest run test/integration/review-ui-acceptance.e2e.test.ts` → Expected: 3 passed（切换后行为不变验证）
Run: `pnpm test` → Expected: 276 passed（274 + 本 task 2）/ 29 skipped / 4 既有环境失败文件不变
Run: `pnpm build` → Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add src/review/state-machine.ts src/admin/ingest.ts src/ops-app.ts test/integration/helpers.ts test/unit/review-tx-affinity.test.ts
git commit -m "feat(review): 审核转换事务化切换（CAS+审计行+投影同连接原子，Layer 2 亲和断言）"
```

---

### Task 3: Layer 3 真 pg 并发验收（testcontainers，P1 回归）

**Files:**
- Create: `test/integration/review-projection-tx.e2e.test.ts`（Case A P1 回归 / Case B CAS 竞争零残留 / Case C 回滚与断连零残留）

**Interfaces:**
- Consumes: Task 1 `wrapPgPool`；Task 2 后的 `buildOpsApp({ db: TransactionalContentDb, ... })`
- Produces: 无（验收测试，验收证据来源——spec §9 判据 4）

**说明**：本 task 是验收型测试（行为已在 Task 2 修复）——预期直接 GREEN，非 RED→GREEN（PR#12 Task 7 验收同型）。其价值=P1 回归守护 + 真 pg 行锁语义实证（pg-mem 无法担当，spec §8 Layer 3 定位）。

- [ ] **Step 1: 写验收测试**

创建 `test/integration/review-projection-tx.e2e.test.ts`：

```ts
// review-projection-tx.e2e.test.ts — Layer 3 真 pg 并发验收（spec §8 Layer 3）。
// Case A=P1 回归（approve/revoke 并发终态不变量）；Case B=CAS 竞争恰一成功零残留；
// Case C=回滚/断连零残留（崩溃窗口前提实证）。
// Docker 检测照 test/db/seed.test.ts dockerAvailable() 先例；无 Docker 诚实 skip。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildOpsApp } from "../../src/ops-app.js";
import { wrapPgPool } from "../../src/db/transaction.js";

// DDL 与 test/integration/helpers.ts INGEST_DDL/REVIEW_DDL/TRACKS_DDL 同源
const INGEST_DDL = `CREATE TABLE IF NOT EXISTS ingest (
  id text PRIMARY KEY,
  track_id text NOT NULL,
  source text NOT NULL,
  raw_metadata text NOT NULL,
  audio_object_key text,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamp NOT NULL DEFAULT now()
)`;

const REVIEW_DDL = `CREATE TABLE IF NOT EXISTS review (
  id text PRIMARY KEY,
  ingest_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  reason text,
  at timestamp NOT NULL DEFAULT now()
)`;

const TRACKS_DDL = `CREATE TABLE IF NOT EXISTS tracks (
  track_id text PRIMARY KEY,
  title text NOT NULL,
  artist text NOT NULL,
  album text,
  duration_ms integer NOT NULL,
  cover_url text,
  audio_object_key text NOT NULL,
  format text NOT NULL,
  bitrate integer NOT NULL,
  isrc text UNIQUE,
  license text NOT NULL,
  region_policy text,
  published_at timestamp NOT NULL DEFAULT now()
)`;

const META = JSON.stringify({
  title: "Tx",
  artist: "Concurrency",
  durationMs: 1000,
  format: "mp3",
  bitrate: 128000,
  license: "CC",
});

function dockerAvailable(): boolean {
  if (process.env.DOCKER_HOST) return true;
  try {
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const runSuite = dockerAvailable() ? describe : describe.skip;

runSuite("审核投影事务化：真 pg 并发验收（Layer 3）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: any;
  let opCookie: string;

  beforeAll(async () => {
    // 钉镜像对齐 seed.test.ts 先例（fold Eng review I：本机缓存命中 + spec §12 镜像决策显式落地）
    container = await new PostgreSqlContainer("postgres:15-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(INGEST_DDL);
    await pool.query(REVIEW_DDL);
    await pool.query(TRACKS_DDL);
    app = await buildOpsApp({
      db: wrapPgPool({
        query: (text, params) => pool.query(text, params as any[]),
        connect: async () => {
          const c = await pool.connect();
          return {
            query: (t: string, p?: unknown[]) => c.query(t, p as any[]),
            release: () => c.release(),
          };
        },
      }),
      adminToken: "tx-admin",
      operatorToken: "tx-op",
    });
    const r = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { token: "tx-op" },
    });
    const sc = r.headers["set-cookie"];
    opCookie = Array.isArray(sc) ? sc[0] : sc;
  }, 240_000); // 对齐 seed.test.ts 先例（fold Eng review I：镜像首次拉取余量）

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60_000);

  async function seedIngest(id: string, trackId: string, state: string): Promise<void> {
    await pool.query(
      "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,'admin-ui',$3,NULL,$4)",
      [id, trackId, META, state],
    );
  }

  async function terminal(id: string, trackId: string) {
    const st = await pool.query("SELECT state FROM ingest WHERE id=$1", [id]);
    const tr = await pool.query("SELECT count(*)::int AS c FROM tracks WHERE track_id=$1", [trackId]);
    const rv = await pool.query("SELECT count(*)::int AS c FROM review WHERE ingest_id=$1", [id]);
    return {
      state: String(st.rows[0].state),
      trackCount: Number(tr.rows[0].c),
      reviewCount: Number(rv.rows[0].c),
    };
  }

  it("Case A：approve/revoke 并发——P1 第三态绝不出现（20 轮）", async () => {
    for (let round = 0; round < 20; round++) {
      const id = `inga${round}`;
      const trackId = `self:a${round}`;
      await seedIngest(id, trackId, "pending");
      // 0–5ms 随机 stagger 提高交错窗口命中率（fold Eng review M；参数选择记入 report）
      const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)));
      const [ap, rv] = await Promise.all([
        (async () => {
          await jitter();
          return app.inject({ method: "POST", url: `/admin/ingest/${id}/approve`, headers: { cookie: opCookie } });
        })(),
        (async () => {
          await jitter();
          return app.inject({ method: "POST", url: `/admin/ingest/${id}/revoke`, headers: { cookie: opCookie } });
        })(),
      ]);
      expect(ap.statusCode).toBe(200); // pending 上 approve 无竞争者，恒成功
      const t = await terminal(id, trackId);
      if (rv.statusCode === 200) {
        // revoke 在 approve commit 后执行 → revoked + 投影已删 + 两条 review
        expect(t.state).toBe("revoked");
        expect(t.trackCount).toBe(0);
        expect(t.reviewCount).toBe(2);
      } else {
        // revoke 读到 approve 未提交的 pending → 非法转换 409 → approved + 投影在 + 一条 review
        expect(rv.statusCode).toBe(409);
        expect(t.state).toBe("approved");
        expect(t.trackCount).toBe(1);
        expect(t.reviewCount).toBe(1);
      }
      // P1 第三态显式断言（回归守护清晰性）
      expect(t.state === "revoked" && t.trackCount === 1).toBe(false);
    }
  });

  it("Case B：approve/reject CAS 竞争——恰一成功零残留（20 轮）", async () => {
    for (let round = 0; round < 20; round++) {
      const id = `ingb${round}`;
      const trackId = `self:b${round}`;
      await seedIngest(id, trackId, "pending");
      const [ap, rj] = await Promise.all([
        app.inject({ method: "POST", url: `/admin/ingest/${id}/approve`, headers: { cookie: opCookie } }),
        app.inject({ method: "POST", url: `/admin/ingest/${id}/reject`, headers: { cookie: opCookie } }),
      ]);
      const winners = [ap, rj].filter((r) => r.statusCode === 200);
      const losers = [ap, rj].filter((r) => r.statusCode === 409);
      expect(winners.length).toBe(1); // 行锁串行化 + CAS 重检：恰一赢家
      expect(losers.length).toBe(1);
      const t = await terminal(id, trackId);
      if (ap.statusCode === 200) {
        expect(t.state).toBe("approved");
        expect(t.trackCount).toBe(1);
      } else {
        expect(t.state).toBe("rejected");
        expect(t.trackCount).toBe(0);
      }
      expect(t.reviewCount).toBe(1); // 输家回滚：review 表恰一行
    }
  });

  it("Case C：中途失败/断连零残留", async () => {
    await seedIngest("ingc", "self:c", "pending");
    const txdb = wrapPgPool({
      query: (text, params) => pool.query(text, params as any[]),
      connect: async () => {
        const c = await pool.connect();
        return {
          query: (t: string, p?: unknown[]) => c.query(t, p as any[]),
          release: () => c.release(),
        };
      },
    });
    // C1 wrapper 回滚：CAS 后抛错 → 状态不变
    await expect(
      txdb.withTransaction(async (tx) => {
        await tx.query("UPDATE ingest SET state='approved' WHERE id=$1", ["ingc"]);
        throw new Error("force-rollback");
      }),
    ).rejects.toThrow("force-rollback");
    let st = await pool.query("SELECT state FROM ingest WHERE id='ingc'");
    expect(String(st.rows[0].state)).toBe("pending");

    // C2 连接断开：事务中途 release(true) 销毁连接（模拟崩溃，未发 COMMIT）→ pg 自动回滚
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("UPDATE ingest SET state='approved' WHERE id='ingc'");
    client.release(true); // destroy 连接，服务端检测断开后回滚未提交事务
    await new Promise((r) => setTimeout(r, 50)); // 服务端断开检测余量
    st = await pool.query("SELECT state FROM ingest WHERE id='ingc'");
    expect(String(st.rows[0].state)).toBe("pending");
    // 锁释放实证（fold Eng review M）：孤儿事务若仍持行锁此 UPDATE 将阻塞至超时；
    // rowCount=1 即「断连检测+回滚完成+锁释放」三合一实证；随后恢复 pending 不污染用例间状态
    const upd = await pool.query("UPDATE ingest SET state='approved' WHERE id='ingc'");
    expect(upd.rowCount).toBe(1);
    await pool.query("UPDATE ingest SET state='pending' WHERE id='ingc'");
  });
});
```

- [ ] **Step 2: 跑验收测试（预期直接 GREEN）**

Run: `pnpm vitest run test/integration/review-projection-tx.e2e.test.ts`
Expected: 3 passed（Docker 可用时；首次跑含容器启动，记录实际耗时入 report）。若 Docker 不可用 → 3 skipped（describe.skip 生效，如实记录）。若 Case A/B 出现第三态/双赢家 → **P1 未修复信号，立即停，报老林**（不自决重试超 2 次）

- [ ] **Step 3: 全量回归 + tsc**

Run: `pnpm test` → Expected: 279 passed（276 + 本 task 3，Docker 可用时）/ 29 skipped / 4 既有环境失败文件不变（本文件 Docker 不可用时 skip 不入失败集）
Run: `pnpm build` → Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add test/integration/review-projection-tx.e2e.test.ts
git commit -m "test(review): 真 pg 并发验收（P1 回归/CAS 竞争零残留/断连回滚）"
```

---

## 收尾验证（全 task 完成后，归链上 verification-before-completion，非 task）

1. `pnpm test` 全量复跑：279 passed / 29 skipped / 4 既有环境失败集合不变（Docker 可用口径；不可用则 276+3skip 并注明）
2. `pnpm build` exit 0
3. Surgical scope 核对：`git diff main --stat` 对 File Structure——新增 4（src/db/transaction.ts / test/unit/db-transaction.test.ts / test/unit/review-tx-affinity.test.ts / test/integration/review-projection-tx.e2e.test.ts）+ 改动 5（src/content/db.ts / src/review/state-machine.ts / src/admin/ingest.ts / src/ops-app.ts / test/integration/helpers.ts）+ 本计划文档；零清单外文件
4. known holes 入 PR body（spec §10 三条）+ not-architecture-impact 声明（spec §11）

---

## Fold 记录 — Eng plan review（2026-08-06，fresh-context 同厂商，VERDICT=NEEDS_WORK 1C/2I/2M）

| # | 严重度 | 位置 | 问题 | 处置 |
|---|---|---|---|---|
| 1 | C | Task 2 Step 1 approve 用例 | txQueries 断言 4 句少数一句——transition() 内部自带 fetchIngest SELECT，正确实现下恒为 5 句，GREEN 门不可达 | **fold**：断言改 `.toBe(5)` + 注释列 5 句构成 + Step 2 RED 期望同步改 0≠5 |
| 2 | I | 收尾验证 #3 | surgical 清单漏 review-tx-affinity.test.ts（新增 3 实为 4）；spec §9.6 同源 drift | **fold**：收尾 #3 改新增 4；spec §9.6 同步修正（fixup commit）；PR body 标注此同步事实 |
| 3 | I | Task 3 Step 1 beforeAll | 未钉镜像 + 120s timeout，偏离 seed.test.ts 先例（postgres:15-alpine + 240s），首次拉取叠加网络不稳会 FAIL 而非 skip | **fold**：`new PostgreSqlContainer("postgres:15-alpine")` + beforeAll 240_000 对齐先例 |
| 4 | M | Task 3 Case A | 零延迟同时发双请求，交错窗口命中率低（spec §12 委托的延迟参数未落地） | **fold**：每轮两 inject 各加 0–5ms 随机 stagger，参数记入 report；Layer 2 亲和断言仍结构性兜底 |
| 5 | M | Task 3 Case C2 | 零残留断言由 MVCC 保证，无法区分「已回滚」与「回滚未完成」，未验锁释放 | **fold**：追加经 pool 的 UPDATE rowCount=1 断言（孤儿事务持锁则阻塞超时）+ 恢复 pending |

核实备注：finding 1 对照 state-machine.ts:71（transition 内 fetchIngest）属实；finding 3 对照 seed.test.ts:29/44（钉镜像+240s）属实；其余两项为有效强化。Eng 清单外取证均已说明理由（session.ts cookie 链/policy-store 构造期零查询/vitest.config include/调用点 `db: any` 兼容）。
