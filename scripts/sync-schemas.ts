import { copyFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// content-contract 的 track/runtime_mode $ref 是绝对 URL (https://agentos.dev/schemas/...)
// 这里 sync 这 3 个 schema：content-contract 自身 + 其远程 $ref 引用的 track + runtime-mode
const FILES = [
  "content-contract.schema.json",
  "track.schema.json",
  "runtime-mode.schema.json",
];

export interface SyncResult {
  copied: string[];
  skipped: string[];
  drifted: string[];
}

// 对齐 ops-platform sync-schemas：源缺失 skip / 漂移 fail（哈希比对）。
// 三字段 result {copied, skipped, drifted}（plan-eng I7/I8 对齐 ops-platform）。
export function syncSchemas(
  sourceDir: string,
  targetDir: string,
  opts: { failOnDrift?: boolean } = {}
): SyncResult {
  const copied: string[] = [];
  const skipped: string[] = [];
  const drifted: string[] = [];
  mkdirSync(targetDir, { recursive: true });
  for (const f of FILES) {
    const s = join(sourceDir, f);
    const d = join(targetDir, f);
    if (!existsSync(s)) {
      skipped.push(f);
      continue;
    }
    const sContent = readFileSync(s, "utf-8");
    if (existsSync(d)) {
      const dContent = readFileSync(d, "utf-8");
      const sHash = createHash("sha256").update(sContent).digest("hex");
      const dHash = createHash("sha256").update(dContent).digest("hex");
      if (sHash !== dHash) {
        drifted.push(f);
        if (opts.failOnDrift) {
          throw new Error(`schema drift: ${f}（源与目标哈希不一致，须 pnpm sync 更新或人工核对）`);
        }
      }
    }
    copyFileSync(s, d);
    copied.push(f);
  }
  return { copied, skipped, drifted };
}

// CLI 入口 guard：仅直接执行时跑，避免单测 import 触发真实 sync（对齐 ops-platform codex finding 1）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const SRC =
    process.env.AGENTOS_SHARED_PROTOCOLS ??
    join(process.cwd(), "..", "AgentOS", "shared-protocols", "schemas");
  const DST = join(process.cwd(), "schemas");
  const r = syncSchemas(SRC, DST, { failOnDrift: true });
  console.log(`sync: copied=${r.copied} skipped=${r.skipped} drifted=${r.drifted}`);
}
