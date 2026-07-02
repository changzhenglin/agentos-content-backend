import { describe, it, expect } from "vitest";
import { createTestDb, seedTrack, type SeedTrack } from "./helpers.js";
import { queryBusiness } from "../../src/routes/query.js";

const base: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo Fighters",
  album: "Dawn",
  duration_ms: 1000,
  cover_url: "https://x/cover.png",
  audio_object_key: "self:t1:v1",
  format: "mp3",
  bitrate: 128000,
  license: "CC",
};

describe("query e2e", () => {
  it("keyword 命中 title → ok + candidates", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await queryBusiness(db, { keywords: ["Sun"] });
    expect(r.outcome).toBe("ok");
    expect(r.backendType).toBe("self_hosted");
    expect(r.business.candidates.length).toBe(1);
    expect(r.business.candidates[0].track_id).toBe("self:t1");
    expect(r.business.candidates[0].title).toBe("Sunrise");
  });

  it("keyword 命中 artist → ok", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await queryBusiness(db, { keywords: ["Foo"] });
    expect(r.outcome).toBe("ok");
    expect(r.business.candidates[0].artist).toBe("Foo Fighters");
  });

  it("无命中 → no_result", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await queryBusiness(db, { keywords: ["Nonexistent"] });
    expect(r.outcome).toBe("no_result");
    expect(r.business.candidates.length).toBe(0);
  });

  it("空 keywords → 返回全部（no_result when 空 DB）", async () => {
    const db = createTestDb();
    const r = await queryBusiness(db, { keywords: [] });
    expect(r.outcome).toBe("no_result");
    expect(r.business.candidates.length).toBe(0);
  });

  it("business 回显 query（schema content_query 要求 envelope 含 query）", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await queryBusiness(db, { keywords: ["Sun"], intent: "search" });
    expect(r.business.query.keywords).toEqual(["Sun"]);
    expect(r.business.query.intent).toBe("search");
  });
});
