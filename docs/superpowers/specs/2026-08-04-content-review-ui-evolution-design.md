# AgentOS 内容运营审核 UI 演进 Design（ops-app 就地演进）

- 日期：2026-08-04
- 状态：设计批准（老林 2026-08-04 逐项确认，见 §8 决策点）
- 前例 spec：`docs/superpowers/specs/2026-07-03-agentos-m2b-content-review-ui-design.md`（M2b，本 spec 是其 T6 审核 UI 的演进增量；M2b 决策 B1-B10 不重议，本 spec 遵循 B2/B3/B5/B8/B9）
- 事实底稿：主窗口预研 `/Users/lcz/projects/AgentOS/.agentos/state/.agentos-content-review-ui-preresearch-2026-08-04.md`（窗口 C 产出，含消费注记）
- 架构门禁：**not-architecture-impact**（声明与 negative-claim 证据见 §11）

## 1. 目的与范围

把 content-backend ops-app（App2，port 3002，`src/ops-app.ts`）既有的 `/admin/*` 审核雏形演进为正式的内容审核工作台：待审队列 + 审核详情（完整元数据 + 试听 + 审核历史）+ 审核操作（approve/reject/revoke，含可选理由）。

范围认知（老林 2026-08-04 拍板，本 spec 的前提）：

- 平台运营（ops-platform）只管纯平台层运营（参数配置/UI 配置/终端管理）；**内容外部对接 + 内容审核归内容运营系统**，由内容域自行处理。内容运营系统的物理载体 = content-backend ops-app（就地演进，不新开仓）。
- 审核对象 = **ingest 入库准入**（曲目进目录、对设备可见之前的关口），不是 content_request 链路上的请求行为（后者目前无持久化记录，且不在本次范围）。
- 边界逻辑与 2026-07-05「content_policy 归 content-backend 自管非 ops」决策同源。

机制零重写原则：审核动作仍走 `src/review/state-machine.ts`（approve→INSERT tracks 发布 / revoke→DELETE tracks 下架 / reject / resubmit），audit 仍 emit provision/revoke 进 JSONL hash chain（M2b B4/B8）。**UI 只换壳，机制不动。**

## 2. 现状与缺口

已有（M2b 落地，证据见预研 §2.4）：

| 组件 | 位置 | 现状 |
|---|---|---|
| 登录/会话 | `src/auth/session.ts` | 静态 dev token（`CONTENT_BACKEND_ADMIN_TOKEN/OPERATOR_TOKEN` env）+ 内存 Map session，8h TTL，角色 admin/operator 两档 |
| 待审队列 | `ops-app.ts` `GET /admin/ingests` | htmx SSR 裸 table（state=pending），`requireRole("operator")` |
| 详情 | `ops-app.ts` `GET /admin/ingest/:id` | partial（ingest-detail.eta），`requireRole("operator")` |
| 审核操作 | `ops-app.ts` `POST /admin/ingest/:id/{approve,reject,revoke}` | `requireRole("admin")`，htmx partial 刷新 |
| ingest 登记 | `ops-app.ts` `POST /admin/ingest` | admin only，raw_metadata 校验（I2），本次不动 |
| 状态机 | `src/review/state-machine.ts` | transition(ingestId, action, actor) + review 记录 + tracks 发布/下架 |
| audit | `src/admin/ingest.ts` + `src/audit/` | approve→emitProvision / reject,revoke→emitRevoke，JSONL+hash chain（B8 fire-and-forget） |
| 模板 | `src/admin/templates/` | login.eta / ingest-detail.eta / ingest-form.eta / tracks.eta |
| 音频存储 | ingest.audioObjectKey + `src/storage/presign.ts` | presign 机制既有（content_stream 链路在用） |

缺口（本 spec 要补的）：

1. 队列是裸 table：无布局/导航/状态徽标/空态提示
2. 详情页无完整元数据展示（raw_metadata 全字段）、无试听、无审核历史区、无正式操作按钮区
3. 操作门 admin-only，与「admin+operator 可审」决策不符
4. reject/revoke 无理由记录（review 表只有 actor/action/at）
5. presign 懒加载路由不存在（试听无法实现）
6. 状态机 transition 疑似不校验"当前状态能否执行该动作"（待实现时核实；若无校验属审核正确性缺口）

## 3. 设计

### 3.1 页面与交互（htmx SSR，遵循 B2）

三个页面，全部在既有 `/admin/*` 路由族上扩展，eta 模板渲染：

