# AgentOS M3 阶段2 内容侧 Design（窗口C）

> 日期：2026-07-05
> 窗口：C（内容侧，sibling repo `agentos-content-backend` + `agentos-openclaw-cloud-extension`）
> 主模型：glm-5.2[1m] 紧凑档 + codex gpt-5.5 跨厂商（content-contract 公共 contract 强制子集）
> 前置：M2b/M2c/M2d 全 MERGED（content-backend main `e380b82` + cloud-ext main `665c9fb`，2026-07-05）；M3 阶段1 MERGED（AgentOS PR#50 `aacfd6b`）；窗口B 阶段2 ops 内容边界 spec（ops-platform `9868ca8`）
> spec 性质：实现型 spec（窗口C 阶段2 内容侧接通链路3），含跨窗口契约提议（归 AgentOS shared-protocols 窗口A 落地）

## 1. 背景与架构总览

### 1.1 三系统关系与通信诉求

| 系统 | 定位 | 原生角色 |
|---|---|---|
| **cloud-ext** | openclaw cloud extension（openclaw 插件） | 云端 agent 的工具集——agent 调它搜歌/出 UI 卡/下发 ops（链路4 agent 侧） |
| **content-backend** | 内容管理服务（5 kind API + ops push + 审核 UI） | 内容数据源 + drm/审核/audit；inbound 白名单接受 cloud-ext caller（M2d），本 spec 扩加 device-hub |
| **ops-platform** | 运营管理服务（WS sidecar 下发） | 运营人员下发 ops-config/capability_policy 给端侧（链路2）；窗口B spec 不直连 content |

**端侧出站通信诉求**（4 类）：
1. **语音交互**（链路1）：PCM_UP → 云端 ASR → openclaw agent 决策 → agent 触发 content/ops。经 cloud-ext（agent 侧）。
2. **节目单/metadata/lyrics 获取**（链路3）：端侧显示节目信息 → content_request → content-backend。
3. **视音频 stream 获取**（链路3）：端侧播放 → content_stream → content-backend presign URL → 端侧拉 MP3。
4. **能力声明/ops-config 接收**（链路2）：ops → device-hub → 端侧。不经 cloud-ext。

**ops 出站**：ops-config/capability_policy 下发（链路2，经 device-hub，不经 cloud-ext）；content_policy 窗口B 否决 ops 签发（归 content-backend 自管）。

**cloud-ext 出站**：agent 调 content-backend（链路4，music-query-tool/content-adapter）；agent 调 ops-platform（agentos_apply_ops_config）。

### 1.2 关键架构决策：device-hub 是端侧唯一网关（走向B）

device-hub 按诉求路由到不同后端，**cloud-ext 不做端侧内容网关**（回归纯 agent 工具，链路4）：

- 链路1 语音交互 → cloud-ext/openclaw ASR + agent（agent 主导，defer 阶段3 ASR/agent 决策）
- 链路2 ops 配置下发 → ops-platform sidecar WS（ops 主导，阶段1 已 done）
- 链路3 内容获取 → **device-hub 直连 content-backend 5 kind API**（端侧主导，本 spec 接通）
- 链路4 agent→content → cloud-ext content-adapter/music-query-tool（agent 主导，defer 阶段3）

**为什么不走 cloud-ext 网关**：cloud-ext 原生角色是 agent 工具（链路4）。让链路3（端侧直连 content 诉求）也走 cloud-ext，cloud-ext 会双角色（agent 工具 + 端侧 content 网关），且端侧取内容每次绕道 cloud-ext（多一跳 + 语义怪）。走向B 让 device-hub 是端侧唯一网关，按诉求路由，分层清晰。代价：扩 content-backend inbound 白名单加 device-hub caller（revisit M2d 单一 caller，但 ALLOW_MATRIX 可扩，本 spec 设计 caller × backend_type 细化矩阵防越权）。

### 1.3 content 流路径

