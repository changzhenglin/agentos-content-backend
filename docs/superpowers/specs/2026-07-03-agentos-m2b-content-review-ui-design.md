# AgentOS M2b 内容审核 UI + content_policy 消费通道 Design

> **流程链路:** brainstorming（老林确认 4 关键决策）→ writing-plans（8 task TDD bite-sized）→ plan-eng-review + codex(gpt-5.5) 强制跨厂商（命中信任边界/mTLS）→ findings fold → SDD（per-task + final whole-branch）→ verification(subagent) + Verifier → ship。
>
> **文档目标:** 为 AgentOS M2 内容 backend 续作 M2b——审核 UI（Web）+ content_policy 消费通道（独立服务 mTLS，复用 M3-pre §4.4 envelope security context）+ audit emit（§8.3 matrix）+ 顺带补 M2a final review defer 的 2I hardening（onSend 5xx 收窄 + ingest 边界校验）。本 spec 是 M2 contract spec（`2026-07-02-agentos-m2-content-backend-design.md` §8/§9.3/§10）的 SDD 细化，落地 §8.1 审核 UI + §9.3 链路 5 content_policy 通道 + §8.3 audit matrix。实现归 sibling repo `agentos-content-backend` SDD，本 spec 是设计层。
>
> **North star:** sim 闭环（与 M2a 一致）——mock ops-platform producer（sim CA cert）push content_policy envelope → content backend mTLS 接收 + audience 校验 + drm_rule 映射 → kind API 受约束（block→403）+ audit 全链。M1b 下发通道/M1c RBAC 就绪后换真实 producer cert，transport/auth 形状不变。
>
> **重要声明:** 本 doc 是 **SDD 设计 spec**（实现层），在 sibling repo `agentos-content-backend` 内 SDD 落地。不修订 M2 contract spec / 不 amend 0a / 不改 content-contract.schema.json / 不扩 ops-config drm_rule region（D10 backend 自持）/ 不扩 M3-pre audit enum（D11 复用既有）。production_runtime_readiness_complete = false（sim 闭环，mTLS 用 sim CA）。

## 1. Purpose and Authority

本 spec 回答：

```text
1. M2b 审核 UI 形状？（SSR+htmx，session 简单认证 admin/operator，ingest/transition/tracks 列表）
2. content_policy 消费通道如何落地？（独立服务 mTLS + envelope security context audience=content_backend 校验 + policy store + command_id 幂等 + version 排序 + stale 覆盖）
3. drm_rule 如何约束 kind API？（per-kind 映射，block 全 kind / region_restrict 按 backend 自持 region，fail-closed）
4. audit emit 如何实现？（append-only JSONL + hash chain，§8.3 matrix 五事件）
5. M2a defer 的 2I hardening 如何补？（http-mapping 4xx/5xx 收窄 + ingest 边界校验）
6. sim 闭环如何验证？（mock producer + 全链 e2e：push→接收→kind API 受约束→audit）
```

权威边界：

```text
- 是 M2b SDD 设计 spec，对 sibling repo M2b SDD 起约束作用。
- 不修订 M2 contract spec（§8/§9.3 范围不变，本 spec 细化落地）。
- 不 amend 0a spec / 不改 content-contract.schema.json / 不扩 ops-config drm_rule region（D10）/ 不扩 M3-pre audit enum（D11）。
- 不做 M1b 下发通道实现（M1 落地，本 spec 只做消费侧 + mock producer）。
- 不做 M1c RBAC engine（M1 落地，本 spec 做 sim 简单认证，M1c 就绪后换）。
- 不做 pull fallback（defer M3，sim 只做 push；pull interface placeholder 不实现）。
- 不做 third_party_api adapter（M2d）/ cloud-ext proxy（M2c）/ 端侧 adapter（M2c）。
- production_runtime_readiness_complete = false（sim 闭环，mTLS 用 sim CA cert）。
```

## 2. 现状缺口（M2a done 后实测）

