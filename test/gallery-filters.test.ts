import { describe, expect, it } from "vitest";
import {
  SORT_MODES,
  filterRecords,
  formatRemaining,
  matchesFilter,
  sortRecords,
} from "../public/gallery-filters.js";

describe("matchesFilter", () => {
  it("matches case-insensitively", () => {
    expect(matchesFilter("Vacation.PNG", "vac")).toBe(true);
    expect(matchesFilter("Vacation.PNG", "VACATION")).toBe(true);
  });

  it("matches everything for an empty or blank query", () => {
    expect(matchesFilter("anything.mp4", "")).toBe(true);
    expect(matchesFilter("anything.mp4", "   ")).toBe(true);
  });

  it("rejects a non-matching substring", () => {
    expect(matchesFilter("cat.png", "dog")).toBe(false);
  });
});

describe("filterRecords", () => {
  const records = [{ name: "cat.png" }, { name: "dog.png" }, { name: "catfish.mp4" }];

  it("keeps only records whose name matches", () => {
    expect(filterRecords(records, "cat").map((r) => r.name)).toEqual(["cat.png", "catfish.mp4"]);
  });

  it("returns everything for an empty query", () => {
    expect(filterRecords(records, "")).toHaveLength(3);
  });
});

describe("sortRecords", () => {
  const a = { id: "a", createdAt: 100, size: 30, expiresAt: 5000 };
  const b = { id: "b", createdAt: 300, size: 10, expiresAt: 0 };
  const c = { id: "c", createdAt: 200, size: 20, expiresAt: 2000 };
  const records = [a, b, c];

  it("orders newest first", () => {
    expect(sortRecords(records, "newest").map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("orders oldest first", () => {
    expect(sortRecords(records, "oldest").map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("orders largest first", () => {
    expect(sortRecords(records, "largest").map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("orders smallest first", () => {
    expect(sortRecords(records, "smallest").map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("orders soonest-to-expire first, with never-expiring files last", () => {
    expect(sortRecords(records, "soonest").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...records];
    sortRecords(records, "oldest");
    expect(records).toEqual(copy);
  });

  it("falls back to newest for an unknown mode", () => {
    expect(sortRecords(records, "bogus").map((r) => r.id)).toEqual(sortRecords(records, "newest").map((r) => r.id));
  });

  it("exposes every mode used by the sort control", () => {
    expect(SORT_MODES).toEqual(["newest", "oldest", "largest", "smallest", "soonest"]);
  });
});

describe("formatRemaining", () => {
  const now = 1_000_000_000;

  it("reports files kept forever", () => {
    expect(formatRemaining(0, now)).toBe("kept until full");
  });

  it("reports an already-passed expiry as expiring now", () => {
    expect(formatRemaining(now - 1, now)).toBe("expiring now");
  });

  it("formats days and hours remaining", () => {
    const expiresAt = now + 2 * 86_400_000 + 3 * 3_600_000;
    expect(formatRemaining(expiresAt, now)).toBe("deletes in 2d 3h");
  });

  it("formats hours and minutes once under a day", () => {
    const expiresAt = now + 5 * 3_600_000 + 20 * 60_000;
    expect(formatRemaining(expiresAt, now)).toBe("deletes in 5h 20m");
  });

  it("formats minutes and seconds once under an hour", () => {
    const expiresAt = now + 4 * 60_000 + 9_000;
    expect(formatRemaining(expiresAt, now)).toBe("deletes in 4m 9s");
  });

  it("formats bare seconds once under a minute", () => {
    expect(formatRemaining(now + 30_000, now)).toBe("deletes in 30s");
  });
});