1. **待审队列**（`GET /admin/ingests` 升级）：正式布局 = 顶部导航（待审 / 已发布曲目两入口）+ 表格（track_id / 标题 / 艺人 / 提交时间 / 状态徽标）+ 空态提示。sim 阶段简单 limit 截断，不做复杂分页筛选（审核量小）。
2. **审核详情页**（`GET /admin/ingest/:id` 升级）：
   - 元数据区：raw_metadata 全字段展示（title/artist/durationMs/format/bitrate/license/coverUrl/isrc/regionPolicy/album，缺省字段显示"未提供"）
   - 试听区（§3.2）
   - 审核历史区：该 ingest 的 review 表记录（时间/actor/action/reason）
   - 操作按钮区：按当前状态显隐——pending 显示 approve/reject；approved 显示 revoke；rejected/revoked 只显示状态说明。reject/revoke 附可选理由输入框（§3.4）
3. **已发布曲目页**（`GET /admin/tracks`）：套统一布局导航。**移除 M2b 遗留的 10s htmx 自刷新**（fold codex P1-1：原实现整页响应 swap 进 div 有嵌套/重复 ID bug；审核场景手动刷新足够，YAGNI）。

操作提交走既有 transition 路由（htmx POST + partial swap 状态徽标与按钮区）。**resubmit 不做 UI 入口**（登记方重新提交语义，归登记侧任务；状态机能力保留）。

### 3.2 试听

- ingest 带 `audioObjectKey`（非空）：详情页试听区经 htmx **懒加载**新路由 `GET /admin/ingest/:id/audio`（`requireRole("operator")`）——该路由现取 presign URL（`src/storage/presign.ts` 既有机制）返回含 `<audio controls src="<presigned>">` 的 partial。懒加载原因：presign 有过期时间，不能在页面渲染时提前嵌死。
- `audioObjectKey` 为空：试听区显示"无音频，仅元数据审核"。
- presign 取失败：试听区显示错误提示，**不阻塞审核操作**。

### 3.3 角色门调整

- 三个操作路由（approve/reject/revoke）从 `requireRole("admin")` 放宽到 `requireRole("operator")`（admin 自然包含）——落「admin+operator 可审」决策。
- 队列/详情/tracks/audio 路由保持 `requireRole("operator")`。
- ingest 登记保持 `requireRole("admin")`（登记侧不在本次范围，门不动）。
- 认证机制本身不动（B3 sim token + 内存 session；"M1c 就绪后换 OIDC/idP"演进路径保留）。

### 3.4 reason 列（schema 唯一改动）

- migration 0003：`review` 表加列 `reason text`（nullable，旧行 NULL）。
- `src/db/schema.ts` review 定义同步加 `reason`。
- `state-machine.ts` `transition()` 签名扩可选参数 `reason?: string`，INSERT review 时写入。
- `src/admin/ingest.ts` `ingestTransitionAndAudit` 透传 reason（form body 取，缺省 null）。
- UI：reject/revoke 表单附可选 textarea（name=reason，不强制，长度上限 1000 字符防呆）。

### 3.5 状态机防御

实现时先核实 `transition()` 是否校验当前状态合法性（如 rejected 的 ingest 不应再 approve）：

- 已有校验 → 不动；
- 无校验 → 补合法转换矩阵（pending→approve/reject；approved→revoke；rejected/revoked→resubmit），非法转换抛错，HTTP 层映射 409 错误页。UI 按钮显隐是第一层，状态机校验是防御层，两层都要有。
- **并发防御（fold codex P1-5）**：状态 UPDATE 必须带旧状态条件（CAS：`UPDATE ingest SET state=$1 WHERE id=$2 AND state=$3`，rowCount=0 → 抛 INVALID_TRANSITION）——先 SELECT 后无条件 UPDATE 存在 TOCTOU（两审核员并发 approve/reject 可致状态/review/tracks 不一致）。review 记录 ID 改用 randomUUID（`r${Date.now()}` 同毫秒可碰撞）。已知边界：ContentDb port 无事务 API（pg-mem 约束），CAS 保证状态转换原子，tracks 投影的失败窗口仅剩"并发双 approve 且 CAS 后 INSERT 前进程崩溃"极端场景。

### 3.6 数据流

