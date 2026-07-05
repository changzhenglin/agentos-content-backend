# content_request envelope 契约提议（M3 阶段2 U5）

> 窗口C 提议，schema 落地归窗口A（AgentOS 主仓 `shared-protocols/schemas/`）。
> 本文档是契约提议，非落地实现。窗口C 在 content-backend 侧消费 `X-Device-Capability` header（Task 2），schema 落地后可切到 envelope 字段。

## 1. device_capability 字段

content_request envelope 扩 `device_capability` 字段（端侧能力声明，device-hub 转发时注入）：

```json
{
  "kind": "content_stream",
  "track_id": "self:track1",
  "device_capability": {
    "kinds": ["content_query","content_match","content_stream","content_lyrics","content_metadata"],
    "formats": ["mp3"],
    "max_bitrate": 128000,
    "region": "cn"
  }
}
```

字段语义：
- `kinds`: 端侧支持的 kind 列表
- `formats`: 支持的音频格式（mp3/aac/flac）
- `max_bitrate`: 最大比特率（bps）
- `region`: 端侧 region（与 drm region_restrict 交互）

## 2. device-hub caller principal + ^hub: secret_handle 形态

- `X-Caller-Identity: device-hub`（inbound 白名单，self_hosted 路径）
- `^hub:` secret_handle 前缀（真机/secret-store 落地后；sim 阶段不发 handle，trust network）
- device-hub 只允许 `self_hosted` backend_type（caller×backend_type 矩阵，Task 1；third_party 路径由 cloud-ext agent 链路4 触发）
- 真机 mTLS + 真 handle defer M3-pre secret store SDD

## 3. sim known hole（review fold P1#2）

sim 阶段 device-hub 可伪造 `X-Caller-Identity: cloud-ext` + 无 handle → `receiveAndAuthorize` !handle 短路 authorized as cloud-ext → 可调 third_party（caller×backend_type 矩阵被 header 伪造击穿）。

- 这是 sim trust network + mTLS defer 的既有局限（M2d 既有 cloud-ext 无 handle + third_party 200 是设计行为）
- 不修（加 handle 要求会破坏 M2d 既有）
- remediation：真机/M5 mTLS 绑定 caller cert，不再信任 X-Caller-Identity header
- Task 6 e2e 加 test 验证 spoof 路径（当前 200，标 known hole）

## 4. 归属

- schema 落地：AgentOS 主仓 `shared-protocols/schemas/content-request-envelope.schema.json`（窗口A）
- device-hub 侧实现（HTTP client + identity 注入）：窗口A
- content-backend 侧消费：本窗口（Task 2 capability-filter 消费 `X-Device-Capability` header，schema 落地后切 envelope 字段）
- error_code `CAPABILITY_UNSUPPORTED`：已加到 content-contract.schema.json（三 repo 同步：AgentOS `d7ccda6` + cloud-ext `6438b8c` + content-backend `d7722d6`）
