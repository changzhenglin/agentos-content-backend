// review-ui-layout-swap.e2e.test.ts — T2 follow-up ③（PR#12 Eng final Recommendation）：
// 1. layout 公共 partial 抽取（head htmx responseHandling + nav）——三页布局回归锁定，抽取后不丢；
// 2. 审核操作成功响应改 #detail-main partial swap：
//    旧行为=POST approve/reject/revoke 成功返整页 HTML（doctype+head+nav），
//    htmx swap 进既有页面 → 嵌套文档/错位刷新；
//    新行为=返 #detail-main 内部内容 partial（无 doctype/head/nav），
//    详情页操作按钮 hx-target="#detail-main"，原地刷新。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { createTestDb } from "./helpers.js";

let app: any, db: any;

beforeAll(async () => {
  db = createTestDb();
  app = await buildOpsApp({
    db,
    adminToken: "dev-admin",
    operatorToken: "dev-op",
    presignFn: async (_key: string) => ({
      url: "https://example.test/audio?X-Amz-Signature=swap-test",
    }),
  });
});

afterAll(async () => {
  await app.close();
});

async function login(token: string) {
  const r = await app.inject({ method: "POST", url: "/admin/login", payload: { token } });
  const sc = r.headers["set-cookie"];
  return Array.isArray(sc) ? sc[0] : sc;
}

const META = {
  title: "Swap",
  artist: "Target",
  durationMs: 4000,
  format: "mp3",
  bitrate: 192000,
  license: "CC-BY",
};

async function createIngest(cookie: string, suffix: string) {
  const trackId = `self:swap-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    payload: { track_id: trackId, raw_metadata: META, audioObjectKey: `audio/${suffix}` },
    headers: { cookie },
  });
  return { trackId, id: r.json().id };
}

describe("layout partial 抽取：页面布局不回归", () => {
  it("队列页仍含 htmx responseHandling + 导航", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({ method: "GET", url: "/admin/ingests", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("responseHandling");
    expect(r.body).toContain("待审核");
    expect(r.body).toContain("已发布曲目");
  });

  it("tracks 页仍含 htmx responseHandling + 导航", async () => {
    const cookie = await login("dev-admin");
    const r = await app.inject({ method: "GET", url: "/admin/tracks", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("responseHandling");
    expect(r.body).toContain("待审核");
    expect(r.body).toContain("已发布曲目");
  });

  it("GET 详情页为整页：layout + #detail-main 容器包裹状态与操作区", async () => {
    const cookie = await login("dev-admin");
    const { id } = await createIngest(cookie, "page");
    const r = await app.inject({
      method: "GET",
      url: `/admin/ingest/${id}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<!doctype html>");
    expect(r.body).toContain("responseHandling");
    expect(r.body).toContain("已发布曲目");
    // #detail-main 容器存在且包裹状态/操作内容（swap 锚点）
    const mainStart = r.body.indexOf('<div id="detail-main">');
    expect(mainStart).toBeGreaterThan(-1);
    expect(r.body.indexOf("状态：", mainStart)).toBeGreaterThan(-1);
    expect(r.body.indexOf(`hx-post="/admin/ingest/${id}/approve"`, mainStart)).toBeGreaterThan(-1);
  });
});

describe("审核操作成功响应 = #detail-main partial（非整页）", () => {
  it("详情页 approve/reject/revoke 的 swap 目标均为 #detail-main", async () => {
    const cookie = await login("dev-admin");
    const { id } = await createIngest(cookie, "target");
    const r = await app.inject({
      method: "GET",
      url: `/admin/ingest/${id}`,
      headers: { cookie },
    });
    expect(r.body).toContain(`hx-post="/admin/ingest/${id}/approve"`);
    // pending 页同时含 approve 按钮与 reject 表单，两者 target 均须是 #detail-main
    expect(r.body).not.toContain('hx-target="body"');
    expect(r.body).toContain('hx-target="#detail-main"');
  });

  it("approve 成功 → 200 partial：含已审核状态，无 doctype/head/nav（swap 进 #detail-main 不嵌套）", async () => {
    const cookie = await login("dev-admin");
    const { id } = await createIngest(cookie, "ok");
    const r = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/approve`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("已审核");
    // partial 无 layout：htmx innerHTML swap 进 #detail-main 不产生嵌套文档/重复 nav
    expect(r.body).not.toContain("<!doctype html>");
    expect(r.body).not.toContain("<nav>");
    expect(r.body).not.toContain("responseHandling");
  });

  it("reject 带 reason 成功 → 200 partial：含已拒状态 + 理由，无 layout", async () => {
    const cookie = await login("dev-admin");
    const { id } = await createIngest(cookie, "rej");
    const r = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/reject`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ reason: "swap partial check" }).toString(),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("已拒");
    expect(r.body).toContain("swap partial check");
    expect(r.body).not.toContain("<!doctype html>");
    expect(r.body).not.toContain("<nav>");
  });

  it("partial 内含试听懒加载区（approve 后续看试听不失效）", async () => {
    const cookie = await login("dev-admin");
    const { id } = await createIngest(cookie, "audio");
    const r = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/approve`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`hx-get="/admin/ingest/${id}/audio"`);
  });
});

describe("审核操作错误 partial 的 swap 目标对齐 #detail-main", () => {
  it("reason 超长 400 → 重试表单 target=#detail-main（重试成功后同锚点刷新）", async () => {
    const cookie = await login("dev-admin");
    const { id } = await createIngest(cookie, "long");
    const r = await app.inject({
      method: "POST",
      url: `/admin/ingest/${id}/reject`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ reason: "x".repeat(1001) }).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("reason exceeds 1000 chars");
    expect(r.body).not.toContain('hx-target="body"');
    expect(r.body).toContain('hx-target="#detail-main"');
  });
});