```text
审核员 → GET /admin/ingests（队列）→ GET /admin/ingest/:id（详情：
  元数据 + review 历史 + 按状态显隐的按钮）
  ↳ 试听：GET /admin/ingest/:id/audio → presign → <audio> partial
审核员点 approve/reject(+reason)/revoke(+reason)
  → POST /admin/ingest/:id/{action}（requireRole("operator")）
  → ingestTransitionAndAudit(db, id, action, actor, reason)
    → state-machine.transition：校验状态合法性 → UPDATE ingest.state
      → INSERT review(actor, action, reason, at)
      → approve: INSERT tracks（发布）/ revoke: DELETE tracks（下架）
    → audit emit（approve→provision / reject,revoke→revoke；B8 fire-and-forget）
  → htmx partial 刷新状态徽标 + 按钮区
```

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| ingest 不存在 | 404 JSON errBody（现状 NOT_FOUND 语义保持，M2b fix #2 先例） |
| 非法状态转换（§3.5） | 409 + 自包含 HTML partial：错误文案含**当前状态** + 返回详情链接（状态已变，不提供重试——fold wave 2 定形）；htmx 4xx 默认不 swap，页面须配 responseHandling，见 §4.1 |
| reason 超 1000 字符 | 400 + 自包含 HTML partial：错误文案 + **可重试表单**（textarea 回填 reason + 重试按钮）+ 返回详情链接 |
| presign 失败 / 音频加载失败 | 试听区错误提示 / 浏览器原生降级；不阻塞审核操作 |
| 未登录 | 401 JSON（现状 requireRole 行为，不重定向） |
| 角色不足 | 403 JSON（现状 requireRole 行为） |
| DB/渲染异常 | errBody 形状 JSON 错误响应（现状） |

### 4.1 htmx 4xx swap 配置（fold codex P1-2）

仓内 htmx 2.0.4 默认 `responseHandling` 对 `[45]..` 为 `swap:false,error:true`——400/409 的 HTML partial 不会被换进页面。所有 admin 页面 head 在 htmx.min.js 之后加：

```html
<script>htmx.config.responseHandling = [{ code: ".*", swap: true }];</script>
```

## 5. 测试矩阵（TDD，先写失败测试）

integration（fastify inject 模式，对齐 M2b T6）：

| # | 测试 | 判据 |
|---|---|---|
| 1 | 登录 → 队列渲染 | 200 + 表格含 pending 条目 + 布局导航 |
| 2 | 详情渲染（有音频 / 无音频两态） | 元数据全字段 + 试听区分支正确 |
| 3 | presign 懒加载路由 | 有 audioObjectKey→audio partial；无→无音频提示；取失败→错误提示 |
| 4 | approve/reject/revoke transition | ingest.state 变更 + review 记录落库 + approve→tracks 出现 / revoke→tracks 消失 |
| 5 | reason 记录 | reject/revoke 带 reason→review.reason 落库；不带→NULL |
| 6 | audit emit | approve→provision / reject,revoke→revoke 事件进 sink（配置时） |
| 7 | 权限门 | operator 可操作；未登录 401；viewer 档不存在（两档制） |
| 8 | 非法状态转换被拒 | rejected 再 approve→409（§3.5 防御 + CAS） |
| 9 | reason 超长 | >1000 字符→400 回填 |
| 10 | XSS 转义回归 | reason/元数据含 `<img onerror>`/引号/& → 页面仅含 eta 转义后文本（autoEscape 默认开，测试锁定） |
| 11 | form-urlencoded 空格 | 真实浏览器 `+` 编码的 reason 落库为空格（解析器修复回归） |

- 既有测试零回归（执行时全量跑，数量以实际为准）。
- sim e2e 演示（对齐 M2b T8 模式）：ingest 登记 → 审核页操作 → tracks 发布/下架真实可观察（非 mock 断言）。

## 6. 验收标准

```text
1. 既有测试全量零回归 + §5 新增测试全 PASS
2. sim e2e 可演示：ingest → 待审队列可见 → 详情试听（有音频条目）→ approve → tracks 页可见；revoke → tracks 消失（真实可观察行为）
3. reject/revoke 理由落 review 表，审核历史区可见
4. operator 角色可执行全部审核操作（权限门放宽生效）
5. 非法状态转换被拒（409），状态机校验测试覆盖
6. presign 懒加载：URL 现取现用，不预嵌
```

## 7. 决策点（老林 2026-08-04 确认）

