import { describe, expect, it } from "vitest";
import { parseRange } from "../src/http/range.js";

describe("parseRange", () => {
  it("returns none without a header", () => {
    expect(parseRange(undefined, 100)).toEqual({ type: "none" });
    expect(parseRange(null, 100)).toEqual({ type: "none" });
  });

  it("parses a closed range", () => {
    expect(parseRange("bytes=10-20", 100)).toEqual({ type: "ok", start: 10, end: 20 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=10-", 100)).toEqual({ type: "ok", start: 10, end: 99 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-20", 100)).toEqual({ type: "ok", start: 80, end: 99 });
  });

  it("clamps a suffix larger than the file", () => {
    expect(parseRange("bytes=-500", 100)).toEqual({ type: "ok", start: 0, end: 99 });
  });

  it("clamps an end past the file", () => {
    expect(parseRange("bytes=50-500", 100)).toEqual({ type: "ok", start: 50, end: 99 });
  });

  it("rejects a start past the file", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ type: "unsatisfiable" });
  });

  it("rejects an inverted range", () => {
    expect(parseRange("bytes=50-10", 100)).toEqual({ type: "unsatisfiable" });
  });

  it("rejects a zero-length suffix", () => {
    expect(parseRange("bytes=-0", 100)).toEqual({ type: "unsatisfiable" });
  });

  it("treats malformed and multi-range headers as absent", () => {
    expect(parseRange("bytes=abc", 100)).toEqual({ type: "none" });
    expect(parseRange("items=0-10", 100)).toEqual({ type: "none" });
    expect(parseRange("bytes=0-10,20-30", 100)).toEqual({ type: "none" });
    expect(parseRange("bytes=-", 100)).toEqual({ type: "none" });
  });

  it("is unsatisfiable for an empty file", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ type: "unsatisfiable" });
  });
});