| 项 | 现状 | 证据 |
|---|---|---|
| 审核 UI | ❌ 全无（T6 只实现 state-machine.ts transition 函数，无 Web UI / 无 ingest endpoint / 无 session 认证） | `src/review/state-machine.ts` + `src/index.ts` 无 admin route |
| content_policy 消费通道 | ❌ 全无（无 mTLS endpoint / 无 policy store / 无 drm_rule engine） | `src/index.ts` 仅 5 kind routes |
| drm_rule 约束 kind API | ❌ kind business functions 不查 policy | `src/routes/*.ts` 无 policy check |
| audit emit | ❌ 全无（M2a defer M2b·M3-pre） | 无 audit module |
| ingest 边界校验（I2） | ❌ raw_metadata JSON.parse 无 try + 缺字段静默回退 | `state-machine.ts:75-103` |
| http-mapping 5xx 收窄（I1） | ❌ BLOCKED 笼统 503（copyright/region 也 503，应 4xx） | `routes/http-mapping.ts` |
| content_policy 真实 producer | ❌ M1b 下发通道未启动 | milestone state M1b 未启动 |

**结论**：M2a 把 backend 5 kind + 审核 state-machine + Postgres + 对象存储跑通（66/66 PASS），但审核 UI / content_policy 消费 / drm 约束 / audit 全缺，2I hardening defer。本 spec 设计补齐这些 + sim 闭环验证。

## 3. 架构（方案 B：双 fastify app）

```text
agentos-content-backend（sibling repo，M2b 续作）
├── App1：5 kind API（现有，port 3001，caller=cloud-ext/端侧）
│   ├── kind handler 调用后 emit audit（tool_call，actor=service caller）
│   ├── kind business functions 接 drm-rule-engine（block/region_restrict→403）
│   └── 2I hardening：http-mapping 4xx/5xx 收窄
│
├── App2：ops-facing（新，port 3002）
│   ├── /content_policy/*  ← mTLS + audience=content_backend 校验（ops-platform caller）
│   │   ├── POST /content_policy/push   接收 envelope（security context 校验 + command_id 幂等 + version 排序 + stale 覆盖 + audit config_apply）
│   │   └── GET  /content_policy/list    debug only（列已应用 policy）
│   ├── /admin/*  ← session cookie（admin/operator，human caller）
│   │   ├── GET  /admin/login            登录页（dev token）
│   │   ├── POST /admin/ingest           入库（admin only，raw_metadata 边界校验 I2）
│   │   ├── GET  /admin/ingest/:id       审核详情页
│   │   ├── POST /admin/ingest/:id/approve|reject|revoke   transition（actor 从 session，emit provision/revoke audit）
│   │   └── GET  /admin/tracks           已发布 tracks 列表
│   └── mTLS server：sim CA cert 强制（cert 校验 chain/SAN/EKU/有效期，非 CN-only，M3-pre §4.5）
│
├── shared modules（App1/App2 共享）
│   ├── ContentDb port（现有，扩展 policy 查询）
│   ├── policy-store.ts（新）：content_policy 表 + applyPolicy + latestPolicy
│   ├── drm-rule-engine.ts（新）：per-kind 映射 + region 判定
│   ├── region-config.ts（新）：backend 自持 region（env CONTENT_BACKEND_REGION，D10）
│   ├── audit/audit-sink.ts（新）：append-only JSONL + hash chain + auditClient 接口
│   └── audit/audit-events.ts（新）：§8.3 matrix 五事件 helper
│
├── sim mock producer（新，scripts/mock-policy-producer.ts）
│   └── sim CA 签服务 cert + 签 content_policy envelope（audience=content_backend）+ POST /content_policy/push
│
└── 数据模型新增（drizzle migration）
    ├── content_policy 表（rule_id, action, target_scope, version, envelope JSONB, received_at, superseded_by）
    └── users：sim env 配置（CONTENT_BACKEND_ADMIN_TOKEN / OPERATOR_TOKEN），不入库（轻量）
```

