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

function fakePool(opts: { failClientQuery?: string[] } = {}) {
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
          if (opts.failClientQuery?.includes(text)) {
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
    const { pool, released } = fakePool({ failClientQuery: ["ROLLBACK"] });
    const db = wrapPgPool(pool);
    await expect(
      db.withTransaction(async () => {
        throw new Error("biz-error");
      }),
    ).rejects.toThrow("biz-error");
    expect(released.length).toBe(1);
  });

  it("COMMIT 失败：尝试 ROLLBACK + 抛原错误 + release", async () => {
    const { pool, clients, released } = fakePool({ failClientQuery: ["COMMIT"] });
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

  it("connect 失败：原错误透传且回调不执行", async () => {
    const connectError = new Error("connect-unavailable");
    let fnRan = false;
    const pool: PgPoolLike = {
      async query() {
        return { rows: [] };
      },
      async connect() {
        throw connectError;
      },
    };
    const db = wrapPgPool(pool);

    await expect(
      db.withTransaction(async () => {
        fnRan = true;
      }),
    ).rejects.toBe(connectError);
    expect(fnRan).toBe(false);
  });

  it("非事务 query() 仍走 pool.query（既有行为零变化）", async () => {
    const { pool, poolQueries, clients } = fakePool();
    const db = wrapPgPool(pool);
    await db.query("SELECT 2");
    expect(poolQueries).toEqual(["SELECT 2"]);
    expect(clients.length).toBe(0); // 未动用 connect
  });

  it("BEGIN 失败：回调未执行，release 仍被调，原错误透传（fold codex P2）", async () => {
    const { pool, released } = fakePool({ failClientQuery: ["BEGIN"] });
    const db = wrapPgPool(pool);
    let fnRan = false;
    await expect(
      db.withTransaction(async () => {
        fnRan = true;
      }),
    ).rejects.toThrow("boom:BEGIN");
    expect(fnRan).toBe(false); // BEGIN 失败时回调不得执行
    expect(released.length).toBe(1);
  });

  it("COMMIT+ROLLBACK 双失败：原错误不丢，release 仍被调（fold codex P2）", async () => {
    const { pool, released } = fakePool({ failClientQuery: ["COMMIT", "ROLLBACK"] });
    const db = wrapPgPool(pool);
    await expect(
      db.withTransaction(async (tx) => {
        await tx.query("SELECT 1");
      }),
    ).rejects.toThrow("boom:COMMIT"); // 原错误透传，ROLLBACK 失败不遮盖
    expect(released.length).toBe(1);
  });
});
