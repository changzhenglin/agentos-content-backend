# content-backend capability 三层语义

> P6 单元 2 §6.2 统一决策。三层"分裂"是有意设计，不是 bug。

| 层 | 载体 | mock 语义 | 职责 |
|---|---|---|---|
| 契约值域 | `schemas/content-contract.schema.json:11` enum | **接受** mock | sim/unit 证据值域：mock provenance 响应是合法 sim 证据 |
| runtime floor | `src/envelope.ts:16-18` CapabilityMode type | **排除** mock（real/degraded/unavailable） | production 执行 floor：content-backend 运行时不产出 mock 响应 |
| env 开关 | `CAPABILITY_MODE` env（`src/env.ts:76-83`） | 只控 auth stub passthrough | 运行 profile 开关（region/entitlement/mTLS stub），**不是**响应 provenance |

## 解耦关系

- `CAPABILITY_MODE=mock` → `token-verify-hook.ts:178-184` region/entitlement stub passthrough（debug 日志），**不写入**响应 `capability_mode`。
- 响应 `capability_mode` 来自 handler/path-select（`src/content/path-select.ts:45-65`）/wrapEnvelope，值域 real/degraded/unavailable。
- schema 保留 mock 供 sim 证据；runtime 拒 mock 保 production floor。两者语义解耦。

## 跨仓约束

cloud-ext 消费 content 响应时按统一语义判：production profile 拒收 `capability_mode:"mock"` 响应
（cloud-ext `src/adapters/content-adapter.ts`，P6 单元 2 Task 6）。
