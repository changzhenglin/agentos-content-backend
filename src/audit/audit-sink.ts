// audit-sink.ts — append-only JSONL + hash chain（M3-pre §4.7 sim 机制）。
// 每事件含 prevHash + hash（sha256），断链=篡改证据。sim sink=文件，真机换外部 sink（接口不变）。
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface AuditEvent {
  eventType: "provision" | "revoke" | "config_apply" | "tool_call";
  actorType: "human" | "service";
  actor: string;
  target: string;
  traceId: string;
  streamId?: number;
  policyVersion?: number;
  prevHash: string;
  hash: string;
  ts: string;
}
export interface AuditSink {
  emit(event: Omit<AuditEvent, "prevHash" | "hash" | "ts">): Promise<void>;
}

// 创世 prevHash：全零占位（emit 与 verifyChain 共用，保证链一致性）。
const ZERO_HASH = "0".repeat(64);

function lastHash(path: string): string {
  try {
    const content = readFileSync(path, "utf8").trim();
    if (!content) return ZERO_HASH;
    const lines = content.split("\n");
    return JSON.parse(lines[lines.length - 1]).hash;
  } catch {
    return ZERO_HASH;
  }
}

/** 确定性序列化：emit 与 verifyChain 共用，键序固定（fold codex P1#5）。
 *  仅业务字段 + prevHash + ts（不含 hash 字段，否则自引用恒 false）。 */
function stringifyPayload(
  event: Omit<AuditEvent, "prevHash" | "hash" | "ts">,
  prevHash: string,
  ts: string,
): string {
  // event 入参不含 hash 字段；此处防御性剔除以防调用方误传
  const { hash: _omit, ...rest } = event as any;
  return JSON.stringify({ ...rest, prevHash, ts });
}

export function createAuditSink(path: string): AuditSink {
  return {
    async emit(event) {
      // fire-and-forget：sim 阶段写失败 log 不阻塞业务（fold devex M4 / spec §6）
      try {
        const prevHash = lastHash(path);
        const ts = new Date().toISOString();
        const hash = createHash("sha256")
          .update(stringifyPayload(event, prevHash, ts))
          .digest("hex");
        const full: AuditEvent = { ...event, prevHash, hash, ts };
        appendFileSync(path, JSON.stringify(full) + "\n");
      } catch (e) {
        console.warn("[audit-sink] emit failed (fire-and-forget):", e);
      }
    },
  };
}

/** 校验 hash chain 连续性（断链返 false）。
 *  fold codex P1#5/eng C1：重算剔 hash 字段，与 emit 同一 stringifyPayload 语义。 */
export function verifyChain(path: string): boolean {
  const content = readFileSync(path, "utf8").trim();
  if (!content) return true;
  const lines = content.split("\n");
  let prev = ZERO_HASH;
  for (const line of lines) {
    const e = JSON.parse(line) as AuditEvent;
    if (e.prevHash !== prev) return false;
    // 重算：仅业务字段 + prevHash + ts（剔 hash 字段防自引用）
    const { hash, prevHash, ts, ...rest } = e;
    const expected = createHash("sha256")
      .update(JSON.stringify({ ...rest, prevHash, ts }))
      .digest("hex");
    if (e.hash !== expected) return false;
    prev = e.hash;
  }
  return true;
}