| ID | 决策 | 选定 | 理由 |
|---|---|---|---|
| D1 | 审核对象 | ingest 入库准入（非 content_request 请求） | content_request 链路无持久化记录且是读访问；入库关口才是内容准入审点 |
| D2 | 系统载体 | content-backend ops-app 就地演进，不新开仓 | 审核机制全在 content-backend；拆仓引入跨仓调用无收益 |
| D3 | 技术栈 | htmx SSR 打磨（无前端构建链） | 遵循 M2b B2；审核场景交互 htmx 全能承载 |
| D4 | 范围 | 只做审核侧；ingest 登记页保持现状 | 登记含音频上传，范围接近翻倍，独立任务后做 |
| D5 | 权限 | admin+operator 可审核操作（放宽操作门） | operator 是日常操作执行者；不加新权限机制 |
| D6 | 试听 | HTML5 audio + presign 懒加载；无音频显示提示 | presign 有过期时间必须现取；审音乐内容需要听 |
| D7 | reason 列 | 保留（review.reason nullable + transition 可选参数） | audit 追溯 + 将来登记侧 resubmit 需要拒因 |
| D8 | 认证 | 维持 B3 sim token，不升级 | sim 阶段 YAGNI；M1c OIDC 演进路径保留 |

## 8. 非目标（surgical 边界）

不做：ingest 登记页升级 / resubmit UI 入口 / 认证体系升级 / content_policy 归属重审（独立 follow-up）/ 音频上传 / 复杂筛选分页批量操作 / content_request 请求审核 / ops-platform 侧任何改动。

## 9. known holes（如实标注）

1. `AUDIT_SINK_PATH` 默认空 → audit emit 静默 no-op；审核动作仍有 review 表记录兜底，JSONL 链依赖部署配置（M2b B8 既定，不改）。
2. sim 认证（静态 token + 内存 session）不适合生产；演进路径 = M1c OIDC/idP（session.ts 注释既定）。
3. resubmit 无 UI 入口（登记侧任务），rejected/revoked 条目暂只能看不能重新提交。
4. content_policy 归属张力（ops-config schema 仍含 content_policy kind）不在本任务闭合。
5. 队列分页为简单 limit（100 条截断），审核量大后需升级（sim 阶段量小）。
6. ContentDb port 无事务 API（pg-mem 约束）：CAS 保证状态转换原子，tracks 投影无事务包裹，极端崩溃场景存在微小不一致窗口（fold codex P1-5 边界说明）。
7. form-urlencoded 解析器 `+`→空格修复影响既有 ingest 登记表单路径（同一解析器）；该路径既有 e2e 用 %20 编码未暴露此 bug，修复后两路径一致。
8. CLI 入口（`tsx src/ops-app.ts`）的试听接线无自动化测试（模块入口），SDD 阶段手动启动验证一次。

## 10. 与上游关系

| 上游 | 本 spec 消费 |
|---|---|
| M2 spec §8.1 审核状态机 | 机制零重写，UI 演进 + reason 扩展 + 状态校验防御 |
| M2b spec（B2/B3/B4/B5/B8） | 遵循不重议；本 spec 是其 T6 UI 演进增量 |
| M3-pre §4.7 audit schema | 不扩 enum，provision/revoke 既有事件复用 |
| 2026-07-05 content_policy 归属决策 | 边界逻辑同源引用；content_policy 通道不动 |

## 11. 架构门禁声明（not-architecture-impact）

touched files（预期）：`src/ops-app.ts` / `src/admin/views.ts` / `src/admin/templates/*.eta` / `src/admin/ingest.ts` / `src/review/state-machine.ts` / `src/db/schema.ts` / `src/db/migrations/0003_*.sql` / 测试文件。

negative-claim 证据：

- 不触 frozen 契约顶层：content-request-envelope.schema.json / content-contract.schema.json / ops-event.schema.json / ops-config-envelope.schema.json / device-hub contract.h envelope 顶层——本任务全不触碰；
- 不新增 auth 层：认证维持 M2b B3 现状（sim token + session），只放宽既有 requireRole 档位；
- 不改链路协议：content_request 五 kind route 零改动，ops-event enum 零改动，无新 WS 消息；
- 不新增子系统/系统边界/身份域：ops-app（App2）是 M2b 既有组件的就地演进；
- DB schema 变更（review.reason 列）是 content-backend 自管库，非跨仓契约。

## 12. Self-Review

- Placeholder scan：无 TBD/TODO；接口改动点（migration/签名/路由）全具体。
- Internal consistency：§3.5 状态校验与 §4 的 409 映射一致；§3.4 reason 链（UI→route→ingest.ts→state-machine→review 表）逐环对应；§7 决策与 §3 设计逐项对应。
- Scope check：单 spec 单 plan 可承载（预计 ≤8 task TDD）；登记侧/认证升级/content_policy 显式出界。
- Ambiguity check：「操作门放宽」明确到三个路由；「懒加载」明确为独立路由现取 presign；reason 长度上限 1000 明确。
