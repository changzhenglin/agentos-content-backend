// token-verify.e2e.test.ts — #2 T7 三 service docker e2e（IAM + ops + content-backend）
// 前置：docker compose -f docker-compose.e2e.yml up -d --build + seed 已跑
//   docker compose run --rm -v /tmp:/tmp content-backend pnpm exec tsx scripts/e2e-token-verify-seed.ts
// 跑：pnpm exec vitest run test/integration/token-verify.e2e.test.ts
//
// 7 场景（Fold-12 + brief）：
// 1. v2 有效 token + bound → 200
// 2. 解绑后重放 → 403 device_not_bound（psql UPDATE deleted_at）
// 3. 篡改 token 签名 → 401 invalid_token
// 4. v1 envelope（无 version）→ 匿名 200
// 5. v2 user_token=null → 匿名 200
// 6. bound=false 设备 → 403
// 7. version=3 → 400 invalid_envelope
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const CB = process.env.CB_URL ?? "http://localhost:3001";
const COMPOSE_FILE = "docker-compose.e2e.yml";

let token: string;
let endUserId: string;
let deviceId: string;

beforeAll(() => {
  const raw = readFileSync("/tmp/e2e-seed.json", "utf8");
  const seed = JSON.parse(raw) as { token: string; endUserId: string; deviceId: string };
  token = seed.token;
  endUserId = seed.endUserId;
  deviceId = seed.deviceId;
});

/** content_query 请求体（#2 v2 envelope shape，对齐 T6 集成测） */
function v2Body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    kind: "content_query",
    query: { keywords: ["Sim"] },
    user_token: token,
    device_id: deviceId,
    ...overrides,
  };
}

async function postContent(body: Record<string, unknown>): Promise<{ status: number; json: () => Promise<unknown> }> {
  const r = await fetch(`${CB}/content_query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-caller-identity": "device-hub",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: () => r.json() };
}

describe("token-verify 三 service e2e", () => {
  it("1. v2 有效 token + bound → 200", async () => {
    const r = await postContent(v2Body());
    expect(r.status).toBe(200);
  });

  it("2. 解绑后重放 → 403 device_not_bound", async () => {
    // psql 解绑（soft delete end_user_device_groups，对齐 Fold-12）
    // host 无 psql → docker compose exec 在 postgres 容器内跑
    execSync(
      `docker compose -f ${COMPOSE_FILE} exec -T postgres ` +
        `psql -U agentos -d agentos_ops -c ` +
        `"UPDATE end_user_device_groups SET deleted_at = NOW() ` +
        `WHERE end_user_id = '${endUserId}' ` +
        `AND device_group_id = (SELECT id FROM device_groups WHERE name = 'e2e-group');"`,
      { stdio: "pipe" },
    );
    const r = await postContent(v2Body());
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error_code?: string };
    expect(body.error_code).toBe("DEVICE_NOT_BOUND");
  });

  it("3. 篡改 token 签名 → 401 invalid_token", async () => {
    // 改 JWT 签名末尾 4 字符
    const tampered = token.slice(0, -4) + "AAAA";
    const r = await postContent(v2Body({ user_token: tampered }));
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error_code?: string };
    expect(body.error_code).toBe("INVALID_TOKEN");
  });

  it("4. v1 envelope（无 version）→ 匿名 200", async () => {
    // 无 version 字段 → parseRequestEnvelope 判 v1 → 匿名短路 → handler 正常
    const r = await postContent({
      kind: "content_query",
      query: { keywords: ["Sim"] },
    });
    expect(r.status).toBe(200);
  });

  it("5. v2 user_token=null → 匿名 200", async () => {
    const r = await postContent(v2Body({ user_token: null }));
    expect(r.status).toBe(200);
  });

  it("6. bound=false 设备 → 403", async () => {
    // device_id 不在 devices 表 → join 无行 → bound=false
    const r = await postContent(v2Body({ device_id: "not-bound-dev" }));
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error_code?: string };
    expect(body.error_code).toBe("DEVICE_NOT_BOUND");
  });

  it("7. version=3 → 400 invalid_envelope", async () => {
    const r = await postContent({
      version: 3,
      kind: "content_query",
      query: {},
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error_code?: string };
    expect(body.error_code).toBe("INVALID_ENVELOPE");
  });
});
