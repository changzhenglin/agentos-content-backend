# 审核操作投影事务化设计 spec（内容审核 UI follow-up ①）

> 日期：2026-08-06（brainstorming 定稿 2026-08-05 晚—08-06）
> 状态：**已批准**（老林逐节确认：路线 A / 回调式 API / §1-3 / §4-5）
> 任务档位：大任务（内部公共契约变更=ContentDb port 扩展）；仓库=agentos-content-backend
> 上游裁决：内容审核 UI PR#12（MERGED `c0b32f0`）codex 跨厂商 final 1 P1，老林 2026-08-05 裁决 Hold+精确化+立本专项（见 `lin-decision-log.md` 当日条）

## §0 摘要

内容审核状态机 `transition()` 的三步动作（CAS 改 ingest 状态 → 记 review 审计行 → tracks 投影写/删）是三条独立 SQL，无原子性保证。codex 跨厂商 final P1 实证：进程内并发请求在 await 让出点交错**无需崩溃**即可触发终态不一致（`state=revoked` 但曲目仍发布）。本 spec 的修复 = 给 ContentDb port 增加回调式事务能力（`withTransaction`），把 transition 三步包进同一个数据库事务，依赖 pg 行锁+CAS 条件重检实现逐 ingest 串行化，两个触发条件（进程内交错/崩溃窗口）同时根治。零 schema 变更，零 frozen 契约触碰。

## §1 背景与根因

### 1.1 P1 原貌（codex 跨厂商 final，2026-08-04）

- 位置：`src/review/state-machine.ts`（CAS 语句在 :84）
- 交错序列：operator A approve 过 CAS 后在 await 点暂停 → operator B 合法 revoke（CAS approved→revoked + DELETE tracks，删空或删不存在的投影）→ A 恢复继续 INSERT review + INSERT tracks → **终态 `ingest.state=revoked` 但 tracks 表仍有该曲目（仍发布）**
- codex pg-mem 确定性复现；老林裁决 Hold（根因=批准 spec 已声明洞，非实现偏离）+ 精确化触发条件 + 立本专项根治

### 1.2 根因

- 批准 spec（2026-08-04-content-review-ui-evolution-design）§9 known hole 6 + §3.5：ContentDb port 无事务 API（pg-mem 约束），tracks 投影无事务包裹
- 既有防御（合法转换矩阵 + CAS `UPDATE...RETURNING` rows-only 契约）只保证**单次 CAS 的原子性**，不保证 CAS 与后续投影写入的整体原子性
- 附带缺陷（同源）：若第③步 tracks INSERT 失败（如 isrc UNIQUE 冲突），第①②步已落库，留下「状态已改但无投影」的孤儿记录

### 1.3 已分析约束（不重查，brainstorming 前置事实）

- 朴素 `BEGIN/COMMIT` 走 `ContentDb.query()` 在真 pg Pool 上**连接不安全**：每次 query 可能拿到不同连接，事务跨连接无效
- tracks 表唯一写入方=本状态机（approve INSERT / revoke DELETE）+ dev/test seed（`src/db/seed/seed.ts`）；ingest 表唯一写入方=ingestCreate。爆炸半径限于审核转换路径
- audit emit 时序：`ingestTransitionAndAudit` 在 transition 成功后 emit；事务化后保持「COMMIT 后才 emit」

## §2 目标与非目标

**目标**
1. 根治 P1：进程内并发交错（无需崩溃）不再产生第三态（revoked+曲目发布）
2. 同时闭合崩溃窗口（known hole 6 原措辞「CAS 后 INSERT 前进程崩溃」）
3. 附带闭合中途失败孤儿记录
4. 方案多进程部署安全（DB 级保证，不依赖进程内锁）

**非目标**
- 不改 schema/migration（零 DDL）
- 不做 ingestCreate 事务化（单语句天然原子）
- 不修 409 路径 deferred minor（task-3 deferred #1，另 scope）
- 不动 audit sink 机制（known hole 1「AUDIT_SINK_PATH 默认空 no-op」维持）
- 不触 frozen 契约、不跨 repo

## §3 决策记录（冻结，plan review 不得重议）

