import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { syncSchemas } from "../../scripts/sync-schemas.js";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("sync-schemas", () => {
  const tmpSrc = join(process.cwd(), ".tmp-src");
  const tmpDst = join(process.cwd(), ".tmp-dst");

  beforeEach(() => {
    rmSync(tmpSrc, { recursive: true, force: true });
    rmSync(tmpDst, { recursive: true, force: true });
    mkdirSync(tmpSrc, { recursive: true });
    mkdirSync(tmpDst, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpSrc, { recursive: true, force: true });
    rmSync(tmpDst, { recursive: true, force: true });
  });

  it("copies when source present", () => {
    writeFileSync(join(tmpSrc, "content-contract.schema.json"), '{"a":1}');
    const r = syncSchemas(tmpSrc, tmpDst);
    expect(r.copied).toContain("content-contract.schema.json");
    expect(existsSync(join(tmpDst, "content-contract.schema.json"))).toBe(true);
  });

  it("skips when source missing (not fail)", () => {
    const r = syncSchemas(join(tmpSrc, "none"), tmpDst);
    // FILES 数组含 3 文件，全部源缺失 → skipped.length === 3
    expect(r.skipped.length).toBe(3);
    expect(r.copied).toEqual([]);
  });

  it("drifts when hash mismatch (failOnDrift throws)", () => {
    writeFileSync(join(tmpSrc, "content-contract.schema.json"), '{"new":1}');
    writeFileSync(join(tmpDst, "content-contract.schema.json"), '{"old":1}');
    expect(() => syncSchemas(tmpSrc, tmpDst, { failOnDrift: true })).toThrow(/drift/);
  });

  it("failOnDrift:false (default) records drifted without throwing", () => {
    writeFileSync(join(tmpSrc, "content-contract.schema.json"), '{"new":1}');
    writeFileSync(join(tmpDst, "content-contract.schema.json"), '{"old":1}');
    const r = syncSchemas(tmpSrc, tmpDst, { failOnDrift: false });
    expect(r.drifted).toEqual(["content-contract.schema.json"]);
    expect(readFileSync(join(tmpDst, "content-contract.schema.json"), "utf-8")).toBe('{"new":1}');
  });
});
