import { describe, it, expect } from "vitest";
import { createTestDb, seedTrack, type SeedTrack } from "./helpers.js";
import { metadataBusiness } from "../../src/routes/metadata.js";

const base: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo",
  album: "Dawn",
  duration_ms: 240000,
  cover_url: "https://x/c.png",
  audio_object_key: "self:t1:v1",
  format: "flac",
  bitrate: 1411000,
  license: "CC",
};

describe("metadata e2e", () => {
  it("命中 → ok + 元数据字段", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await metadataBusiness(db, "self:t1");
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") throw new Error("unreachable");
    expect(r.business.track_id).toBe("self:t1");
    expect(r.business.title).toBe("Sunrise");
    expect(r.business.duration_ms).toBe(240000);
    expect(r.business.cover_url).toBe("https://x/c.png");
  });

  it("不存在 → no_result", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await metadataBusiness(db, "self:nope");
    expect(r.outcome).toBe("no_result");
  });
});
