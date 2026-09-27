import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";
import {
  DAY_TTL_SECONDS,
  getUserUsage,
  markUsageSince,
  recordCommandUse,
  recordUpload,
  seedUsageFromFiles,
  USER_DAY_KEY,
  utcDay,
} from "../src/storage/usage.js";
import { checkRateLimit, peekRateLimit } from "../src/storage/ratelimit.js";
import { saveRecord } from "../src/storage/store.js";

let h: Harness;
afterEach(() => h?.cleanup());

const NOW = Date.UTC(2026, 8, 27, 23, 59, 30); // 30s before UTC midnight
const DAY = 86_400_000;

describe("per-user usage", () => {
  it("writes daily and all-time command counts with a TTL", async () => {
    h = await makeHarness();
    await recordCommandUse(h.deps.redis, "upload", "u1", NOW);
    await recordCommandUse(h.deps.redis, "upload", "u1", NOW);
    await recordCommandUse(h.deps.redis, "gallery", "u1", NOW);
    const key = USER_DAY_KEY("u1", "2026-09-27");
    expect(await h.deps.redis.hgetall(key)).toEqual({
      "cmd:upload": "2",
      "cmd:gallery": "1",
    });
    expect(await h.deps.redis.ttl(key)).toBeGreaterThan(DAY_TTL_SECONDS - 5);
    expect(await h.deps.redis.hgetall("usage:u1:cmds")).toEqual({
      upload: "2",
      gallery: "1",
    });
  });

  it("zero-fills the series and ends on today even across midnight", async () => {
    h = await makeHarness();
    await recordUpload(h.deps.redis, "u1", 100, NOW - DAY);
    await recordUpload(h.deps.redis, "u1", 50, NOW);
    await recordUpload(h.deps.redis, "u1", 7, NOW + 60_000); // tomorrow, UTC
    const usage = await getUserUsage(h.deps.redis, "u1", 7, NOW);
    expect(usage.series).toHaveLength(7);
    expect(usage.series.at(-1)).toEqual({
      date: "2026-09-27",
      uploads: 1,
      bytes: 50,
    });
    expect(usage.series.at(-2)).toEqual({
      date: "2026-09-26",
      uploads: 1,
      bytes: 100,
    });
    expect(usage.series[0]).toEqual({
      date: "2026-09-21",
      uploads: 0,
      bytes: 0,
    });

    const tomorrow = await getUserUsage(h.deps.redis, "u1", 7, NOW + 60_000);
    expect(tomorrow.series.at(-1)).toEqual({
      date: "2026-09-28",
      uploads: 1,
      bytes: 7,
    });
  });

  it("sums the previous equal period and range command counts", async () => {
    h = await makeHarness();
    await recordUpload(h.deps.redis, "u1", 10, NOW - 8 * DAY);
    await recordUpload(h.deps.redis, "u1", 20, NOW - 9 * DAY);
    await recordCommandUse(h.deps.redis, "stats", "u1", NOW - 2 * DAY);
    await recordCommandUse(h.deps.redis, "stats", "u1", NOW - 20 * DAY);
    const usage = await getUserUsage(h.deps.redis, "u1", 7, NOW);
    expect(usage.previous).toEqual({ uploads: 2, bytes: 30 });
    expect(usage.commandsInRange).toEqual({ stats: 1 });
    expect(usage.commandsAllTime).toEqual({ stats: 2 });
  });

  it("seeds from existing files exactly once, skipping records older than 100 days", async () => {
    h = await makeHarness();
    const rec = (id: string, createdAt: number, size: number) =>
      saveRecord(h.deps.redis, {
        id,
        name: "a.png",
        mime: "image/png",
        kind: "image",
        size,
        width: 1,
        height: 1,
        createdAt,
        expiresAt: 0,
        userId: "u1",
        channelId: "c",
      });
    await rec("a", NOW - DAY, 5);
    await rec("b", NOW - DAY, 6);
    await rec("c", NOW - 200 * DAY, 9);

    expect(await seedUsageFromFiles(h.deps.redis, NOW)).toBe(2);
    expect(await seedUsageFromFiles(h.deps.redis, NOW)).toBeNull();
    expect(
      await h.deps.redis.hgetall(USER_DAY_KEY("u1", utcDay(NOW - DAY))),
    ).toEqual({ uploads: "2", bytes: "11" });
  });

  it("records trackingSince once", async () => {
    h = await makeHarness();
    await markUsageSince(h.deps.redis, 1000);
    await markUsageSince(h.deps.redis, 2000);
    expect((await getUserUsage(h.deps.redis, "u1", 7, NOW)).trackingSince).toBe(
      1000,
    );
  });

  it("rejects when the pipeline returns an error tuple", async () => {
    h = await makeHarness();
    const originalPipeline = h.deps.redis.pipeline.bind(h.deps.redis);
    h.deps.redis.pipeline = (() => {
      const fake = {
        hgetall: () => fake,
        get: () => fake,
        exec: async () => [[new Error("redis down"), undefined]],
      };
      return fake;
    }) as typeof h.deps.redis.pipeline;

    await expect(getUserUsage(h.deps.redis, "u1", 7, NOW)).rejects.toThrow(
      "redis down",
    );

    h.deps.redis.pipeline = originalPipeline;
  });
});

describe("peekRateLimit", () => {
  it("reports usage without spending any", async () => {
    h = await makeHarness();
    await checkRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    const a = await peekRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    const b = await peekRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    expect(a).toEqual(b);
    expect(a.remaining).toBe(2);
    expect(a.allowed).toBe(true);
  });

  it("clamps remaining at 0 after rejected attempts", async () => {
    h = await makeHarness();
    for (let i = 0; i < 5; i++)
      await checkRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    const p = await peekRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    expect(p.remaining).toBe(0);
    expect(p.allowed).toBe(false);
  });
});
