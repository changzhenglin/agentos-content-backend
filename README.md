# agentos-content-backend

AgentOS M2 内容后端（self-hosted only）。消费 spec PR#38（content 后端设计）+ schema PR#40（content-contract allOf conditional on DONE 正式化）。提供 5 kind 内容 API（query/match/stream/lyrics/metadata），面向 self-hosted 自建曲库；third_party 曲库接入、cloud-ext proxy、内容审核、audit 等能力在后续 milestone（M2b/M2c/M2d/M3-pre）落地。

## 定位

- self-hosted only：仅服务自建曲库（provider 前缀 `self:`），不含 third_party 接入（M2d）。
- 不直接对接 P1 设备：通过 cloud-ext proxy（M2c）转发，本服务不暴露给端侧。
- 内容审核：本服务维护 ingest/review 状态机（pending/approved/rejected/revoked），但审核 UI 在 M2b。
- audit：§4.6 stream_id / §8.3 审计日志 defer 至 M2b / M3-pre（Global Constraints 声明）。

## 开发

```bash
pnpm install

# 同步 AgentOS shared-protocols schemas（spec PR#40 的 content-contract/track/runtime-mode）
AGENTOS_SHARED_PROTOCOLS=../AgentOS/shared-protocols/schemas pnpm sync

# 生成 content-contract TS type（json-schema-to-typescript，drift test 守护）
pnpm gen

# 全套测试（含 pg-mem e2e + minio e2e，docker 不可用时 minio e2e skip）
pnpm test

# 生成 drizzle migration
pnpm db:generate
```

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串 | `postgres://localhost:5432/agentos_content` |
| `S3_ENDPOINT` | S3 兼容对象存储 endpoint（MinIO） | `http://localhost:9000` |
| `S3_REGION` | region | `us-east-1` |
| `S3_BUCKET` | bucket 名 | `agentos-content` |
| `S3_ACCESS_KEY_ID` | access key | `minioadmin` |
| `S3_SECRET_ACCESS_KEY` | secret key | `minioadmin` |
| `AGENTOS_SHARED_PROTOCOLS` | shared-protocols schemas 路径（pnpm sync 用） | — |

## API（5 kind）

所有 endpoint 均为 `POST /content_<kind>`，响应遵循 content-contract envelope（kind/version/backend_type/capability_mode/completion_state/runtime_mode + business）。

| Endpoint | 说明 |
|---|---|
| `POST /content_query` | 单曲精确查询（track_id） |
| `POST /content_match` | 模糊匹配（title/artist 关键词） |
| `POST /content_stream` | 流式播放（presigned URL + auth.token） |
| `POST /content_lyrics` | 歌词查询（lyrics 独立版权校验，restricted 时 BLOCKED） |
| `POST /content_metadata` | 元数据查询 |

completion_state 语义：`ok`（命中且可投递）/ `degraded`（命中但能力受限）/ `blocked`（命中但不可投递，backend_type=attempted 非 null）/ `not_found`（未命中）。

## seed

```bash
DATABASE_URL=postgres://... pnpm tsx scripts/seed.ts
```

模板插入 3 首 CC-licensed track（CC-BY / CC0）metadata + lyrics；可选 `S3_*` env 上传占位 audio（缺失则仅 metadata，audio 留待 ops 手动 put）。具体 royalty-free 选曲由 ops 替换。

## 限制与后续 milestone

| 项 | 状态 | 归属 |
|---|---|---|
| third_party 曲库接入 | defer | M2d |
| cloud-ext proxy（设备转发） | defer | M2c |
| content_policy（内容策略） | defer | M2b |
| 审核 UI | defer | M2b |
| audit（stream_id / §8.3） | defer | M2b / M3-pre |
| secret_handle transport-only | defer | Global Constraints |

## M2b 审核 UI + content_policy 消费通道

M2b 落地 ops-facing 审核 App（App2，mTLS sim CA）+ content_policy 消费通道（block/allow/region_restrict）+ 中央 drm-guard + audit hash chain + 审核 UI（htmx SSR）。

### 启动双 app

App1（5 kind API，port 3001）：