| # | 决策 | 选定 | 否决项与否决理由 |
|---|---|---|---|
| D1 | 修复路线 | **事务 API（ContentDb port 级 withTransaction）** | B 逐 ingest 进程内串行（崩溃窗口仍在+多进程失效，不算根治）；C 先 B 后 A（两次审查链总成本更高，B 代码是过渡死代码） |
| D2 | API 形状 | **回调式 `withTransaction(fn)`**（框架管借连接/BEGIN/COMMIT\|ROLLBACK/还连接） | 显式句柄 begin/commit/rollback（三个忘写点，连接泄漏靠纪律不可靠） |
| D3 | 隔离级别 | **READ COMMITTED（pg 默认，不升级）** | SERIALIZABLE（行锁+CAS 重检已充分，升级有性能代价无收益，见 §5 论证） |
| D4 | audit 时序 | **COMMIT 后才 emit**（失败/回滚的审核动作不进 audit） | 事务内 emit（sink 是文件写不进 DB 事务，且回滚后 emit 即假事件） |
| D5 | 测试策略 | **三层：fake pool 契约 / pg-mem 序列 / 真 pg 并发验收**（§8） | 单层 pg-mem（spike 实证 pg-mem 无事务语义，撑不起回滚与并发验证） |
| D6 | pg-mem 限制处理 | **明示分层担当**：pg-mem 层只测 SQL 序列，回滚语义归 Layer 1+3 | 试图让 pg-mem 模拟事务（backup/restore 快照回滚复杂且仍无并发隔离，假证据） |
| D7 | 窗口 C 时序 | **SDD 写码前确认窗口 C T2/T3 merged 并 rebase 到最新 main** | 不等（contract_touch 与 C 的 README/templates/onSend/token-verify 区域无交集，但 main base 前进需吸收） |

## §4 架构设计（改动面 6 项）

### 4.1 类型分层（最小爆炸半径）

```ts
// src/content/db.ts
export interface Queryable {           // 新增：最小查询接口（tx 句柄与池同形）
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}
export interface ContentDb extends Queryable {}   // 不变：既有所有消费者零感知
export interface TransactionalContentDb extends ContentDb {   // 新增：事务能力端口
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
```

- `ContentDb` 本身**不变**（仍是 `{query}`）→ policy-store / drift / 其他测试的 inline ContentDb 实现零编译影响
- 只有需要事务的消费者（ops-app / ingestTransitionAndAudit）要求 `TransactionalContentDb`

### 4.2 生产实现（新文件 `src/db/transaction.ts`）

```ts
export function wrapPgPool(pool: PgPoolLike): TransactionalContentDb {
  return {
    query: (text, params) => pool.query(text, params),          // 非事务路径行为零变化
    async withTransaction(fn) {
      const client = await pool.connect();                       // 专用连接——朴素 BEGIN/COMMIT 不安全的根治点
      try {
        await client.query("BEGIN");
        const r = await fn({ query: (t, p) => client.query(t, p) });
        await client.query("COMMIT");
        return r;
      } catch (err) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackErr) { /* 记录日志，不遮盖原错误 */ }
        throw err;                                               // COMMIT 失败同样走此路径（ROLLBACK 安全）
      } finally {
        client.release();                                        // 任何路径必还连接，泄漏不可能
      }
    },
  };
}
```

`PgPoolLike = { query(...); connect(): Promise<{ query(...); release(): void }> }`（pg Pool 结构子集，可 fake）。

### 4.3 状态机（`src/review/state-machine.ts`）

- `transition(db: Queryable, ...)`：入参从 ContentDb 放宽为 Queryable（**SQL 与语义零改动**——CAS/RETURNING/review INSERT/投影 INSERT/DELETE 全部原样）
- 内部 fetchIngest 同步放宽

### 4.4 审核编排（`src/admin/ingest.ts`）

```ts
export async function ingestTransitionAndAudit(
  db: TransactionalContentDb, auditSink, ingestId, action, actor, reason?,
) {
  const { trackId } = await db.withTransaction(async (tx) => {
    const trackId = await fetchIngestTrackId(tx, ingestId);   // trackId 读取进事务（一致性读）
    await transition(tx, ingestId, action, actor, reason);    // 三步全在同一连接/事务
    return { trackId };
  });
  // —— COMMIT 之后 ——
  if (action === "approve" && trackId) await emitProvision(auditSink, { ingestId, trackId, actor });
  if ((action === "reject" || action === "revoke") && trackId) await emitRevoke(auditSink, { trackId, actor });
  return { trackId };
}
```

- 语义变化点：NOT_FOUND 现在也会在事务内抛出（SELECT 无行）→ 路由层 404 行为不变
- fetchIngestTrackId 入参放宽为 Queryable

### 4.5 接线（2 处）

- `src/ops-app.ts`：`BuildOpsAppOpts.db: TransactionalContentDb`；CLI 入口 `wrapPgPool(new Pool(...))` 替代手写字面量
- `test/integration/helpers.ts`：`createTestDb()` 返回类型升级，pg-mem 版 withTransaction = 直通（`fn(db)`，pg-mem 无事务语义——spike 实证，见 §8 Layer 2 注记）