**架构原则**：
- caller 身份域分离：App1=device/cloud-facing（cloud-ext/端侧 caller），App2=ops-facing（ops-platform 服务 mTLS + human session cookie）。与 M3-pre §4.4 身份域表一致（服务身份=openclaw/content backend/cloud-ext/ops-platform；人身份=ops-platform Web RBAC）。
- App2 内 mTLS route（/content_policy/*）与 session cookie route（/admin/*）不同 prefix + 不同 preHandler，不互相污染。
- shared modules 纯函数 + port 注入（ContentDb/auditClient），不绑死 fastify，可独立单测。
- audit sink 共享单例 client（App1/App2 注入同一 JSONL writer；sim 低并发，append-only + hash chain 保证完整性；真机阶段外部 sink 时换 auditClient 实现，接口不变）。
- sim 闭环：mock producer 用 sim CA cert 签服务证书（与 M3-pre §4.5 sim 阶段 mTLS+sim CA cert 强制一致），M1b 就绪后换真实 ops-platform 服务 cert，backend 侧 mTLS 校验 + audience 校验逻辑不变。

## 4. 组件接口（TypeScript 签名，纯函数+port 注入）

### 4.1 policy-store.ts

```typescript
interface SecurityContext {
  actor: string;              // ops-platform 服务身份
  rbac_decision: object;      // 角色×kind×scope 授权结果（sim 简单：role content_policy kind 允许）
  target_device?: string;     // content_policy 无 target_device（target_scope=content_management）
  audience: string;           // 必须 === "content_backend"
  expiry: string;             // ISO 时间，未过
}
interface PolicyEnvelope {
  command_id: string;         // 幂等键
  kind: "content_policy";
  capability_mode: string;
  payload: {
    rule_id: string;
    action: "allow" | "block" | "region_restrict";
    target_scope: "content_management";
    region?: string;          // ops-config drm_rule 无 region（D10），payload 亦无；region 走 backend 自持
  };
  security_context: SecurityContext;
}
interface PolicyRecord {
  ruleId: string; action: string; targetScope: string;
  version: number; envelope: PolicyEnvelope;
  receivedAt: string; supersededBy: number | null;
}
interface PolicyStore {
  /** push：command_id 幂等查重 + version 自增 + 旧 version 标 superseded */
  applyPolicy(envelope: PolicyEnvelope, callerIdentity: string): Promise<{ applied: boolean; version: number; superseded?: boolean }>;
  /** 读最新生效 policy（drm-rule-engine 调） */
  latestPolicy(): Promise<PolicyRecord[]>;
}
```

### 4.2 drm-rule-engine.ts + region-config.ts

```typescript
interface DrmDecision { action: "allow" | "block" | "region_restrict"; ruleId: string; }
/**
 * per-kind 检查：policy 命中 track_id / target_scope=content_management？
 * - block → 全 kind BLOCKED（COPYRIGHT_RESTRICTED）
 * - region_restrict → 按 region-config 判定，不符 → REGION_RESTRICTED
 * - allow → 放行
 * 返回 null = 无 policy 命中（放行）
 */
function checkDrm(
  policies: PolicyRecord[],
  kind: Kind,
  trackId: string,
  requestRegion: string,
  regionConfig: string,
): DrmDecision | null;

// region-config.ts（D10 backend 自持）
function getRegion(): string;  // env CONTENT_BACKEND_REGION，默认 "cn"
```

### 4.3 audit/audit-sink.ts + audit-events.ts

```typescript
interface AuditEvent {
  eventType: "provision" | "revoke" | "config_apply" | "tool_call";  // M3-pre §4.7 enum，D11 复用
  actorType: "human" | "service";
  actor: string;               // session user / service identity
  target: string;              // track_id / rule_id / query
  traceId: string;
  streamId?: number;           // stream kind
  policyVersion?: number;      // content_policy 消费
  prevHash: string;            // hash chain
  ts: string;
}
interface AuditSink {
  /** 内部算 hash chain（prev=event.sha256）+ append JSONL */
  emit(event: Omit<AuditEvent, "prevHash" | "ts">): Promise<void>;
}
// §8.3 matrix 五事件 helper（封装 emit 调用）
emitProvision(sink, { ingestId, trackId, actor });     // approve
emitRevoke(sink, { trackId, actor });                   // reject/revoke
emitConfigApply(sink, { ruleId, version, actor });      // content_policy 消费
emitToolCall(sink, { kind, target, actor });            // kind API 调用 / creds 解析
```

hash chain：首条 prev=sha256("")；每 event prev=上一条 sha256；断链=篡改证据（M3-pre §4.7 完整性）。sim sink=append-only JSONL 文件（env AUDIT_SINK_PATH）；真机阶段换外部 sink（auditClient 接口不变）。

### 4.4 App2 路由

```typescript
// content_policy endpoint（mTLS + audience 校验）
app2.post("/content_policy/push", {
  preHandler: mtlsVerify({ ca: simCA, check: "chain+san+eku+validity" }),
}, async (req, reply) => {
  const envelope = req.body as PolicyEnvelope;
  // 1. callerIdentity = req.tls peer cert SAN/CN（service identity）
  // 2. 校验 security_context.audience === "content_backend" → 否则 403 + audit unauthorized
  // 3. 校验 expiry 未过 → 否则 403
  // 4. 校验 actor 有权签 content_policy kind（sim：role 允许即可）
  // 5. policyStore.applyPolicy(envelope, callerIdentity)
  // 6. audit.emitConfigApply(ruleId, version, actor)
  // 7. reply 200 { applied, version }
});

