import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDimensions } from "../public/measure.js";

/** Stands in for an <img>/<video> that fires only what a test tells it to. */
class FakeMedia extends EventTarget {
  src = "";
  preload = "";
  muted = false;
  naturalWidth = 0;
  naturalHeight = 0;
  videoWidth = 0;
  videoHeight = 0;
  loads = 0;
  constructor(readonly tagName: string) {
    super();
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {
    this.loads += 1;
  }
}

let created: FakeMedia[] = [];

beforeEach(() => {
  created = [];
  vi.useFakeTimers();
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      const el = new FakeMedia(tag);
      created.push(el);
      return el;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const video = { type: "video/quicktime" } as File;
const image = { type: "image/png" } as File;

describe("readDimensions", () => {
  it("gives up with 0x0 when the element never fires, and releases it", async () => {
    let settled: unknown = null;
    void readDimensions(video, "blob:x").then((d) => (settled = d));
    const el = created[0]!;
    expect(el.src).toBe("blob:x");

    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ width: 0, height: 0 });
    expect(el.src).toBe("");
    expect(el.loads).toBe(1);
  });

  it("gives up at once when its signal aborts", async () => {
    const ac = new AbortController();
    const pending = readDimensions(video, "blob:x", { signal: ac.signal });
    ac.abort();
    await expect(pending).resolves.toEqual({ width: 0, height: 0 });
    expect(created[0]!.src).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads real dimensions and clears its timer", async () => {
    const pending = readDimensions(image, "blob:y");
    const el = created[0]!;
    el.naturalWidth = 640;
    el.naturalHeight = 480;
    el.dispatchEvent(new Event("load"));
    await expect(pending).resolves.toEqual({ width: 640, height: 480 });
    expect(vi.getTimerCount()).toBe(0);
    expect(el.src).toBe("");
  });

  it("answers 0x0 on a decode error", async () => {
    const pending = readDimensions(video, "blob:z");
    created[0]!.dispatchEvent(new Event("error"));
    await expect(pending).resolves.toEqual({ width: 0, height: 0 });
  });
});
