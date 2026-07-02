import { describe, it, expect } from "vitest";
import { createTestDb, seedTrack, type SeedTrack } from "./helpers.js";
import { matchBusiness } from "../../src/routes/match.js";

const base: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo",
  album: "Dawn",
  duration_ms: 1000,
  cover_url: undefined,
  audio_object_key: "self:t1:v1",
  format: "mp3",
  bitrate: 128000,
  isrc: "ISRC123",
  license: "CC",
};

describe("match e2e", () => {
  it("isrc 精确命中 → ok + match+track", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await matchBusiness(db, { title: "x", artist: "y", isrc: "ISRC123" });
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") throw new Error("unreachable");
    expect(r.business.match.isrc).toBe("ISRC123");
    expect(r.business.track.track_id).toBe("self:t1");
    expect(r.business.track.format).toBe("mp3");
    expect(r.business.track.bitrate).toBe(128000);
  });

  it("title 精确命中（无 isrc）→ ok", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await matchBusiness(db, { title: "Sunrise", artist: "Foo" });
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") throw new Error("unreachable");
    expect(r.business.match.title).toBe("Sunrise");
  });

  it("无命中 → no_result", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await matchBusiness(db, { title: "Nope", artist: "x", isrc: "NOPE" });
    expect(r.outcome).toBe("no_result");
  });
});