// admin endpoint（session cookie）
app2.post("/admin/ingest", {
  preHandler: [requireSession, requireRole("admin")],
}, async (req, reply) => {
  // raw_metadata 边界校验（I2）：ajv 校验结构 + JSON.parse try/catch + 缺字段 400
  // INSERT ingest（state=pending）
});
app2.post("/admin/ingest/:id/approve", {
  preHandler: [requireSession, requireRole("admin")],
}, async (req, reply) => {
  // state-machine.transition(db, id, "approve", actor=session.user)  // 现有
  // audit.emitProvision(ingestId, trackId, actor)
});
```

## 5. 数据流

### 5.1 content_policy push（sim 闭环）

```text
mock-producer（sim CA cert）──mTLS──▶ app2 /content_policy/push
  → mtlsVerify preHandler：caller cert chain/SAN/EKU/有效期校验（非 CN-only）
  → 解析 envelope.security_context：audience=content_backend? expiry? actor RBAC?
  → policyStore.applyPolicy：command_id 幂等查重 → INSERT content_policy（version 自增）→ 旧 version 标 superseded
  → audit.emitConfigApply(ruleId, version, actor="ops-platform")
  → 200 { applied, version }
```

### 5.2 kind API 受 drm_rule 约束（content_policy 消费闭环）

```text
cloud-ext/端侧 ──▶ app1 /content_stream { track_id }
  → streamBusiness(db, presign, trackId)
  → 【新】drm-rule-engine.checkDrm(policyStore.latestPolicy(), "content_stream", trackId, requestRegion, regionConfig)
  → 命中 block → BLOCKED(COPYRIGHT_RESTRICTED) → http-mapping 403
  → 命中 region_restrict + region 不符 → REGION_RESTRICTED → 403
  → 放行 → presign URL → DONE → 200
  → audit.emitToolCall(kind=content_stream, target=trackId, actor=caller)
```

### 5.3 审核流程（UI → state-machine → audit）

```text
admin 浏览器 ──session cookie──▶ app2 /admin/ingest（POST raw_metadata，I2 边界校验）
  → ajv 校验 raw_metadata（title/artist/duration_ms required + 类型）→ fail 400
  → INSERT ingest（state=pending）
admin ──▶ /admin/ingest/:id/approve
  → state-machine.transition(db, id, "approve", actor)  // 现有，actor 从 session 取
  → audit.emitProvision(ingestId, trackId, actor)
