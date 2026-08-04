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