### 4.6 不改清单

schema.ts / migrations / ingestCreate / policy-store / 队列页/详情页/tracks 页读路径 / 409/404 路由语义 / audit-sink 机制 / frozen 契约。

## §5 并发正确性论证（READ COMMITTED 充分性）

**场景 1：A approve 与 B revoke 并发（P1 原交错）**

1. A tx：BEGIN → CAS `UPDATE ingest SET state='approved' WHERE id AND state='pending' RETURNING id` → 命中，**该行加行锁（未提交）** → await 让出
2. B tx：BEGIN → CAS `UPDATE ... WHERE state='approved'` → 撞 A 的行锁，**阻塞等待**
3. A 恢复：INSERT review → INSERT tracks → COMMIT（释放锁）
4. B 解除阻塞：READ COMMITTED 下 UPDATE 被阻塞后**按最新已提交版本重检 WHERE 条件**（EPQ）→ 见 state='approved' → CAS 命中 → DELETE tracks（删掉 A 已提交的投影）→ COMMIT
5. 终态：`revoked + tracks 空`——P1 第三态（revoked+曲目在）不存在

**场景 2：B 先赢锁**

B 的 revoke 需要 state='approved'，而初始是 pending → B 的 CAS 本就 INVALID_TRANSITION（矩阵层拒绝，approve→revoke 之外的并发同理）。真正竞争对（approve vs reject 抢 pending）：输家 CAS 重检见 state 已非 pending → 0 行 → INVALID_TRANSITION → **ROLLBACK，review 行与投影零残留**。

**场景 3：崩溃窗口**

任何一步崩溃 → 未 COMMIT 的事务整体丢失（pg 恢复时回滚）→ 不再存在「状态改了、投影没写」的半提交态。

**为何不升隔离级别**：串行化由行锁天然提供（同 ingest 行的并发 UPDATE 排队），CAS 条件重检保证输家无副作用；SERIALIZABLE 会带来序列化失败重试复杂度，无额外收益。

**论证边界**：本论证依赖真 pg 的行锁与 EPQ 语义，pg-mem 无法模拟——故 §8 Layer 3 用真 pg 实测兜底。

## §6 错误处理

| 路径 | 行为 |
|---|---|
| 回调抛 NOT_FOUND / INVALID_TRANSITION | ROLLBACK + release + 原样抛出；路由层 404/409 语义不变 |
| 回调抛其他错（如 tracks INSERT 冲突） | ROLLBACK + release + 抛出（路由层 500，**无孤儿记录**——本专项附带收益） |
| ROLLBACK 自身失败（连接断） | 记录日志 + release + 抛**原错误**（不让回滚错误遮盖业务错误） |
| COMMIT 失败 | 进 catch → 尝试 ROLLBACK（COMMIT 失败后 ROLLBACK 安全）→ 抛原错误 |
| release | finally 保证，连接泄漏不可能（Layer 1 契约测试守护） |

## §7 audit 链时序

- emit 保持 COMMIT 后（§4.4）：失败/回滚的审核动作不进 audit——与现状行为一致（现状 throw 也不 emit），事务化后这是**保证**而非巧合
- audit target（trackId）在事务内读取（track_id 自 ingestCreate 后不可变，事务内读只是口径一致）
- AUDIT_SINK_PATH 默认空 → emit 静默 no-op（known hole 1 维持，不在本专项改）

## §8 测试策略（三层，分工明确）

### Layer 1 · wrapper 契约测试（fake pool，总是跑）——新文件 `test/unit/db-transaction.test.ts`

fake PgPoolLike 记录全部调用序列：
1. 成功路径：恰好一次 connect → BEGIN → 回调 queries（**全部经同一 client**）→ COMMIT → release
2. 回调抛错：→ ROLLBACK → release → 原错误透传
3. ROLLBACK 失败：原错误不丢 + release 仍被调
4. 连接亲和性：事务内任何 query 不经 pool.query 旁路（朴素 BEGIN/COMMIT 根因的反制断言）
5. 非事务 query() 仍走 pool.query（既有行为零变化）

### Layer 2 · pg-mem 功能/序列测试（总是跑）

