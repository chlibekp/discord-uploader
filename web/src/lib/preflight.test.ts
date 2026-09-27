import { describe, expect, it } from "vitest";
import { preflight } from "./preflight";

const MB = 1024 * 1024;
const limits = {
  maxFileBytes: 10 * MB,
  maxUserBytes: 20 * MB,
  uploadsRemaining: 2 as number | null,
};
const f = (name: string, size: number, type = "image/png") => ({
  name,
  size,
  type,
});

describe("preflight", () => {
  it("rejects wrong types and oversize files with a reason", () => {
    const r = preflight(
      [f("a.txt", 1, "text/plain"), f("b.png", 11 * MB)],
      limits,
      100 * MB,
    );
    expect(r.errors[0]).toBe("Only images and videos are accepted");
    expect(r.errors[1]).toBe("Over the 10 MB file limit");
  });
  it("rejects a file larger than the whole quota", () => {
    const r = preflight(
      [f("a.png", 21 * MB)],
      { ...limits, maxFileBytes: 50 * MB },
      100 * MB,
    );
    expect(r.errors[0]).toBe("Bigger than your whole 20 MB quota");
  });
  it("stops at the hourly budget, counting only files that passed", () => {
    const r = preflight(
      [
        f("x.txt", 1, "text/plain"),
        f("a.png", 1),
        f("b.png", 1),
        f("c.png", 1),
      ],
      limits,
      100 * MB,
    );
    expect(r.errors).toEqual([
      "Only images and videos are accepted",
      null,
      null,
      "Over your hourly upload limit",
    ]);
  });
  it("treats a null budget as unlimited", () => {
    const r = preflight(
      [f("a.png", 1), f("b.png", 1), f("c.png", 1)],
      { ...limits, uploadsRemaining: null },
      100 * MB,
    );
    expect(r.errors).toEqual([null, null, null]);
  });
  it("warns, not blocks, when the batch needs older files evicted", () => {
    const r = preflight(
      [f("a.png", 6 * MB), f("b.png", 6 * MB)],
      limits,
      10 * MB,
    );
    expect(r.errors).toEqual([null, null]);
    expect(r.willEvict).toBe(true);
  });
});