```
端侧 jl7018 (发 content_request, 附 device_capability)
  → device-hub 路由 (窗口A)
  → content-backend 5 kind API (caller=device-hub, self_hosted 路径, 无 secret_handle)
  → 返 presigned S3/MinIO URL (self_hosted 真实曲目)
  ← content-backend envelope 回 device-hub → 端侧 HTTP GET 拉 MP3 → decode → playback (窗口A)
```

链路4（agent→content，defer 阶段3）：
```
openclaw agent → cloud-ext content-adapter/music-query-tool (caller=cloud-ext, ^cloud: handle)
  → content-backend 5 kind API (self_hosted + third_party_api 两路)
  → 返 envelope → agent 决策 → 经 ops-platform 下发 stream URL envelope → device-hub → 端侧 playback
```

## 2. 组件边界

### U1. content-backend `caller-auth-matrix` 扩 device-hub（改既有）

- inbound 白名单 `["cloud-ext"]` → `["cloud-ext", "device-hub"]`
- **ALLOW_MATRIX 细化**（caller × backend_type）：
  - `cloud-ext` → 允许 `self_hosted` + `third_party_api`（agent 可调两路）
  - `device-hub` → **只允许 `self_hosted`**（端侧不直接调 third_party provider，防越权；third_party 内容经 agent 链路4 触发）
- 文件：`src/auth/caller-auth-matrix.ts`（单一源扩一行）+ `src/auth/secret-store-stub.ts` + `src/auth/secret-handle-hook.ts`
- 依赖：M2d 既有 matrix（可扩）
- 不做：不做 device-hub 的 mTLS（defer 真机/M5）；不签发 device-hub 凭证（归窗口A/M3-pre secret store）

### U2. content-backend `device-capability-filter`（新建）

- 5 kind 入口收 `X-Device-Capability` header（端侧能力 mode JSON：支持的 kind/format/bitrate/region）
- drm-guard **前置**能力筛选（端侧能力不支持 → 降级或 BLOCKED）
- capability_policy 与 drm_rule 正交：drm 管版权/region，capability 管设备能力
- 文件：`src/policy/capability-filter.ts`（新建）+ `src/index.ts` 5 route 接入
- 依赖：drm-guard（既有）+ capability_policy（ops 下发，content-backend 侧读 latest policy，复用 policyStore）
- 不做：不签发 capability_policy（归 ops 下发，窗口B）；不存 device_capability（无状态筛选）
- **降级策略**：format/bitrate 不匹配时优先降级到端侧支持的 format/bitrate（查 tracks 表有无匹配 format），全不支持才 BLOCKED。与 drm block（直接 BLOCKED）不同——capability 是"能不能播"，降级比硬拒友好

### U3. content-backend `self-hosted-seed`（新建）

- 填 royalty-free 真实曲目进 Postgres tracks/lyrics 表 + MinIO MP3 文件
- seed 脚本 + 真实 MP3（公共域/royalty-free 几首，避免版权问题）
- 文件：`src/db/seed/`（新建 seed 脚本）+ `test/fixtures/audio/`（royalty-free MP3）
- 依赖：presign（既有 `src/storage/presign.ts`）+ tracks/lyrics 表（既有 `src/db/schema.ts`）+ MinIO/AWS SDK（既有）
- 不做：不接真实第三方 provider（third_party 用 mock endpoint）；不做曲库管理 UI

### U4. content-backend 5 kind API 全接通真实数据（扩既有，主要靠 U3 填库后自然真实）

- stream：返真 presigned S3 URL（`src/storage/presign.ts` 已实现，填库后真实可拉）
- query/match/metadata/lyrics：返真实曲目（填库后真实）
- third_party 路径：mock provider endpoint 跑契约透传（M2d 既有 adapter，不动）

### U5. content_request envelope 契约提议（归 AgentOS shared-protocols 窗口A 落地）

