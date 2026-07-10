// e2e-token-verify-seed.ts — #2 T7 e2e seed：IAM register/login 拿 token + psql 直插 ops DB seed 绑定。
// Fold-12：主路径用 psql 直插 ops DB（content-backend 持 service token 非 user JWT 无权调 ops 绑定 API）。
// 跑在 content-backend 容器内（docker compose run --rm -v /tmp:/tmp content-backend pnpm exec tsx scripts/e2e-token-verify-seed.ts）。
// 输出写 fixture 文件 /tmp/e2e-seed.json（非 stdout，避 docker run stdout 污染 JSON.parse）。
//
// IAM register body（实际 shape，非 brief 旧版 email/password）：
//   { identity: { type: 'email', value: 'e2e@test.local' }, password: 'Passw0rd!' }
// IAM register 响应：{ access_token, refresh_token, end_user_id }
// IAM login 响应：{ access_token, refresh_token }（无 end_user_id → 解 JWT sub）
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const IAM_BASE = process.env.IAM_BASE_URL ?? "http://iam:8080";
const PG_CONN = process.env.PG_CONN ?? "postgres://agentos:agentos@postgres:5432/agentos_ops";

// UUID 格式校验（防注入 + ops end_user_id 列是 uuid 类型）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function psql(sql: string): void {
  // -v ON_ERROR_STOP=1 遇错即退（非零 exit）
  execSync(`psql "${PG_CONN}" -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`, {
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  const identity = { type: "email" as const, value: "e2e@test.local" };
  const password = "Passw0rd!";

  // 1. IAM register（如已注册 409 → login fallback）
  let accessToken: string;
  let regRes = await fetch(`${IAM_BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, password }),
  });
  if (regRes.status === 201 || regRes.status === 200) {
    const data = (await regRes.json()) as { access_token: string };
    accessToken = data.access_token;
    console.log("[seed] IAM register OK");
  } else if (regRes.status === 429) {
    // rate limit → 短暂等待重试一次
    console.log("[seed] IAM register rate limited, waiting 5s...");
    await new Promise((r) => setTimeout(r, 5000));
    const loginRes = await fetch(`${IAM_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity, password }),
    });
    if (!loginRes.ok) throw new Error(`IAM login failed: ${loginRes.status}`);
    accessToken = ((await loginRes.json()) as { access_token: string }).access_token;
    console.log("[seed] IAM login OK (after rate limit)");
  } else if (regRes.status === 409) {
    // 已注册 → login
    const loginRes = await fetch(`${IAM_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity, password }),
    });
    if (!loginRes.ok) throw new Error(`IAM login failed: ${loginRes.status}`);
    accessToken = ((await loginRes.json()) as { access_token: string }).access_token;
    console.log("[seed] IAM login OK (already registered)");
  } else {
    const txt = await regRes.text();
    throw new Error(`IAM register unexpected status ${regRes.status}: ${txt}`);
  }

  // 2. 解 JWT sub 取 end_user_id（register 响应有 end_user_id 但 login 无；统一解 JWT）
  const [, payloadB64] = accessToken.split(".");
  const claims = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8"),
  ) as { sub: string };
  const endUserId = claims.sub;
  if (!UUID_RE.test(endUserId)) {
    throw new Error(`end_user_id not valid UUID: ${endUserId}`);
  }
  const deviceId = "dev-e2e-1";
  console.log(`[seed] end_user_id=${endUserId} device_id=${deviceId}`);

  // 3. psql 直插 ops DB（device_groups → devices → end_user_device_groups）
  //    schema 来自 agentos-ops-platform/web/lib/db/schema.ts（drizzle migrate 建表）
  //    列名 snake_case（drizzle 第二参数映射）
  psql(`INSERT INTO device_groups (name) VALUES ('e2e-group') ON CONFLICT (name) DO NOTHING;`);
  psql(
    `INSERT INTO devices (device_id, device_group_id, lifecycle_state) ` +
      `VALUES ('${deviceId}', (SELECT id FROM device_groups WHERE name='e2e-group'), 'active') ` +
      `ON CONFLICT (device_id) DO NOTHING;`,
  );
  psql(
    `INSERT INTO end_user_device_groups (end_user_id, device_group_id, role) ` +
      `VALUES ('${endUserId}', (SELECT id FROM device_groups WHERE name='e2e-group'), 'owner') ` +
      `ON CONFLICT DO NOTHING;`,
  );

  // 4. 写 fixture 文件（非 stdout）
  writeFileSync(
    "/tmp/e2e-seed.json",
    JSON.stringify({ token: accessToken, endUserId, deviceId }),
  );
  console.log("[seed] done -> /tmp/e2e-seed.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
