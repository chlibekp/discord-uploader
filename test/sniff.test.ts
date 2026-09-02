import { describe, expect, it } from "vitest";
import { slugifyBasename, sniff } from "../src/storage/sniff.js";
import { fixtures } from "./helpers.js";

describe("sniff", () => {
  it.each([
    ["png", fixtures.png(), "image/png", "png", "image"],
    ["jpeg", fixtures.jpeg(), "image/jpeg", "jpg", "image"],
    ["gif", fixtures.gif(), "image/gif", "gif", "image"],
    ["webp", fixtures.webp(), "image/webp", "webp", "image"],
    ["avif", fixtures.avif(), "image/avif", "avif", "image"],
    ["mp4", fixtures.mp4(), "video/mp4", "mp4", "video"],
    ["mov", fixtures.mov(), "video/quicktime", "mov", "video"],
    ["webm", fixtures.webm(), "video/webm", "webm", "video"],
  ])("identifies %s", (_label, buf, mime, ext, kind) => {
    expect(sniff(buf)).toEqual({ mime, ext, kind });
  });

  it.each([
    ["html", fixtures.html()],
    ["svg", fixtures.svg()],
    ["zip", fixtures.zip()],
  ])("rejects %s", (_label, buf) => {
    expect(sniff(buf)).toBeNull();
  });

  it("rejects a buffer too short to identify", () => {
    expect(sniff(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it("ignores a lying extension because only bytes are inspected", () => {
    // Content is HTML; the caller's ".png" name has no influence here.
    expect(sniff(fixtures.html())).toBeNull();
  });

  it("rejects Matroska that is not WebM", () => {
    const mkv = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from("matroska"),
      Buffer.alloc(64),
    ]);
    expect(sniff(mkv)).toBeNull();
  });
});

describe("slugifyBasename", () => {
  it.each([
    ["holiday photo.png", "holiday-photo"],
    ["../../etc/passwd", "etc-passwd"],
    ["..%2f..%2fboot", "2f"],
    ["ünïcodé.mp4", "unicode"],
    ["...", "file"],
    ["", "file"],
    [".hidden.png", "hidden"],
  ])("%s -> %s", (input, expected) => {
    expect(slugifyBasename(input)).toBe(expected);
  });

  it("never emits a path separator", () => {
    expect(slugifyBasename("a/b\\c.png")).not.toMatch(/[/\\]/);
  });

  it("truncates long names", () => {
    expect(slugifyBasename("x".repeat(300) + ".png")).toHaveLength(64);
  });
});