- content_request envelope schema 扩 `device_capability` 字段（支持的 kind matrix + format/bitrate 上限 + region）
- device-hub caller principal + `^hub:` secret_handle 形态（sim 阶段 device-hub 不持 handle，trust network + X-Caller-Identity；真机 mTLS + 真 handle defer M3-pre secret store）
- 窗口C spec **提议契约**，schema 落地归窗口A（AgentOS 主仓 shared-protocols）；sibling repo 侧加消费校验
- 不做：窗口C 不改 AgentOS 主仓 shared-protocols schema（归窗口A）

### U6. cloud-ext（阶段2 不改）

- content-adapter 5 kind 透传接口已 done（M2c Task 4）；music-query-tool query/match 已 done
- 链路4 agent 入口接线 + stream/lyrics/metadata tool defer 阶段3（ASR/agent 决策一起做）
- 阶段2 cloud-ext 零改动

### U7. e2e（content-backend 侧）

- mock device-hub caller 调 5 kind + 真实 self_hosted stream URL 拉取
- testcontainers pg+minio + spawn content-backend fastify + mock device-hub（注入 X-Caller-Identity: device-hub + X-Device-Capability）
- 真实 MP3 字节校验（HTTP GET 拉 presigned URL → MP3 magic header + 非空 + 时长合理）
- third_party mock provider endpoint 跑契约透传（M2d 既有，复用）

## 3. 数据流

### 3.1 device-hub → content-backend 调用契约

device-hub 调 content-backend 5 kind API（`POST /content_<kind>`，端口 3001），headers：

| header | 值 | 说明 |
|---|---|---|
| `X-Caller-Identity` | `device-hub` | inbound 白名单校验（U1 扩） |
| `X-Device-Capability` | `<端侧能力 mode JSON>` | capability-filter 筛选（U2） |
| `X-Region` | `<端侧 region>` | drm-guard region_restrict（既有） |
| `X-Trace-Id` | `<trace_id>` | audit + 链路追踪（既有） |
| `X-Secret-Handle` | **不发** | device-hub 只调 self_hosted（无 provider token 需求），与 cloud-ext self_hosted 路径一致（M2c music-query-tool self_hosted 不发 handle） |

### 3.2 5 kind 数据流（device-hub caller，self_hosted 路径）

统一调用栈（5 kind 共享，差异在 business 层）：
```
device-hub POST /content_<kind> (headers + body)
  → receiveAndAuthorize(caller=device-hub, source, backend_type=self_hosted)  // U1 白名单 + backend_type 限制
  → capability-filter(X-Device-Capability, kind, capability_policy)  // U2 筛选
  → resolveProviderPath(policyStore) → backendType=self_hosted  // 既有
  → drm-guard(kind, track, region, drm_rules)  // 既有
  → <kind>Business  // 差异点
  → wrapEnvelope → reply
```

- **query**：`queryBusiness`（`src/content/self-hosted.ts`）查 tracks 表 → 返 candidates envelope
- **match**：`matchBusiness` 查 tracks 表匹配 → 返 matched candidates
- **stream**：`streamBusiness`（`src/routes/stream.ts`）查 tracks format/bitrate → capability-filter 筛 format/bitrate（降级或 BLOCKED）→ drm-guard（block/region_restrict/copyright）→ presign S3 URL → 返 `{stream_id, track_id, url: presigned, auth:{token,token_type:query_param,expires_at}, format, bitrate, expires_at}`
- **lyrics**：`lyricsBusiness`（`src/content/lyrics.ts`）查 lyrics 表 → 独立版权校验（lyrics_license=restricted 任一行 blocked）→ 返 lyrics lines
- **metadata**：`metadataBusiness`（`src/content/self-hosted.ts`）查 tracks 表 → 返 track metadata（title/artist/duration/album/isrc）

### 3.3 stream URL 回流

content-backend 返 presigned S3/MinIO URL → device-hub 收 envelope → device-hub 回端侧 → 端侧 jl7018 HTTP GET 拉 MP3（窗口A 实现）→ decode → playback。窗口C 只到 content-backend 返 URL，端侧拉取 + decode 归窗口A。

### 3.4 third_party 路径（链路4，agent 触发，defer 阶段3）

