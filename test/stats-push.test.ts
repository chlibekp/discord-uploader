import { describe, expect, it, vi } from "vitest";
import { makeHarness } from "./helpers.js";
import { recordCommandUse } from "../src/storage/usage.js";
import { pushDailyUserCount } from "../src/stats-push.js";

const DAY = Date.UTC(2026, 9, 1, 12);

describe("daily user count push", () => {
  it("sends the user count once per UTC day", async () => {
    const h = await makeHarness();
    try {
      await recordCommandUse(h.deps.redis, "upload", "user-1");
      await recordCommandUse(h.deps.redis, "upload", "user-2");
      const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));

      expect(await pushDailyUserCount(h.deps.redis, fetchFn, DAY)).toBe(true);
      expect(
        await pushDailyUserCount(h.deps.redis, fetchFn, DAY + 3600_000),
      ).toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      const [url, init] = fetchFn.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("https://api.stats.hegy.xyz/track");
      expect(JSON.parse(init.body as string)).toEqual({
        project: "imageuploader",
        users: 2,
      });

      expect(
        await pushDailyUserCount(h.deps.redis, fetchFn, DAY + 86_400_000),
      ).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      h.cleanup();
    }
  });

  it("retries later in the day after a failed push", async () => {
    const h = await makeHarness();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));

      expect(await pushDailyUserCount(h.deps.redis, fetchFn, DAY)).toBe(false);
      expect(await pushDailyUserCount(h.deps.redis, fetchFn, DAY)).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      h.cleanup();
    }
  });
});
