---
title: content-backend 终端用户 token 校验 SDD 设计
date: 2026-07-09
status: design
supersede: []
not-architecture-impact:
  - 本 spec 不改 envelope schema 形状（envelope v2 `user_token`/`device_id`/`version` 已由 PR#61 `78c8274` 落地，本 spec 仅消费）
  - 不改 frozen 契约（`shared-protocols/schemas/*.schema.json` 顶层 / `device-hub/include/agentos/hub/contract.h` envelope 顶层 / `*-envelope.schema.json`）
  - 不新增子系统/系统边界/链路协议——content-backend 是既有子系统，本 spec 在其内加 auth 模块
  - touched files：content-backend repo `src/auth/jwt-verify.ts`(新) / `src/auth/ops-lookup.ts`(新) / `src/auth/token-verify-hook.ts`(新) / `src/envelope.ts`(扩 version 解析) / `src/env.ts`(扩 env) / `src/index.ts`(挂 preHandler) / `test/**`(新) / `docker-compose.e2e.yml`(加 service) / `docs/superpowers/specs/2026-07-09-...`(本 spec)
  - 不命中：新增/改系统边界或身份域 / 新增/改子系统 / 新增/改跨 repo sibling / 改链路协议 / 改 Phase D gate / 改 frozen 契约
---

# content-backend 终端用户 token 校验 SDD 设计

> IAM 依赖前置 #2（窗口C）。落地 IAM spec §6.3 step3（JWT 自验）+ step4（token 绑设备校验）于 content-backend 侧。region(step5)/entitlement(step6)/mTLS caller(step2) 本 sim 阶段 stub defer。

## 1. 背景与范围

### 1.1 上下文

IAM spec（`docs/superpowers/specs/2026-07-06-iam-user-mgmt-design.md` §6.3）定义 content-backend 收 content_request envelope 后 7 步校验。本 SDD 落地其中 sim 阶段可真实实现的部分：

| step | 语义 | 本任务 |
|---|---|---|
| 1 | 收 envelope v2，取 user_token + device_id | ✅ 真实（envelope v2 已 merged PR#61） |
| 2 | mTLS caller binding（caller=device-hub 服务身份，C5 硬前置） | ⏸ stub defer（#6 device-hub/transport SDD，sim no-mTLS 沿用现有 header 白名单） |
| 3 | JWT 自验（JWKS 验签 + iss/aud/exp/nbf/kid + alg RS256）→ end_user_id | ✅ 真实 |
| 4 | token 绑设备校验（C3，查 ops `end_user_device_group`）防跨设备 replay | ✅ 真实（调 ops `/api/internal/bindings` lookup，#4 已 merged PR#15） |
| 5 | region 校验（C4，从 end_user.region 取，非 X-Region header） | ⏸ stub defer（JWT 无 region claim、ops lookup 不返 region，真校验需跨 repo 协调，独立子项） |
| 6 | entitlement 校验（C17，查订阅/付费） | ⏸ stub defer（§5.2 计费系统前置，capability_mode=mock 放行） |
| 7 | audit emit `^end_user:<id>`（C10） | ✅ 真实 |

### 1.2 范围边界

**归本任务**：
- envelope v2 解析（按 version 路由 v1/v2，v2 取 `user_token`+`device_id`）
- JWT 自验模块（jose + `createRemoteJWKSet` + kid 精确路由 + iss/aud/exp/nbf/alg RS256）
- ops lookup 调用模块（`GET /api/internal/bindings`，service-auth `x-service-token`）
- token-verify fastify preHandler（编排 v2 解析→匿名短路→JWT→lookup→注入 endUser）
- 401/403/503 失败语义分段
- audit emit `^end_user:<id>`
- env 扩展（`IAM_JWKS_URL`/`IAM_JWT_ISSUER`/`IAM_JWT_AUDIENCE`/`OPS_LOOKUP_URL`/`OPS_LOOKUP_TOKEN`/`CAPABILITY_MODE`）
- vitest unit + 三 service docker-compose e2e（content-backend + ops + IAM）

