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
import { wrapPgPool, type PgPoolLike } from "../../src/db/transaction.js";

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

  it("Case A：确定性 barrier 交错——A 过 CAS 后暂停，B revoke 完整执行，A 恢复（P1 回归判别器）", async () => {
    // fold codex 跨厂商 P1：随机并发绝大多数落入「revoke 409」分支，无判别力；
    // 记录型 PgPoolLike 钩住 approve 的 CAS UPDATE：A 过 CAS（未提交）后暂停，
    // 此刻放 B revoke 完整执行，再恢复 A。
    // 事务实现：B 读 pending（A 未提交不可见）→ 409，终态 approved + 投影在；
    // 若退回非事务三语句：A 的 CAS 自动提交，B 读到 approved 完成 revoke → P1 第三态，断言失败。
    const id = "ingbar";
    const trackId = "self:bar";
    await seedIngest(id, trackId, "pending");
    let notifyAAtCas: () => void = () => {};
    const aAtCas = new Promise<void>((r) => {
      notifyAAtCas = r;
    });
    let notifyBDone: () => void = () => {};
    const bDone = new Promise<void>((r) => {
      notifyBDone = r;
    });
    let casHookArmed = true;
    const instrumented: PgPoolLike = {
      query: (text, params) => pool.query(text, params as any[]),
      connect: async () => {
        const c = await pool.connect();
        return {
          query: async (text: string, params?: unknown[]) => {
            const r = await c.query(text, params as any[]);
            if (casHookArmed && text.startsWith("UPDATE ingest SET state")) {
              casHookArmed = false;
              notifyAAtCas(); // 通知 B 出发
              await bDone; // A 暂停：等 B 完整执行完（模拟 await 让出点交错）
            }
            return r;
          },
          release: () => c.release(),
        };
      },
    };
    const barApp = await buildOpsApp({
      db: wrapPgPool(instrumented),
      adminToken: "bar-a",
      operatorToken: "bar-o",
    });
    const lr = await barApp.inject({
      method: "POST",
      url: "/admin/login",
      payload: { token: "bar-o" },
    });
    const sc = lr.headers["set-cookie"];
    const barCookie = Array.isArray(sc) ? sc[0] : sc;
    const apPromise = barApp.inject({
      method: "POST",
      url: `/admin/ingest/${id}/approve`,
      headers: { cookie: barCookie },
    });
    await aAtCas; // A 已执行 CAS（未提交）并暂停
    const rv = await barApp.inject({
      method: "POST",
      url: `/admin/ingest/${id}/revoke`,
      headers: { cookie: barCookie },
    });
    notifyBDone(); // 放行 A 继续
    const ap = await apPromise;
    expect(rv.statusCode).toBe(409); // B 读 pending（A 未提交）→ 矩阵拒绝
    expect(ap.statusCode).toBe(200);
    const t = await terminal(id, trackId);
    expect(t.state).toBe("approved");
    expect(t.trackCount).toBe(1);
    expect(t.reviewCount).toBe(1);
    await barApp.close();
  });

  it("Case A2：approve/revoke 随机并发巡逻——P1 第三态绝不出现（20 轮，统计巡逻层）", async () => {
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

  it("Case D：真实三步路径中途失败全回滚（tracks PK 冲突）", async () => {
    // fold codex 跨厂商 P2：真 pg 层验本专项声称闭合的真实路径，非手写 UPDATE 通用回滚。
    // tracks.track_id 已存在 → approve 的投影 INSERT 撞 PK 冲突 → 整个事务回滚：
    // ingest 仍 pending、review 0 行、tracks 不变（spec §1.2 附带收益变实测保证）。
    await seedIngest("ingd", "self:dup", "pending");
    await pool.query(
      "INSERT INTO tracks (track_id, title, artist, duration_ms, audio_object_key, format, bitrate, license) VALUES ('self:dup','X','Y',1,'k','mp3',128,'CC')",
    );
    const ap = await app.inject({
      method: "POST",
      url: "/admin/ingest/ingd/approve",
      headers: { cookie: opCookie },
    });
    expect(ap.statusCode).toBe(500); // PK 冲突非 NOT_FOUND/INVALID_TRANSITION，透传 500
    const st = await pool.query("SELECT state FROM ingest WHERE id='ingd'");
    expect(String(st.rows[0].state)).toBe("pending"); // CAS 已回滚
    const rv = await pool.query("SELECT count(*)::int AS c FROM review WHERE ingest_id='ingd'");
    expect(Number(rv.rows[0].c)).toBe(0); // review 已回滚
    const tr = await pool.query("SELECT count(*)::int AS c FROM tracks WHERE track_id='self:dup'");
    expect(Number(tr.rows[0].c)).toBe(1); // 原发布记录不受影响
  });
});