cloud-ext agent → content-adapter contentRequest → content-backend 5 kind（caller=cloud-ext, `^cloud:` handle, backend_type=third_party_api）→ fetchThirdParty → mock provider endpoint（阶段2）/ 真 provider（授权后）。阶段2 不接线 agent 入口，mock provider e2e 跑契约透传（M2d 既有，不动）。

## 4. 错误处理

按 completion_state normative mapping（M2 contract）+ 既有 M2b/M2d 模式：

| 失败点 | completion_state | HTTP | error_code | 说明 |
|---|---|---|---|---|
| receiveAndAuthorize caller 不在白名单 | BLOCKED | 403 | `AUTH_FAILED`/`caller_not_allowed` | 既有 M2d（含 device-hub 越权调 third_party → caller_not_allowed） |
| receiveAndAuthorize backend_type 越权（device-hub 调 third_party） | BLOCKED | 403 | `source_not_allowed`/`provider_binding_mismatch` | U1 矩阵细化新增 |
| capability-filter 端侧不支持 kind | BLOCKED | 403 | `CAPABILITY_UNSUPPORTED` | U2 新增 |
| capability-filter format/bitrate 不支持 | 降级或 BLOCKED | 200/403 | 降级返可用 format / `CAPABILITY_UNSUPPORTED` | 优先降级，全不支持才 BLOCKED |
| drm-guard block/region_restrict/copyright | BLOCKED | 403 | `COPYRIGHT_RESTRICTED`/`REGION_RESTRICTED` | 既有 M2b |
| self_hosted track 不存在 | NO_RESULT | 200 | `NO_RESULT`（envelope payload 空 candidates） | 既有，填库后真实曲目命中 |
| stream presign S3/MinIO 故障 | UNAVAILABLE | 503 | `BACKEND_UNAVAILABLE` | 既有 M2b http-mapping |
| third_party mock provider 4xx | 透传 | 4xx | 提取 `error_code` | 既有 M2c content-adapter 4xx 透传 |
| audit IO 错 | 不篡改 errorCode | — | audit fire-and-forget | 既有 M2b |

**fail-closed**：policyStore 故障 → drm-guard fail-closed `BACKEND_UNAVAILABLE`（M2b 既有）；capability_policy store 故障 → capability-filter fail-closed `BACKEND_UNAVAILABLE`（U2 沿用，不 silent allow）。

## 5. 测试 + e2e 策略

### 5.1 单测
- `caller-auth-matrix`：device-hub caller 允许 self_hosted / 拒绝 third_party（spoof 防御 + backend_type 越权）
- `capability-filter`：支持/不支持 kind、format/bitrate 降级、全不支持 BLOCKED、policy store 故障 fail-closed
- `self-hosted-seed`：seed 填库后 tracks/lyrics 表非空 + MP3 文件在 MinIO
- 5 kind business 真实数据：query/match/metadata 返真实曲目、stream 返真 presign URL、lyrics 返真实歌词

### 5.2 集成测试
- 5 kind API + device-hub caller header + drm/audit/capability 链（扩 `route-authorize.e2e.test.ts` 加 device-hub caller case）
- capability_policy push（ops 下发）→ 5 kind 受能力约束（block/降级/allow）
- self_hosted 真实曲目全链：query→match→stream→lyrics→metadata 闭环

### 5.3 e2e（窗口C 内容侧边界）
- testcontainers postgres+minio + spawn content-backend fastify + mock device-hub caller（注入 X-Caller-Identity: device-hub + X-Device-Capability）
- 真实 self_hosted stream：mock device-hub 调 /content_stream → 拿 presigned URL → 真 HTTP GET 拉 MP3 → 校验 MP3 字节（magic header + 非空）+ 时长合理
- royalty-free 曲目真实拉取（非 mock 字节）
- third_party mock provider endpoint 跑契约透传（M2d 既有，复用）
- audit JSONL hash chain 验证（device-hub caller 记录）

