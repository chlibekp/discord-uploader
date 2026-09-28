import { describe, expect, it } from "vitest";
import { isBusy, nextToStart, queueReducer, type QueueItem } from "./queue";

const add = (state: QueueItem[], key: string, error: string | null = null) =>
  queueReducer(state, {
    type: "add",
    items: [{ key, name: `${key}.png`, size: 1, type: "image/png", error }],
  });

describe("upload queue", () => {
  it("adds items as queued, or failed-not-retryable when pre-checks failed", () => {
    let s = add([], "a");
    s = add(s, "b", "Only images and videos are accepted");
    expect(s.map((i) => [i.status, i.retryable])).toEqual([
      ["queued", true],
      ["failed", false],
    ]);
  });
  it("starts one at a time in order", () => {
    let s = add(add([], "a"), "b");
    expect(nextToStart(s)?.key).toBe("a");
    s = queueReducer(s, { type: "start", key: "a" });
    expect(nextToStart(s)).toBeUndefined();
    s = queueReducer(s, {
      type: "done",
      key: "a",
      result: { id: "x" } as never,
    });
    expect(nextToStart(s)?.key).toBe("b");
  });
  it("clamps progress and ignores it unless uploading", () => {
    let s = add([], "a");
    s = queueReducer(s, { type: "progress", key: "a", progress: 0.5 });
    expect(s[0]!.progress).toBe(0);
    s = queueReducer(s, { type: "start", key: "a" });
    s = queueReducer(s, { type: "progress", key: "a", progress: 7 });
    expect(s[0]!.progress).toBe(1);
  });
  it("keeps a cancelled item cancelled when its abort surfaces as a failure", () => {
    let s = queueReducer(add([], "a"), { type: "start", key: "a" });
    s = queueReducer(s, { type: "cancel", key: "a" });
    s = queueReducer(s, { type: "fail", key: "a", error: "Cancelled" });
    expect(s[0]!.status).toBe("cancelled");
  });
  it("retries failed and cancelled items but not pre-check failures", () => {
    let s = add(add([], "a"), "bad", "nope");
    s = queueReducer(s, { type: "start", key: "a" });
    s = queueReducer(s, { type: "fail", key: "a", error: "429" });
    s = queueReducer(s, { type: "retry", key: "a" });
    s = queueReducer(s, { type: "retry", key: "bad" });
    expect(s.map((i) => i.status)).toEqual(["queued", "failed"]);
  });
  it("reports busy and clears finished rows", () => {
    let s = add(add([], "a"), "b");
    expect(isBusy(s)).toBe(true);
    s = queueReducer(s, { type: "start", key: "a" });
    s = queueReducer(s, { type: "done", key: "a", result: {} as never });
    s = queueReducer(s, { type: "clearFinished" });
    expect(s.map((i) => i.key)).toEqual(["b"]);
  });
});
