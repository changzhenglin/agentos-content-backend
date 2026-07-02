import { compileFromFile } from "json-schema-to-typescript";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import $RefParser from "@apidevtools/json-schema-ref-parser";

// content-contract 的 track/runtime_mode $ref 是绝对 URL (https://agentos.dev/schemas/...)
// 须先 dereference：按 $id 映射本地 sync 的 track.schema.json / runtime-mode.schema.json，
// 否则 json-schema-to-typescript 走默认 http resolver 拿不到本地文件，生成 any（plan-eng C3 Critical）。
const localSchemas: Record<string, object> = {
  "https://agentos.dev/schemas/track.schema.json": JSON.parse(
    readFileSync("schemas/track.schema.json", "utf8")
  ),
  "https://agentos.dev/schemas/runtime-mode.schema.json": JSON.parse(
    readFileSync("schemas/runtime-mode.schema.json", "utf8")
  ),
};

// 自定义 resolver：按 $id 命中本地 sync 的 schema，阻断远程 HTTP 拉取
const agentosLocalResolver = {
  order: 1,
  canRead: true as const,
  read(info: any) {
    const id = typeof info === "string" ? info : info.url;
    return localSchemas[id] ?? undefined;
  },
};

const $refOptions = { resolve: { agentosLocal: agentosLocalResolver } };

async function main() {
  // 先 bundle 验证 $ref 可解（in-place dereference，发现解析问题早 fail）
  const bundle = JSON.parse(
    readFileSync("schemas/content-contract.schema.json", "utf8")
  );
  await $RefParser.bundle(bundle, { resolve: { agentosLocal: agentosLocalResolver } });

  const out = "generated/content-contract.ts";
  mkdirSync("generated", { recursive: true });
  const code =
    "// AUTO-GENERATED from schemas/content-contract.schema.json — do not edit. Run `pnpm gen` to regenerate.\n" +
    (await compileFromFile("schemas/content-contract.schema.json", {
      bannerComment: "",
      $refOptions,
    }));
  writeFileSync(out, code);
  console.log(`generated ${out} (${code.split("\n").length} lines)`);
}

await main();
