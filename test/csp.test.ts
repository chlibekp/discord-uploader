import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { createSession } from "../src/storage/sessions.js";
import { fileDir, saveRecord } from "../src/storage/store.js";
import type { FileRecord } from "../src/types.js";
import { UPLOAD_PAGE_CSP } from "../src/web/csp.js";
import { applyPageCsp } from "../src/web/mount.js";

let h: Harness;
afterEach(() => h?.cleanup());

describe("legacy page CSP headers (via the real built Astro entry)", () => {
  it("sets the exact UPLOAD_PAGE_CSP header on a live upload session, with no x-page-csp leak", async () => {
    h = await makeHarness();
    const session = await createSession(h.deps.redis, {
      kind: "upload",
      userId: "u1",
      channelId: "c1",
      guildId: "",
      interactionToken: "t",
      ttlMs: 0,
    });
    const res = await h.app.fetch(
      new Request(`https://uploader.test/u/${session.sid}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(UPLOAD_PAGE_CSP);
    expect(res.headers.get("x-page-csp")).toBeNull();
  });

  it("sets the exact UPLOAD_PAGE_CSP header on an expired/unknown upload sid", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/u/does-not-exist"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Security-Policy")).toBe(UPLOAD_PAGE_CSP);
    expect(res.headers.get("x-page-csp")).toBeNull();
  });

  it("sets the exact UPLOAD_PAGE_CSP header on a live gallery session, with no x-page-csp leak", async () => {
    h = await makeHarness();
    const session = await createSession(h.deps.redis, {
      kind: "gallery",
      userId: "u1",
      channelId: "c1",
      guildId: "",
      interactionToken: "t",
      ttlMs: 0,
    });
    const res = await h.app.fetch(
      new Request(`https://uploader.test/g/${session.sid}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(UPLOAD_PAGE_CSP);
    expect(res.headers.get("x-page-csp")).toBeNull();
  });

  it("sets the exact UPLOAD_PAGE_CSP header on an expired/unknown gallery gid", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/g/does-not-exist"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Security-Policy")).toBe(UPLOAD_PAGE_CSP);
    expect(res.headers.get("x-page-csp")).toBeNull();
  });

  it("has no CSP header at all on the watch page, matching the pre-Astro original", async () => {
    h = await makeHarness();
    const id = "csptestvideo000000000001";
    const dir = fileDir(h.deps.config, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "clip.mp4"), "x");
    const record: FileRecord = {
      id,
      name: "clip.mp4",
      mime: "video/mp4",
      kind: "video",
      size: 1,
      width: 1280,
      height: 720,
      createdAt: Date.now(),
      expiresAt: 0,
      userId: "u1",
      channelId: "c1",
    };
    await saveRecord(h.deps.redis, record);

    const res = await h.app.fetch(new Request(`https://uploader.test/v/${id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("x-page-csp")).toBeNull();
  });
});

describe("applyPageCsp (the x-page-csp override, in isolation)", () => {
  it("applies a fixed override in place of whatever Astro computed", () => {
    const res = new Response("body", {
      headers: {
        "content-security-policy": "script-src 'self' 'sha256-abc'",
        "x-page-csp": "default-src 'none'",
      },
    });
    const out = applyPageCsp(res);
    expect(out.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'",
    );
    expect(out.headers.get("x-page-csp")).toBeNull();
  });

  it('strips the Content-Security-Policy header entirely when the override is "none"', () => {
    const res = new Response("body", {
      headers: {
        "content-security-policy": "script-src 'self' 'sha256-abc'",
        "x-page-csp": "none",
      },
    });
    const out = applyPageCsp(res);
    expect(out.headers.get("Content-Security-Policy")).toBeNull();
    expect(out.headers.get("x-page-csp")).toBeNull();
  });

  it("leaves Astro's own header untouched when there is no override", () => {
    const res = new Response("body", {
      headers: { "content-security-policy": "script-src 'self' 'sha256-abc'" },
    });
    const out = applyPageCsp(res);
    expect(out.headers.get("Content-Security-Policy")).toBe(
      "script-src 'self' 'sha256-abc'",
    );
    expect(out.headers.get("x-page-csp")).toBeNull();
  });

  it("is a no-op when there is no x-page-csp header at all", () => {
    const res = new Response("body");
    const out = applyPageCsp(res);
    expect(out).toBe(res);
  });
});
