import { describe, expect, it } from "vitest";
import { formatClock, formatDay, formatDelta } from "./format";

describe("format", () => {
  it("formats a UTC day label", () =>
    expect(formatDay("2026-09-27")).toBe("27 Sep"));
  it("formats a clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(2_472_000)).toBe("41:12");
    expect(formatClock(-5)).toBe("0:00");
  });
  it("describes change vs the previous period", () => {
    expect(formatDelta(5, 3)).toEqual({ text: "▲ 2 vs prev", dir: "up" });
    expect(formatDelta(1, 3)).toEqual({ text: "▼ 2 vs prev", dir: "down" });
    expect(formatDelta(3, 3)).toEqual({ text: "same as prev", dir: "flat" });
  });
});