```bash
tsx src/index.ts
```

App2（ops-facing，port 3002，mTLS sim CA + 审核 UI）：

```bash
tsx src/ops-app.ts
```

env：

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串 | `postgres://localhost:5432/agentos_content` |
| `AUDIT_SINK_PATH` | audit JSONL 路径 | `.audit.jsonl` |
| `CONTENT_BACKEND_REGION` | backend 自持 region（drm region_restrict 判定） | `cn` |
| `CONTENT_BACKEND_ADMIN_TOKEN` | admin token（审核 UI 登录） | — |
| `CONTENT_BACKEND_OPERATOR_TOKEN` | operator token（可执行审核操作 approve/reject/revoke） | — |
| `OPS_PORT` | App2 listen 端口 | `3002` |

### sim 闭环演示

```bash
# 1. 启 App2（生成 sim CA cert + listen 3002）
OPS_PORT=3002 tsx src/ops-app.ts

# 2. mock producer push block policy（首次自动生成 .sim-certs/ 并缓存）
tsx scripts/mock-policy-producer.ts 3002 block sim-block 1

# 3. 启 App1，调 /content_stream → 403 COPYRIGHT_RESTRICTED
tsx src/index.ts  # 另一终端
curl -X POST localhost:3001/content_stream -d '{"track_id":"self:t1"}'

# 切换 allow（version 递增覆盖 block）
tsx scripts/mock-policy-producer.ts 3002 allow sim-allow 2
curl -X POST localhost:3001/content_stream -d '{"track_id":"self:t1"}'  # → 200

# region_restrict：发 X-Region: us（backend=cn，不符→403 REGION_RESTRICTED）
tsx scripts/mock-policy-producer.ts 3002 region_restrict sim-region 3
curl -X POST localhost:3001/content_stream -H 'x-region: us' -d '{"track_id":"self:t1"}'  # → 403
```

`mock-policy-producer.ts` CLI：`tsx scripts/mock-policy-producer.ts <port> <allow|block|region_restrict> <commandId> [version]`。cert 缓存于 `.sim-certs/`（首次生成 sim CA + service cert，后续复用，dev 反复跑不重复生成）。push envelope 含 upstream version（stale 拒绝 + 幂等由 policy-store 保证）。

### 审核 UI

浏览器开 `https://localhost:3002/admin/login`（sim CA self-signed，需手动信任），dev token = `CONTENT_BACKEND_ADMIN_TOKEN`。

- `/admin/login`：token 登录（admin/operator 双角色）
- `/admin/ingests`：待审核 ingest 队列（pending）
- `/admin/ingest/:id`：ingest 详情 + approve/reject/revoke（htmx partial swap）
- `/admin/ingest`（POST）：admin 入库新 ingest
- `/admin/tracks`：曲库列表

### 验收

```bash
pnpm test  # 269 passed / 29 skipped（含 sim 闭环 e2e 4 用例：block/allow/region_restrict + audit 链）
```

sim 闭环 e2e 覆盖全链：producer push → App2 接收（mTLS + audience/expiry/actor 校验）→ App1 kind 受 drm-guard 约束（block→403 / allow→200 / region_restrict+X-Region→403）→ audit hash chain（config_apply + tool_call，verifyChain 完整）。

### 审核工作台（2026-08-04 演进）

`/admin/*` 已演进为正式内容审核工作台（spec `docs/superpowers/specs/2026-08-04-content-review-ui-evolution-design.md`）：

- 页面：`/admin/ingests`（待审队列，带导航/空态）/ `/admin/ingest/:id`（详情：全元数据/试听/审核历史/操作区）/ `/admin/tracks`（已发布曲目）
- 角色：admin+operator 均可审核（approve/reject/revoke，reject/revoke 可选理由 ≤1000 字符）；ingest 登记仍仅 admin
- 试听：音频存 S3（`audioObjectKey`），详情页懒加载 presign URL（现取现用，受 `S3_*` env 影响）
- 状态机防御：非法状态转换返 409 INVALID_TRANSITION
- sim 边界不变：认证为 sim dev token + 内存 session（B3），生产由 M1c OIDC/idP 替换