### 5.4 跨窗口 e2e（defer 窗口A 主调度）
- device-hub 真实 binary + 端侧 sim jl7018 playback + ops-platform docker（复用 C2 真实云端）→ 归窗口A 阶段2 全链 e2e
- 窗口C 只提供 content-backend docker + 契约，不实现 device-hub/端侧

## 6. 非目标（明确 defer）

- cloud-ext 任何改动（链路4 agent 入口 defer 阶段3）
- device-hub HTTP client + identity 注入实现（归窗口A）
- 端侧 jl7018 MP3_DOWN consumer + playback（归窗口A）
- content_request envelope schema 落地 AgentOS shared-protocols（归窗口A，窗口C 只提议）
- 真实第三方 provider SDK/授权（defer 法务+商务）
- 终端用户 IAM/计费/多设备同步（窗口B spec §5 独立系统 defer）
- content_policy 归属重审落地（窗口B spec §5.4 跨窗口协调项，本 spec 不处理；M2d `POST /content_policy/push` 既有不动）

## 7. 跨窗口协调

| 协调项 | 对端窗口 | 本 spec 处理 |
|---|---|---|
| content_request envelope schema（device_capability 字段） | 窗口A（AgentOS shared-protocols） | U5 提议契约，窗口A 落地 |
| device-hub caller principal + `^hub:` handle 形态 | 窗口A | U5 提议，窗口A 实现 device-hub 侧 |
| capability_policy 下发 | 窗口B（ops-platform） | 窗口B 下发，content-backend 侧读（U2 消费） |
| content_policy 归属重审（ops-config schema 移除 kind） | 窗口B + 主调度 | 本 spec 不处理（§6 defer） |
| 跨窗口全链 e2e | 窗口A 主调度 | 窗口C 提供 content-backend docker + 契约 |

## 8. 决策记录

| # | 决策 | 选择 | 日期 |
|---|---|---|---|
| D1 | 窗口C scope 边界 | 只到内容侧（content-backend + cloud-ext），端侧 playback + 全链 e2e 归窗口A | 2026-07-05 |
| D2 | stream 数据源 | self_hosted 真实 royalty-free 曲目 + third_party mock endpoint 跑契约 | 2026-07-05 |
| D3 | content-adapter 入口接线 caller | device-hub 转发端侧 content_request（非 ops-platform；窗口B spec 一致） | 2026-07-05 |
| D4 | stream 投递形态 | presigned S3 URL 透传，cloud-ext 不 proxy chunk | 2026-07-05 |
| D5 | device-hub→content-backend auth | sim 明文 + X-Caller-Identity，无 secret_handle（self_hosted 路径），mTLS defer 真机/M5 | 2026-07-05 |
| D6 | 跨窗口分工 | ops 零改动（不直连 content）；device-hub + 端侧 + content_request schema 落地归窗口A；窗口C 只动 content-backend + 提议契约 | 2026-07-05 |
| D7 | 链路3 路由走向 | 走向B：device-hub 直连 content-backend，cloud-ext 回归纯 agent 工具（链路4 defer 阶段3）；扩 inbound 白名单加 device-hub + caller×backend_type 矩阵防越权 | 2026-07-05 |

## 9. 后续（本 spec 之后）

- writing-plans → bite-sized task 清单 + 全契约（紧凑档）
- plan-eng-review + codex(gpt-5.5 跨厂商) review fold
- executing-plans（content-backend repo 串行：U1 matrix 扩 → U2 capability-filter → U3 seed → U4 5 kind 接通 → U7 e2e；U5 契约提议文档；U6 cloud-ext 不改）
- requesting-code-review（fresh-context subagent + codex 跨厂商）
- verification + Verifier subagent（e2e 真实 MP3 stream 拉取验收）
- finishing + ship

相关：[[agentos-m2-content-backend-state]]（M2 contract）+ [[agentos-m2b-state]] + [[agentos-m2c-state]] + [[agentos-m3-stage1-state]] + [[agentos-m3-stage2-ops-content-boundary-state]]（窗口B 边界）+ [[agentos-main-window-state]]（主调度）+ [[agentos-m3-pre-security-spec-state]]（secret_handle contract）。