- 既有 `test/unit/review-state.test.ts` 10 用例 + `test/integration/review-ui-acceptance.e2e.test.ts` 3 用例**不改动通过**（transition 入参放宽类型兼容）
- 新增记录型 double 断言：transition 三语句全部经 tx 句柄、无 pool 旁路
- ⚠️ **明示限制**：pg-mem 3.0.14 无事务语义——spike 实证（2026-08-06，脚本 /tmp/pgmem-tx-spike.cjs）：`pool.connect()`/BEGIN/CAS RETURNING 可用，但 ROLLBACK 不撤销（BEGIN→UPDATE→ROLLBACK 后 state 仍为改后值）、事务内写对旁路查询立即可见。故**本层不验回滚语义**，回滚由 Layer 1（契约）+ Layer 3（真 pg）担当

### Layer 3 · 真 pg 并发验收（testcontainers；Docker 缺失诚实 skip）——新文件 `test/integration/review-projection-tx.e2e.test.ts`

- 模式照 `test/db/seed.test.ts` 先例：`@testcontainers/postgresql ^12.0.4`（已在 devDependencies）+ `dockerAvailable()` skip 门
- **Case A（P1 回归）**：同一 ingest 并发 approve+revoke，随机延迟跑 ≥20 轮；断言终态 ∈ {approved+tracks 有一行, revoked+tracks 无行}，**绝不出现第三态（revoked+tracks 有行=P1）**；review 表行数=成功转换数
- **Case B（CAS 竞争零残留）**：同一 pending ingest 并发 approve+reject → 恰好一个 200 一个 409；review 表恰一行；tracks 与终态一致
- **Case C（断连零残留）**：事务中途强断 client（模拟崩溃）→ 重查 DB 状态无变化（pg 自动回滚未提交事务）
- 定位：本层=验收所需「真并发证据」；SDD verification 阶段本机跑（Docker 29.6.1 可用已探测），无 Docker 环境诚实 skip（known hole 同源先例）

## §9 验收标准（可度量）

1. `pnpm test` 零回归：基线 269 passed / 29 skipped 只增不减；4 个既有环境依赖失败文件集合不变（Docker/testcontainers、真 IAM seed、device-hub 直连）
2. Layer 1 全 GREEN（5 类契约用例）
3. Layer 2 既有 13 用例不改通过 + 新增旁路断言 GREEN
4. Layer 3 本机 Docker 跑：Case A ≥20 轮零第三态 / Case B 恰一成功 / Case C 零残留
5. `pnpm build`（tsc）exit 0
6. Surgical scope：diff 限于 §4 File Structure 清单（新增 3：`src/db/transaction.ts` + 测试文件 2；改动 5：`content/db.ts` / `state-machine.ts` / `admin/ingest.ts` / `ops-app.ts` / `test/integration/helpers.ts`）

## §10 known holes（预期，PR 如实标注）

1. 真 pg 层证据依赖 Docker——CI 无 Docker 环境诚实 skip（known hole 8 同源先例）
2. pg-mem 3.0.14 无事务语义（spike 实证）——Layer 2 不验回滚，靠 Layer 1+3 担当；若未来 pg-mem 升级支持事务可回收此 hole
3. 多进程部署场景**设计上覆盖**（DB 行锁）但本专项不实测（sim 单进程；未来多进程部署时另立集成测试）

## §11 not-architecture-impact 声明（预判，PR 时终判）

touched files（预期）：`src/content/db.ts`（port 扩展）/ `src/db/transaction.ts`（新增）/ `src/review/state-machine.ts`（入参放宽）/ `src/admin/ingest.ts`（事务包裹）/ `src/ops-app.ts`（db 类型+CLI 接线）/ `test/integration/helpers.ts`（适配器）/ `test/unit/db-transaction.test.ts`（新增）/ `test/integration/review-projection-tx.e2e.test.ts`（新增）

negative-claim 证据：
- 不触 frozen 契约（shared-protocols schemas / *-envelope.schema.json / device-hub contract.h 零触碰，全在 sibling AgentOS 仓）
- 不改链路协议（envelope shape / auth 层 / 契约字段零变化）
- 不跨 repo、不改 Phase gate、不加子系统/身份域
- 属 content-backend **仓内** port 级内部契约变更 + bug 根治，归「单 PR 实现/局部重构」不触发类

## §12 plan 阶段交接项（非未决决策，属实现细化）

- testcontainers Postgres 镜像版本与 schema 初始化方式（drizzle migrations vs raw DDL，照 seed.test.ts 现状）
- Case A 随机延迟参数与轮数最终值
- `PgPoolLike` 类型导出位置（transaction.ts 内 vs content/db.ts）
- Layer 2 记录型 double 的具体实现位置（helpers vs 测试文件内）
- SDD 开工门禁：确认窗口 C T2/T3 merged → `git fetch` → worktree rebase 到最新 main
