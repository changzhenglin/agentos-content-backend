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
    expect(r.business.match.track_id).toBe("self:t1");
    // track: schema track.schema 只允许 title/artist/album/duration_ms
    expect(r.business.track.title).toBe("Sunrise");
    expect(r.business.track.artist).toBe("Foo");
    expect(r.business.track.duration_ms).toBe(1000);
  });

  it("title 精确命中（无 isrc 输入，DB 有 isrc）→ ok + match.isrc 透传 DB 值", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await matchBusiness(db, { title: "Sunrise", artist: "Foo" });
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") throw new Error("unreachable");
    expect(r.business.match.title).toBe("Sunrise");
    // isrc 来自 DB row（base.isrc=ISRC123），非 null 故保留
    expect(r.business.match.isrc).toBe("ISRC123");
  });

  it("isrc=null 的 track → match.isrc 省略（schema isrc type string）", async () => {
    const db = createTestDb();
    await seedTrack(db, { ...base, isrc: undefined });
    const r = await matchBusiness(db, { title: "Sunrise", artist: "Foo" });
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") throw new Error("unreachable");
    expect(r.business.match.isrc).toBeUndefined();
  });

  it("无命中 → no_result", async () => {
    const db = createTestDb();
    await seedTrack(db, base);
    const r = await matchBusiness(db, { title: "Nope", artist: "x", isrc: "NOPE" });
    expect(r.outcome).toBe("no_result");
  });
});