```

### 5.4 2I hardening

- **I1 http-mapping**：`httpStatus(completionState, errorCode)` 细化：
  - DONE / DONE_WITH_CONCERNS → 200
  - BLOCKED + COPYRIGHT_RESTRICTED / REGION_RESTRICTED → 403（client-side block，非 server error）
  - BLOCKED + BACKEND_UNAVAILABLE / AUTH_FAILED → 503（server-side unavailable）
  - onSend schema validate fail → throw → 500（server bug，schema-violation 专属，不泄漏详情给 client）
- **I2 ingest 边界校验**：POST /admin/ingest 的 raw_metadata 用 ajv 校验结构（title/artist/duration_ms required + 类型 + audio_object_key 可选）+ JSON.parse try/catch + 缺字段 400 拒绝（非静默回退）；approve transition 时 raw_metadata 重新校验（防御二次解析失败）。

## 6. 错误处理

| 场景 | 处理 | HTTP |
|---|---|---|
| mTLS 握手失败 / cert 校验不过 | 拒绝连接（M3-pre §4.5 降级拒绝，非 CN-only） | 连接层拒绝 |
| envelope audience ≠ content_backend | 拒绝 + audit unauthorized | 403 |
| envelope expiry 过期 | 拒绝 + audit | 403 |
| actor 无权签 content_policy kind | 拒绝 + audit | 403 |
| command_id 重复（同幂等键） | 幂等返回 `{ applied:false, version:existing }`，不重复应用 | 200 |
| 旧 version policy 后到 | 标 superseded，不应用 | 200 `{ applied:false, superseded:true }` |
| raw_metadata 校验失败（I2） | 拒绝 + 错误详情 | 400 |
| state-machine NOT_FOUND | 404 | 404 |
| policy store 查询失败（DB error）→ kind API | **fail-closed**：BLOCKED(BACKEND_UNAVAILABLE) | 503 |
| policy store 空集（无 policy）→ kind API | allow（无约束=放行，非 fail） | 200 |
| audit sink 写失败 | sim：log error 不阻塞业务（fire-and-forget，标已知限制）；真机阻塞+告警 | 业务不中断 |
| onSend schema validate fail（I1） | throw→500（schema-violation 专属，不泄漏详情） | 500 |

**fail-closed 原则**：drm-rule-engine 在 policy store 不可用时 BLOCKED（安全优先），空集 policy 时 allow（无约束≠故障）。安全与可用性关键区分。

## 7. 测试矩阵（8 task TDD bite-sized，对齐 M2a 颗粒度）

| Task | 范围 | 测试 |
|---|---|---|
| T1 | content_policy 表 migration + users(env) + policy-store.ts | unit：applyPolicy 幂等 + version 排序 + stale 覆盖 + latestPolicy |

> **编号说明（fold ceo I1）**：本节 T1-T8 是 spec 视角的测试矩阵分组；plan task 编号见 plan File Structure（plan T4=http-mapping / T5=push / T6=kind-drm / T7=UI / T8=sim-闭环），与本表 T4-T7 顺序互换——编号非一一对应，plan Self-Review §1 已映射覆盖。
| T2 | drm-rule-engine.ts + region-config.ts | unit：block 全 kind / allow / region_restrict 命中+不命中 / per-kind（stream vs query） |
| T3 | audit-sink.ts（JSONL+hash chain）+ audit-events.ts（五 helper） | unit：append + hash chain 连续性 / 断链检测 / 五事件字段 |
| T4 | App2 content_policy push endpoint + mTLS preHandler + audience 校验 | integration：mTLS mock cert push 200 / audience mismatch 403 / expiry 403 / command_id 重复幂等 / 旧 version superseded |
| T5 | kind business functions 接 drm-rule-engine + audit tool_call | integration：stream 命中 block→403 / region_restrict→403 / allow→200 + audit emit / policy store 空集 allow / policy store 故障 fail-closed 503 |
| T6 | 审核 UI（SSR+htmx）+ session 认证 + ingest 边界校验(I2) | integration：login + ingest 400 边界 + approve/reject/revoke transition + tracks 列表 + audit provision/revoke + htmx 交互 |
| T7 | 2I hardening：http-mapping 4xx/5xx 收窄(I1) | unit：DONE→200 / COPYRIGHT_RESTRICTED→403 / BACKEND_UNAVAILABLE→503 / schema-violation→500；ingest 校验 e2e |
| T8 | mock producer（sim CA cert）+ sim 闭环 e2e + README | integration：producer push→app2 接收→app1 kind API 受约束 全链 + audit 链 + README |

**验收标准**（plan 阶段细化，Verifier 对此验收）：

```text
1. 66/66 现有测试不回归 + M2b 新增测试全 PASS
2. sim 闭环 e2e 可演示：mock producer push content_policy(block track_id=self:t1) → app1 /content_stream self:t1 → 403 COPYRIGHT_RESTRICTED（真实可观察行为，非 mock 断言）
3. audit JSONL 含完整 hash chain，断链检测有效
4. mTLS cert 校验非 CN-only（chain/SAN/EKU/有效期有测试覆盖）
5. onSend 5xx 收窄：BLOCKED+copyright=403 而非 503
6. ingest 边界校验：缺 title/artist/duration_ms → 400（非静默回退）
```

## 8. 决策点（老林 2026-07-03 确认）

| ID | 决策 | 选定 | 理由 |
|---|---|---|---|
| B1 | content_policy 通道深度 | sim 闭环（mTLS shape + mock producer） | 与 M2a 一致，不阻塞 M3；M1b 就绪后换真实 cert |
| B2 | 审核 UI 技术栈 | SSR + htmx（无构建链） | 内部工具无需 SPA，lockfile 仅加 eta+htmx，不触 CI build |
| B3 | UI 认证深度 | sim 简单认证（admin/operator, dev token + session cookie） | M1c 未启动，audit 需 actor 追溯，sim 简单认证够 |
| B4 | audit emit 范围 | 同期完整 emit（§8.3 matrix 五事件 + JSONL + hash chain） | audit 是 §8.3 核心，content_policy 消费必须 audit |
| B5 | 架构编排 | 方案 B（双 fastify app：API + ops-facing） | caller 身份域分离 + spec §9.3 独立 endpoint 一致 |
| B6 | pull fallback | defer M3（sim 只 push） | spec §9.3 push 为主，sim 收敛 |
| B7 | region 来源 | backend 自持 env（D10） | M2 spec D10 既定，不扩 ops-config schema |
| B8 | audit sink 失败 | sim fire-and-forget + log | 不阻塞业务，真机阶段阻塞+告警（M3-pre §4.7） |
| B9 | drm policy store 故障 | fail-closed（BLOCKED） | 安全优先，空集 allow 区分 |
| B10 | 2I hardening | 同期补（I1 http-mapping + I2 ingest 校验） | 老林指定顺带补 |

## 9. 非目标

- 不修订 M2 contract spec / 不 amend 0a / 不改 content-contract.schema.json。
- 不做 M1b 下发通道（M1 落地，本 spec 只消费侧 + mock producer）。
- 不做 M1c RBAC engine（M1 落地，sim 简单认证，M1c 就绪后换）。
- 不做 pull fallback（defer M3，pull interface placeholder）。
- 不做 third_party_api adapter（M2d）/ cloud-ext proxy（M2c）/ 端侧 adapter（M2c）。
- 不扩 ops-config drm_rule region（D10 backend 自持）/ 不扩 M3-pre audit enum（D11 复用既有）。
- 不做真机 mTLS（sim CA cert，真机硬件根签 cert 归 M5）。**sim 阶段仍做非 CN-only 校验**（CA trust + SAN + EKU clientAuth + validity，selfsigned 可设；fold codex P1/ceo C1/eng I3）：信任边界是强制跨厂商子集命中点，sim 就该校验逻辑有测试覆盖（wrong-CA/expired/wrong-SAN 拒绝），真机只加 CRL/OCSP revocation + 换硬件根签 cert。
- 不做 audit 外部 sink（sim JSONL，真机外部 sink 归 M3）。
- **M2b 只解锁 M3 链路 5 治理闭环**（content_policy 通道），链路 3（端侧 adapter）/链路 4（cloud-ext proxy）defer M2c/d（fold ceo I3，避免路线高估 M3 unblock 程度）。

## 10. 与 M2 contract / M3-pre 关系

| 上游 spec 条目 | M2b 消费 |
|---|---|
| M2 §8.1 审核状态机 | T6 审核 UI 落地（transition 现有，加 UI + ingest endpoint + audit） |
| M2 §8.2 content_policy 消费 + drm_rule 映射 | T1-T2 policy-store + drm-rule-engine + region-config（D10 自持） |
| M2 §8.3 audit matrix | T3 audit-sink + audit-events（五事件，D11 复用 M3-pre enum） |
| M2 §9.3 链路 5 content_policy 通道 | T4 App2 mTLS endpoint + audience 校验 + command_id 幂等 + version 排序 + stale 覆盖 |
| M2 §10 M3-pre §4.4 envelope security context | T4 audience/expiry/actor 校验 |
| M2 §10 M3-pre §4.5b 链路 2 服务 mTLS | T4/T8 App2 mTLS server（sim CA cert，独立 endpoint） |
| M3-pre §4.7 audit schema | T3 append-only JSONL + hash chain + writer identity |
| M2a final review 2I defer | T7 http-mapping 4xx/5xx + ingest 边界校验 |

## 11. Self-Review

- **Placeholder scan**：无 TBD/TODO；接口签名 + 数据流 + 测试矩阵 + 验收标准全具体。
- **Internal consistency**：§3 架构方案 B 与 §4 接口 + §5 数据流一致；§5.2 drm 约束 kind API 与 §4.2 drm-rule-engine 接口一致；§6 fail-closed 与 §5.2 policy store 故障处理一致；§7 T4-T8 与 §5 数据流逐条对应；§8 决策与 §3-§7 一致。
- **Scope check**：SDD 设计 spec，聚焦审核 UI + content_policy 通道 + drm 约束 + audit + 2I hardening，8 task TDD 可承载，单 spec 可承载；third_party/cloud-ext/pull/真机显式 defer。
- **Ambiguity check**：§4 接口签名消除歧义（PolicyEnvelope/PolicyRecord/AuditEvent 字段定）；§5 数据流步骤定；§6 错误处理表 HTTP 码定；§7 验收标准可 pass/fail 判定；sim 闭环 vs 真机边界明确（production_runtime_readiness_complete=false）。
