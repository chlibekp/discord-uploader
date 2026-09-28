import { describe, expect, it } from "vitest";
import { rangeSelect, toggleId } from "./selection";

const order = ["a", "b", "c", "d", "e"];

describe("selection", () => {
  it("toggles one id without mutating the input", () => {
    const start = new Set(["a"]);
    expect([...toggleId(start, "b")].sort()).toEqual(["a", "b"]);
    expect([...toggleId(start, "a")]).toEqual([]);
    expect([...start]).toEqual(["a"]);
  });
  it("adds the inclusive range between anchor and target in either direction", () => {
    expect([...rangeSelect(order, "b", "d", new Set())].sort()).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect([...rangeSelect(order, "d", "b", new Set(["a"]))].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
  it("falls back to a toggle when the anchor is missing or filtered out", () => {
    expect([...rangeSelect(order, null, "c", new Set())]).toEqual(["c"]);
    expect([...rangeSelect(order, "zzz", "c", new Set())]).toEqual(["c"]);
  });
});