**defer（文档化，非阻塞）**：
- mTLS caller binding（#6，device-hub/transport SDD，窗口A）
- device-hub forwarding（#5，获/存 user_token + 附入 envelope，窗口A）
- region 真校验（需跨 repo 协调：JWT 加 region claim / IAM 内部端点 / ops lookup 扩返 region，三选一独立子项）
- entitlement/billing 真系统（#7，§5.2 计费系统）
- ops lookup 结果缓存（sim 不缓存，真系统按 stale 风险评估）
- JWKS per-request DB 查询 perf（IAM 侧 60s 缓存已存在）
- IAM 多 aud 改造（D1，ops 切验 `device-mgmt-api`）
- cloud-ext HMAC caller-auth（3f PR#63，独立）

### 1.3 依赖状态

- envelope v2 schema ✅ merged（PR#61 `78c8274`，`shared-protocols/schemas/content-request-transport-envelope.schema.json`）
- ops `/api/internal/bindings` lookup + service-auth ✅ 已实现（#4 PR#15 `764d6ce`，`web/app/api/internal/bindings/route.ts` + `web/lib/service-auth.ts`）
- IAM JWKS + token 签发 ✅ 已实现（sibling 1.0+1.1 `7ccc79f`，`src/token/access.ts` + `src/server.ts:32` `GET /.well-known/jwks.json`）
- content-backend 侧 ❌ 全部待 SDD（本任务）

## 2. 架构与数据流

```
device-hub/cloud-ext ──POST /content_{query|match|stream|lyrics|metadata}──► content-backend App1 (:3001)
   envelope v2: {version:2, kind, request, secret_handle?, user_token, device_id}

  ┌─────────────────────────── buildServer (src/index.ts) ──────────────────────────┐
  │  [preHandler 链，每 content_* 路由共享]                                           │
  │   1. normalizeInboundCaller (现有, header X-Caller-Identity 白名单, sim caller) │
  │   2. receiveAndAuthorize (现有, secret_handle + caller×source 矩阵, transport)  │
  │   3. ★ token-verify-hook (新增 preHandler, content 层)                          │
  │      └─ parseRequestEnvelope(version 路由)                                       │
  │           ├─ version=1 或 user_token=null  → 匿名短路 (self_hosted, endUser=null)│
  │           └─ version=2 + user_token≠null:                                        │
  │                a. verifyUserToken(user_token) → {end_user_id, jti}  (401 on fail)│
  │                b. lookupDeviceBinding(end_user_id, device_id) → {bound,...}      │
  │                   (403 if !bound, 503 if down)                                   │
  │                c. region/entitlement stub (CAPABILITY_MODE=mock 放行 + log)      │
  │                d. 注入 req.endUser = {id, deviceId, role}                        │
  │   4. resolveProviderPath / authorizeBackendType / capabilityFilter / handle (现有)│
  └──────────────────────────────────────────────────────────────────────────────────┘
```

**分层原则**：`receiveAndAuthorize`（transport 层：谁的服务身份能调）与 `token-verify-hook`（content 层：哪个终端用户+哪台设备）正交，各管一层，失败语义独立。

**执行顺序 sim 偏离（D7，plan-review fold 三路共识）**：spec §2 图理想序为 caller-first（normalizeInboundCaller/receiveAndAuthorize → token-verify），但实现中 token-verify 挂为 fastify `preHandler`（handler 前跑），`receiveAndAuthorize` 仍在 route handler 内 inline（后跑），实际序为 token-verify → receiveAndAuthorize。**sim 阶段接受此偏离**：sim no-mTLS 下 `X-Caller-Identity` header 可伪造，caller-first 不带来真实安全（caller 白名单仅 sim 占位）；真实 caller 绑定由 mTLS #6 落地时 enforced 正序。本 spec 不重构现有 inline `receiveAndAuthorize`（surgical），仅在 mTLS #6 SDD 落地时补 caller-first preHandler 序。

## 3. 组件接口

### 3.1 `src/auth/jwt-verify.ts`

