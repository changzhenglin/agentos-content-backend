import { describe, it, expect } from "vitest";
import { createTestDb, seedTrack, seedLyrics, type SeedTrack } from "./helpers.js";
import { lyricsBusiness } from "../../src/routes/lyrics.js";

const base: SeedTrack = {
  track_id: "self:t1",
  title: "Sunrise",
  artist: "Foo",
  duration_ms: 1000,
  audio_object_key: "self:t1:v1",
  format: "mp3",
  bitrate: 128000,
  license: "CC",
};

describe("lyrics e2e", () => {
  it("非 restricted license → ok + lines（按 line_index 排序）", async () => {
    const db = createTestDb({ withLyrics: true });
    await seedTrack(db, base);
    await seedLyrics(db, "self:t1", [
      { line_index: 1, timestamp_ms: 1000, text: "hello", lyrics_license: "commercial" },
      { line_index: 0, timestamp_ms: 0, text: "intro", lyrics_license: "commercial" },
    ]);
    const r = await lyricsBusiness(db, "self:t1");
    expect(r.outcome).toBe("ok");
    expect(r.business.track_id).toBe("self:t1");
    expect(r.business.lines.length).toBe(2);
    // line_index 升序
    expect(r.business.lines[0].text).toBe("intro");
    expect(r.business.lines[1].text).toBe("hello");
  });

  it("restricted license → blocked（COPYRIGHT_RESTRICTED，解 I5）", async () => {
    const db = createTestDb({ withLyrics: true });
    await seedTrack(db, base);
    await seedLyrics(db, "self:t1", [
      { line_index: 0, timestamp_ms: 0, text: "secret", lyrics_license: "restricted" },
    ]);
    const r = await lyricsBusiness(db, "self:t1");
    expect(r.outcome).toBe("blocked");
    expect(r.business).toEqual({});
  });

  it("无歌词行 → no_result", async () => {
    const db = createTestDb({ withLyrics: true });
    await seedTrack(db, base);
    const r = await lyricsBusiness(db, "self:t1");
    expect(r.outcome).toBe("no_result");
  });

  it("tracks.license=CC 但 lyrics.lyrics_license=restricted → 仍 blocked（独立校验）", async () => {
    const db = createTestDb({ withLyrics: true });
    await seedTrack(db, { ...base, license: "CC" });
    await seedLyrics(db, "self:t1", [
      { line_index: 0, timestamp_ms: 0, text: "x", lyrics_license: "restricted" },
    ]);
    const r = await lyricsBusiness(db, "self:t1");
    expect(r.outcome).toBe("blocked");
  });
});
