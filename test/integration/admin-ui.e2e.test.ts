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
    presignFn: async (_key: string) => ({
      url: "https://example.test/audio?X-Amz-Signature=abc123",
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
});
