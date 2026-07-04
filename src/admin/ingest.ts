// ingest.ts — ingest 入库 + I2 边界校验 + transition+audit（spec §8.1 + I2 hardening）。
//
// raw_metadata 字段名 camelCase 对齐 state-machine.ts approve 解析
// （meta.durationMs/coverUrl/isrc/regionPolicy/album），fold codex P1#7/eng I2。
// audit target 非空：ingestTransitionAndAudit 先 fetchIngest 取 trackId 再 emit
// （fold eng I1/ceo I2，避免 transition 内部不可见导致 target 空）。
import type { ContentDb } from "../content/db.js";
import { transition } from "../review/state-machine.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { emitProvision, emitRevoke } from "../audit/audit-events.js";

// I2 边界校验：camelCase 必填字段（对齐 state-machine approve 解析）
const REQUIRED = ["title", "artist", "durationMs", "format", "bitrate", "license"];

export function validateRawMetadata(raw: any): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") return ["raw_metadata must be object"];
  for (const f of REQUIRED) {
    if (raw[f] == null) errs.push(`missing ${f}`);
  }
  if (raw.durationMs != null && typeof raw.durationMs !== "number") {
    errs.push("durationMs must be number");
  }
  return errs;
}

export async function ingestCreate(
  db: ContentDb,
  trackId: string,
  rawMetadata: any,
  audioObjectKey: string | null,
) {
  const id = `ing_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.query(
    "INSERT INTO ingest (id, track_id, source, raw_metadata, audio_object_key, state) VALUES ($1,$2,$3,$4,$5,'pending')",
    [id, trackId, "admin-ui", JSON.stringify(rawMetadata), audioObjectKey],
  );
  return { id, state: "pending" as const, trackId };
}

// fetchIngest 取 trackId（fold eng I1：audit target 非空，避免 transition 内部不可见）
async function fetchIngestTrackId(
  db: ContentDb,
  ingestId: string,
): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT track_id FROM ingest WHERE id = $1 LIMIT 1",
    [ingestId],
  );
  return rows[0]?.track_id != null ? String(rows[0].track_id) : null;
}

export async function ingestTransitionAndAudit(
  db: ContentDb,
  auditSink: AuditSink | undefined, // I2 fix: pass-through undefined（emit 函数已 guard）
  ingestId: string,
  action: "approve" | "reject" | "revoke",
  actor: string,
): Promise<{ trackId: string | null }> {
  // 先取 trackId 再 transition（target 非空，fold eng I1）
  const trackId = await fetchIngestTrackId(db, ingestId);
  await transition(db, ingestId, action, actor);
  if (action === "approve" && trackId) {
    await emitProvision(auditSink, { ingestId, trackId, actor });
  }
  // fold codex P1#4：spec §8.3 audit matrix 行"审核拒绝/下架（rejected/revoked）→revoke"——reject 也 emit revoke
  if ((action === "reject" || action === "revoke") && trackId) {
    await emitRevoke(auditSink, { trackId, actor });
  }
  return { trackId };
}
