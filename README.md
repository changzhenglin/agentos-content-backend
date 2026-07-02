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