```ts
export interface VerifiedToken {
  end_user_id: string;  // JWT sub
  jti: string;
  exp: number;
}

export class VerifyError extends Error {
  constructor(public status: 401 | 503, message: string) { super(message); }
}

// jose createRemoteJWKSet(new URL('/.well-known/jwks.json', IAM_JWKS_URL))
// kid 精确路由（jose 内置）+ issuer=IAM_JWT_ISSUER + audience=IAM_JWT_AUDIENCE + algorithms:['RS256'] pinned
// JWKSNoMatchingKey → VerifyError(401)
// JWKSTimeout/网络错 → VerifyError(503)
// 其余 JOSEError（签名/iss/aud/exp/alg） → VerifyError(401)
export async function verifyUserToken(rawJwt: string): Promise<VerifiedToken>
```

- 仿 ops `web/lib/jwt-verify.ts:32 verifyEndUserJwt`，content-backend 自建（跨 repo 不复用 ops 模块）。
- JWT claims（IAM `src/token/access.ts:24-43`）：`iss='agentos-iam'`、`aud='content-backend'`（硬编码）、`sub=end_user_id`、`scope='content:read'`、`exp`、`nbf`、`jti`、header `kid`。无 region/device_id claim（device_id 从 envelope 取，region defer）。
- JWKS 端点（IAM `src/server.ts:32`）：`GET /.well-known/jwks.json` public，`Cache-Control: public, max-age=300`。

### 3.2 `src/auth/ops-lookup.ts`

```ts
export interface DeviceBinding {
  bound: boolean;
  role?: 'owner' | 'member';
  device_group_id?: string;
}

export class LookupError extends Error {
  constructor(public status: 503, message: string) { super(message); }
}

// fetch GET `${OPS_LOOKUP_URL}/api/internal/bindings?end_user_id=<uuid>&device_id=<string>`
// headers: x-service-token=OPS_LOOKUP_TOKEN, x-service-name=content-backend
// 200 → {bound, role?, device_group_id?}
// bound=false → 返 {bound:false}（调用方判 403，非 throw）
// 非 200/网络错/超时 → LookupError(503)
export async function lookupDeviceBinding(
  end_user_id: string,
  device_id: string
): Promise<DeviceBinding>
```

- 对接 ops `web/app/api/internal/bindings/route.ts`：`requireServiceAuth(req, 'lookup')` 验 `x-service-token`（scope=lookup 对应 `OPS_LOOKUP_TOKEN`）。
- 绑定语义：join `devices`(deviceId)→`end_user_device_groups`(end_user_id, deleted_at IS NULL)→返 `{bound, role, device_group_id}`。bound=true 即 end_user 拥有/成员该设备。
- 不缓存（sim，零 stale 风险，绑定撤销立即生效）。

### 3.3 `src/auth/token-verify-hook.ts`（fastify preHandler）

```ts
declare module 'fastify' {
  interface Request {
    endUser: { id: string; deviceId: string; role: 'owner'|'member' } | null;
  }
}

// preHandler，每 content_* 路由共享
// 1. parseRequestEnvelope(req.body) → {version, user_token, device_id, ...}
// 2. version 非 1/2 → reply.code(400).send({error:'invalid_envelope'})
// 3. version=1 或 user_token=null → req.endUser=null（匿名短路，self_hosted）
// 4. version=2 + user_token≠null:
//    a. verifyUserToken(user_token) → {end_user_id, jti}
//       catch VerifyError(401) → reply.code(401).send({error:'invalid_token'})
//       catch VerifyError(503) → reply.code(503).send({error:'jwks_unavailable'})
//    b. lookupDeviceBinding(end_user_id, device_id) → {bound, role, device_group_id}
//       catch LookupError(503) → reply.code(503).send({error:'lookup_unavailable'})
//       bound=false → reply.code(403).send({error:'device_not_bound'})
//    c. region/entitlement: CAPABILITY_MODE=mock → 放行 + log（defer 真校验）
//    d. req.endUser = {id:end_user_id, deviceId, role}
//    e. audit emit ^end_user:<id>（C10）
export const tokenVerifyHook: preHandlerHookHandler
```

### 3.4 `src/envelope.ts` 扩展

- `Envelope` 接口加 `version?: 1 | 2`。
- 新增 `parseRequestEnvelope(body: unknown): {version, kind, request, secret_handle?, user_token?, device_id?}` 按 version 路由（v1 无 version，v2 `version=2` + required user_token/device_id）。
- `wrapEnvelope()` 维持 v1 出（响应不改，下游契约不变）。

