// policy-store.ts — content_policy 表读写 + command_id 幂等 + upstream version 排序 + stale 拒绝
// （spec §5.1/§9.3，fold codex P1#2/#3）。
// 纯函数 + ContentDb port 注入，不绑 fastify。
import type { ContentDb } from "../content/db.js";

export interface SecurityContext {
  actor: string;
  rbac_decision: object;
  target_device?: string;
  audience: string;
  expiry: string;
}

// M2d Task 3: auth_config 对齐 AgentOS ops-config.schema.json 的 auth_config def
// （option A：单 string token_ref，不改 AgentOS 仓）。
// - token_source: enum ["ops_managed", "backend_issued"]（对齐 schema $defs.auth_config.properties.token_source.enum）
// - token_ref: 单段 ^backend:<provider>-<id>（hyphen 分隔，fit ^backend:[a-zA-Z0-9_-]+$，
//   不允许冒号多段）；runtime 由 secret store resolver 换真实 token
export interface AuthConfig {
  token_source: "ops_managed" | "backend_issued";
  token_ref: string;
}

export interface PolicyEnvelope {
  command_id: string;
  kind: "content_policy";
  capability_mode: string;
  version: number; // upstream producer 侧 monotonic version（fold codex P1#2）
  payload: {
    rule_id: string;
    action: "allow" | "block" | "region_restrict";
    target_scope: string;
    auth_config?: AuthConfig; // M2d: 加（对齐 ops-config.schema.json content_policy.auth_config）
  };
  security_context: SecurityContext;
}

export interface PolicyRecord {
  ruleId: string;
  action: string;
  targetScope: string;
  version: number;
  envelope: PolicyEnvelope;
  receivedAt: string;
  supersededBy: number | null;
}

export interface PolicyStore {
  applyPolicy(
    envelope: PolicyEnvelope,
    callerIdentity: string,
  ): Promise<{ applied: boolean; version: number; superseded?: boolean }>;
  latestPolicy(): Promise<PolicyRecord[]>;
}

export function createPolicyStore(db: ContentDb): PolicyStore {
  return {
    async applyPolicy(envelope, callerIdentity) {
      // command_id 幂等查重
      const { rows: dup } = await db.query(
        "SELECT version FROM content_policy WHERE command_id = $1 LIMIT 1",
        [envelope.command_id],
      );
      if (dup[0]) return { applied: false, version: Number(dup[0].version) };

      // stale 检测：upstream version <= 当前 max → 拒绝（旧 policy 后到，fold codex P1#2）
      const { rows: v } = await db.query(
        "SELECT COALESCE(MAX(version),0) AS m FROM content_policy WHERE rule_id = $1",
        [envelope.payload.rule_id],
      );
      const currentMax = Number(v[0].m);
      if (envelope.version <= currentMax) {
        return { applied: false, version: currentMax, superseded: true };
      }

      // 原子插入（unique index (rule_id,version) + command_id 防并发，fold codex P1#3）；
      // 注意：ContentDb port 无 transaction API，pg-mem 单连接无并发；真实 Postgres 由
      // unique index 兜底（INSERT 冲突抛错→调用方按 applied:false 处理）。sim 低并发可接受。
      const id = `cp_${envelope.command_id}`;
      try {
        await db.query(
          `INSERT INTO content_policy (id, rule_id, action, target_scope, version, envelope, caller_identity, command_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            envelope.payload.rule_id,
            envelope.payload.action,
            envelope.payload.target_scope,
            envelope.version,
            JSON.stringify(envelope),
            callerIdentity,
            envelope.command_id,
          ],
        );
      } catch {
        // 并发同 command_id/(rule_id,version) 冲突→幂等返回
        const { rows: d2 } = await db.query(
          "SELECT version FROM content_policy WHERE command_id = $1",
          [envelope.command_id],
        );
        if (d2[0]) return { applied: false, version: Number(d2[0].version) };
        throw new Error("BACKEND_UNAVAILABLE");
      }
      // 旧 version 标 superseded_by = 新 version
      await db.query(
        "UPDATE content_policy SET superseded_by = $1 WHERE rule_id = $2 AND version < $3 AND superseded_by IS NULL",
        [envelope.version, envelope.payload.rule_id, envelope.version],
      );
      return { applied: true, version: envelope.version };
    },
    async latestPolicy() {
      const { rows } = await db.query(
        "SELECT rule_id, action, target_scope, version, envelope, received_at, superseded_by FROM content_policy WHERE superseded_by IS NULL",
      );
      return rows.map((r: any) => ({
        ruleId: String(r.rule_id),
        action: String(r.action),
        targetScope: String(r.target_scope),
        version: Number(r.version),
        envelope: JSON.parse(r.envelope),
        receivedAt: String(r.received_at),
        supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
      }));
    },
  };
}
