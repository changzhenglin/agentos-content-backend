// admin-ui.e2e.test.ts — T7 审核 UI 端到端（SSR+htmx+session+ingest I2 边界校验）。
// 9 用例覆盖：GET login / ingest 400 / ingest 200 / approve+audit+tracks / reject /
// operator 403 / 未登录 401 / GET ingests queue。
//
// raw_metadata camelCase 对齐 state-machine.ts（durationMs/coverUrl/isrc/regionPolicy/album），
// fold codex P1#7/eng I2。audit target=trackId 非空（fold eng I1）。
// htmx HTML partial 非 JSON（approve/reject/revoke 返 partial，ingest 400 回填 form）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { createTestDb } from "./helpers.js";
import { createAuditSink } from "../../src/audit/audit-sink.js";
import { rmSync, readFileSync } from "node:fs";

let app: any, db: any;
const auditPath = ".tmp-audit-admin.jsonl";
beforeAll(async () => {
  db = createTestDb();
  app = await buildOpsApp({
    db,
    auditSink: createAuditSink(auditPath),
    adminToken: "dev-admin",
    operatorToken: "dev-op",
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

// raw_metadata camelCase 对齐 state-machine.ts（durationMs/coverUrl/isrc/regionPolicy/album）
const GOOD = {
  title: "A",
  artist: "B",
  durationMs: 1000,
  format: "mp3",
  bitrate: 128000,
  license: "CC",
};

describe("admin UI e2e", () => {
  it("GET /admin/login 渲染登录页（fold design C3）", async () => {
    const r = await app.inject({ method: "GET", url: "/admin/login" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("token");
  });

  it("ingest 缺 title → 400 + HTML partial 含错误（I2 + design I3 htmx 回填）", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: "self:t99", raw_metadata: { artist: "X", durationMs: 1000 } },
      headers: { cookie },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("missing title");
  });

  it("ingest 完整 → 200 + pending（camelCase）", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: "self:t1", raw_metadata: GOOD, audioObjectKey: "k1" },
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe("pending");
  });

  it("approve → emit provision audit（target=trackId 非空，fold eng I1）+ tracks 入库（fold codex P2）", async () => {
    const cookie = await login("dev-admin");
    const ing = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: {
        track_id: "self:t2",
        raw_metadata: { ...GOOD, title: "C", artist: "D", durationMs: 2000 },
        audioObjectKey: "k2",
      },
      headers: { cookie },
    });
    const id = ing.json().id;
    const r = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/approve`,
      headers: { cookie },
    });
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

  it("reject → 200 + HTML partial + emit revoke audit（fold codex P1#4：spec §8.3 reject 也 emit revoke）", async () => {
    const cookie = await login("dev-admin");
    const ing = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: "self:t3", raw_metadata: GOOD, audioObjectKey: "k3" },
      headers: { cookie },
    });
    const r = await app.inject({
      method: "POST",
      url: `/admin/ingest/${ing.json().id}/reject`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    // spec §8.3 audit matrix：rejected/revoked → revoke；reject 须 emit revoke（target=trackId 非空）
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const ev = JSON.parse(lines[lines.length - 1]);
    expect(ev.eventType).toBe("revoke");
    expect(ev.target).toBe("self:t3");
  });

  it("operator 不能 ingest（admin only）→ 403", async () => {
    const cookie = await login("dev-op");
    const r = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      payload: { track_id: "self:t4", raw_metadata: GOOD },
      headers: { cookie },
    });
    expect(r.statusCode).toBe(403);
  });

  it("未登录 → 401", async () => {
    const r = await app.inject({ method: "POST", url: "/admin/ingest", payload: {} });
    expect(r.statusCode).toBe(401);
  });

  it("GET /admin/ingests 渲染 pending queue（fold design C3）", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({
      method: "GET",
      url: "/admin/ingests",
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("htmx");
  });

  it("ingest form-urlencoded raw_metadata JSON 字符串 → 200（真实浏览器路径，fix #1）", async () => {
    const cookie = await login("dev-admin");
    // htmx form 提交：content-type application/x-www-form-urlencoded，
    // raw_metadata 为 JSON 字符串（Fastify 解析后仍为 string），handler 须 JSON.parse 后再校验。
    const formBody = `track_id=self:t50&raw_metadata=${encodeURIComponent(JSON.stringify(GOOD))}&audioObjectKey=k50`;
    const r = await app.inject({
      method: "POST",
      url: "/admin/ingest",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: formBody,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe("pending");
  });

  it("approve 不存在 id → 404 NOT_FOUND（fix #2，不再 500）", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({
      method: "POST",
      url: `/admin/ingest/ing_nonexistent_xyz/approve`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error_code).toBe("NOT_FOUND");
  });
});