## 4. 失败语义（401/403/503 分段，对齐 IAM §6.3）

| 失败 | HTTP | body | audit actor |
|---|---|---|---|
| envelope version 非 1/2 | 400 | `{error:'invalid_envelope'}` | `^end_user:unknown` |
| v2 缺 user_token/device_id（schema 层先拦） | 400 | `{error:'invalid_envelope'}` | `^end_user:unknown` |
| JWT 签名/iss/aud/alg/exp/kid 无效 | 401 | `{error:'invalid_token'}` | `^end_user:unknown` |
| JWKS 端点不可达/超时 | 503 | `{error:'jwks_unavailable'}` | `^end_user:unknown` |
| ops lookup HTTP 5xx/网络/超时 | 503 | `{error:'lookup_unavailable'}` | `^end_user:<id>`（已验 token） |
| bound=false（token 绑设备校验失败，防跨设备 replay） | 403 | `{error:'device_not_bound'}` | `^end_user:<id>` |

**顺序**：先 JWT(401) 再 lookup(403)——未持有有效 token 者不应能探测绑定关系。lookup 不可用(503) ≠ bound=false(403)。audit 全程 emit，401 时 actor=`^end_user:unknown`，已验 token 后 actor=`^end_user:<id>`。

**错误响应体 shape（D8，plan-review fold）**：preHandler 失败响应**不可**用裸 `{error:'...'}`——现有 `src/index.ts` onSend hook 对所有响应跑 content-contract schema AJV validate，裸 JSON fail→throw→客户端收 500。preHandler 失败响应改用 `wrapEnvelope({}, kind, "self_hosted", "unavailable", "blocked", <error_code>)`（与现有 403 AUTH_FAILED 路径一致），HTTP status 仍 `reply.code()`。新增 `ErrorCode` enum 值：`INVALID_TOKEN`/`DEVICE_NOT_BOUND`/`JWKS_UNAVAILABLE`/`LOOKUP_UNAVAILABLE`/`INVALID_ENVELOPE`（`envelope.ts` ErrorCode 扩展，非 frozen schema）。

## 5. env 扩展（`src/env.ts`）

新增（prod `assertEnv` fail-fast，sim/docker 有值）：

| env | 用途 | sim 值 |
|---|---|---|
| `IAM_JWKS_URL` | IAM JWKS base | `http://iam:3000` |
| `IAM_JWT_ISSUER` | JWT iss 校验 | `agentos-iam` |
| `IAM_JWT_AUDIENCE` | JWT aud 校验 | `content-backend` |
| `OPS_LOOKUP_URL` | ops base | `http://ops:3000` |
| `OPS_LOOKUP_TOKEN` | service-auth（与 ops `OPS_LOOKUP_TOKEN` 同值，e2e 共享） | shared secret |
| `CAPABILITY_MODE` | `mock`=sim stub region/entitlement+mTLS caller，诚实声明 | `mock` |

## 6. 测试

### 6.1 vitest unit（各模块独立）

- `test/auth/jwt-verify.test.ts`：mock JWKS server（jose 真 verify）— 有效 token→`{end_user_id,jti}`；错 alg/kid/iss/aud/expired→401；JWKS 超时→503；kid 精确路由（unknown kid→401）。
- `test/auth/ops-lookup.test.ts`：fetch mock — 200 bound:true→`{bound,role,device_group_id}`；200 bound:false→`{bound:false}`；500/网络错→503；service-auth 头正确（`x-service-token`+`x-service-name`）。
- `test/auth/token-verify-hook.test.ts`：fastify inject — v1 匿名短路→`endUser=null`；v2 user_token=null 匿名→`endUser=null`；v2 有效 token+bound→`endUser` 注入；bound=false→403；JWT 无效→401；JWKS 不可用→503；lookup 不可用→503；version=3→400；region/entitlement mock 放行。
- `test/envelope-v2.test.ts`：v1/v2 解析路由 + schema 兼容（v1 无 version / v2 required user_token+device_id / version=3 fail）。

### 6.2 e2e docker-compose（三 service + postgres + minio）

- 加 `iam` service（agentos-iam image，起 `GET /.well-known/jwks.json` + register/login 签 token）。
- 加 `ops` service（agentos-ops-platform，起 `GET /api/internal/bindings` + seed end_user_device_group 绑定）。
- content-backend service 起，env 接 IAM_JWKS_URL/OPS_LOOKUP_URL/OPS_LOOKUP_TOKEN。
- e2e 脚本（`test/e2e/token-verify.e2e.test.ts`）：
  1. register+login 拿 user_token（IAM）
  2. 绑定 device（ops seed or API）
  3. POST /content_query 带 v2 envelope（user_token+device_id）→ 200 + endUser audit
  4. 解绑后重放同一 token+device_id → 403 `device_not_bound`
  5. 篡改 token 签名 → 401 `invalid_token`
  6. v1 envelope（无 version）→ 匿名 200（self_hosted 短路）
  7. v2 user_token=null → 匿名 200

## 7. 决策记录

- **D1 region sim stub defer**：JWT 无 region claim、ops lookup 不返 region，真校验需跨 repo 协调（JWT 加 claim / IAM 内部端点 / ops 扩返 region），sim 阶段 stub（capability_mode=mock 放行），独立子项后续 brainstorm。老林 2026-07-09 确认。
- **D2 lookup 不缓存**：sim 阶段不缓存绑定结果，零 stale 风险（绑定撤销立即生效），真系统按 stale 风险评估。老林 2026-07-09 确认。
- **D3 mTLS caller stub**：sim 沿用现有 header `X-Caller-Identity` 白名单（`normalizeInboundCaller`），真 mTLS defer #6（device-hub/transport SDD，窗口A），capability_mode=mock 诚实声明。
- **D4 模块组织 fastify preHandler + 独立模块**：`token-verify-hook` preHandler 共享 + `jwt-verify`/`ops-lookup` 独立模块（互不依赖，可独立单测），与 `receiveAndAuthorize` 分层（transport vs content）。方案 1。
- **D5 自建 jwt-verify 不复用 ops 模块**：跨 repo 不复用 ops `web/lib/jwt-verify.ts`，content-backend 自建等价模块（jose + createRemoteJWKSet），避免跨 repo 运行时依赖。
- **D6 失败语义 401/403/503 分段**：JWT 无效 401 / 绑定不存在 403 / 服务不可用 503；顺序先 JWT 后 lookup（防探测绑定）；audit `^end_user:<id>` / `^end_user:unknown`。
- **D7 preHandler 顺序 sim 偏离**：token-verify preHandler 跑在 inline receiveAndAuthorize 前（与 §2 理想 caller-first 相反）；sim no-mTLS 下 caller header 可伪造，caller-first 无真实安全，真序由 mTLS #6 enforced。老林 2026-07-09 确认 sim 偏离（surgical，不重构现有 inline authz）。三路 plan-review（Eng I6 / DevEx C2 / Codex P1）共识。
- **D8 错误响应 wrapEnvelope shape**：preHandler 失败响应用 wrapEnvelope（非裸 {error}），避免 onSend AJV 校验吞成 500；新增 ErrorCode 值 INVALID_TOKEN/DEVICE_NOT_BOUND/JWKS_UNAVAILABLE/LOOKUP_UNAVAILABLE/INVALID_ENVELOPE。三路 plan-review（DevEx C1 / Codex P1）共识。

## 8. not-architecture-impact 声明（AgentOS 架构文档同步门禁）

本 spec 不改架构级定义（见 frontmatter `not-architecture-impact`）。理由：
- envelope v2 契约形状已由 PR#61 落地，本 spec 仅消费 `user_token`/`device_id`/`version` 字段，不改 schema。
- content-backend 是既有子系统（架构 spec §2.1.3），本 spec 在其内加 auth 模块，不新增子系统/系统边界/身份域。
- 不改链路协议（envelope shape 不变 / 不新增 auth 层于 envelope / 不新增契约字段——消费既有 v2 字段）。
- 不改 frozen 契约（`shared-protocols/schemas/*.schema.json` 顶层 / `contract.h` envelope 顶层 / `*-envelope.schema.json` 均不动）。
- touched files 见 frontmatter。

PR 描述将附 negative-claim 证据（touched files + 不命中架构级变更定义理由），reviewer 显式核查。
