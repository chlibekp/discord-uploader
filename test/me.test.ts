import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { createAuthSession } from "../src/auth/sessions.js";
import { fileDir, saveRecord } from "../src/storage/store.js";
import { checkRateLimit } from "../src/storage/ratelimit.js";
import type { FileRecord } from "../src/types.js";

let h: Harness;
afterEach(() => h?.cleanup());

const ORIGIN = "https://uploader.test";
const PNG = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(64).fill(0),
]);

async function signIn(id = "111"): Promise<string> {
  return createAuthSession(h.deps.redis, {
    id,
    username: "u" + id,
    globalName: "",
    avatar: "",
  });
}

function req(pathname: string, token: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `__Host-session=${token}`);
  if (init.method && init.method !== "GET") headers.set("Origin", ORIGIN);
  return new Request(`${ORIGIN}${pathname}`, { ...init, headers });
}

async function seedFile(
  id: string,
  userId: string,
  extra: Partial<FileRecord> = {},
): Promise<FileRecord> {
  const r: FileRecord = {
    id,
    name: `${id}.png`,
    mime: "image/png",
    kind: "image",
    size: 10,
    width: 1,
    height: 1,
    createdAt: Date.now(),
    expiresAt: 0,
    userId,
    channelId: "c",
    ...extra,
  };
  mkdirSync(fileDir(h.deps.config, id), { recursive: true });
  writeFileSync(path.join(fileDir(h.deps.config, id), r.name), "0123456789");
  await saveRecord(h.deps.redis, r);
  return r;
}

describe("/api/me", () => {
  it("401s without a session", async () => {
    h = await makeHarness();
    for (const p of ["/api/me", "/api/me/files", "/api/me/usage"]) {
      const res = await h.app.fetch(new Request(`${ORIGIN}${p}`));
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("returns the profile and limits", async () => {
    h = await makeHarness();
    const t = await signIn();
    const body = await (await h.app.fetch(req("/api/me", t))).json();
    expect(body.user.id).toBe("111");
    expect(body.limits.maxUserBytes).toBe(h.deps.config.maxUserBytes);
    expect(
      body.limits.ttlOptions.map((o: { value: string }) => o.value),
    ).toEqual(["1h", "24h", "7d", "30d", "forever"]);
    expect(body.limits.defaultTtl).toBe("30d");
  });

  it("lists only my files, newest first, with share URLs", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("mineold", "111", { createdAt: 1 });
    await seedFile("minenew", "111", {
      createdAt: 2,
      kind: "video",
      mime: "video/mp4",
      name: "minenew.mp4",
    });
    await seedFile("theirs", "222");
    const { files } = await (await h.app.fetch(req("/api/me/files", t))).json();
    expect(files.map((f: { id: string }) => f.id)).toEqual([
      "minenew",
      "mineold",
    ]);
    expect(files[0].watchUrl).toBe(`${ORIGIN}/v/minenew`);
    expect(files[1].watchUrl).toBeNull();
    expect(files[1].url).toBe(`${ORIGIN}/f/mineold/mineold.png`);
  });

  it("uploads through the shared pipeline with a chosen ttl and returns 201", async () => {
    h = await makeHarness();
    const t = await signIn();
    const form = new FormData();
    form.append("ttl", "7d");
    form.append("width", "1");
    form.append("height", "1");
    form.append("file", new Blob([PNG], { type: "image/png" }), "shot.png");
    const before = Date.now();
    const res = await h.app.fetch(
      req("/api/me/files", t, { method: "POST", body: form }),
    );
    expect(res.status).toBe(201);
    const { file } = await res.json();
    expect(file.name).toBe("shot.png");
    expect(file.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(h.calls.filter((c) => c.url.includes("/webhooks/"))).toHaveLength(0);
  });

  it("returns the server's 429 message when the hourly budget is gone", async () => {
    h = await makeHarness({ rateLimitUploadsPerHour: 1 });
    const t = await signIn();
    await checkRateLimit(h.deps.redis, "upload", "111", 1);
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
    const res = await h.app.fetch(
      req("/api/me/files", t, { method: "POST", body: form }),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too quickly/);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("returns 415 for a non-media file", async () => {
    h = await makeHarness();
    const t = await signIn();
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from("hello world, not an image".repeat(2))], {
        type: "image/png",
      }),
      "a.png",
    );
    const res = await h.app.fetch(
      req("/api/me/files", t, { method: "POST", body: form }),
    );
    expect(res.status).toBe(415);
  });

  it("deletes my file and 404s someone else's", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("mine", "111");
    await seedFile("theirs", "222");
    expect(
      (await h.app.fetch(req("/api/me/files/mine", t, { method: "DELETE" })))
        .status,
    ).toBe(204);
    expect(
      (await h.app.fetch(req("/api/me/files/theirs", t, { method: "DELETE" })))
        .status,
    ).toBe(404);
    expect(existsSync(fileDir(h.deps.config, "theirs"))).toBe(true);
  });

  it("bulk deletes owned ids and reports the rest as missing", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("a", "111");
    await seedFile("b", "111");
    await seedFile("x", "222");
    const res = await h.app.fetch(
      req("/api/me/files/delete", t, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["a", "b", "x", "gone"] }),
      }),
    );
    expect(await res.json()).toEqual({
      deleted: ["a", "b"],
      missing: ["x", "gone"],
    });
    expect(existsSync(fileDir(h.deps.config, "x"))).toBe(true);
  });

  it("validates bulk delete input", async () => {
    h = await makeHarness();
    const t = await signIn();
    const bad = async (body: unknown) =>
      (
        await h.app.fetch(
          req("/api/me/files/delete", t, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
      ).status;
    expect(await bad({ ids: [] })).toBe(400);
    expect(
      await bad({ ids: Array.from({ length: 101 }, (_, i) => `i${i}`) }),
    ).toBe(400);
    expect(await bad({ ids: [1, 2] })).toBe(400);
    expect(await bad({})).toBe(400);
  });

  it("refuses cross-origin writes", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("mine", "111");
    const res = await h.app.fetch(
      new Request(`${ORIGIN}/api/me/files/mine`, {
        method: "DELETE",
        headers: { Cookie: `__Host-session=${t}`, Origin: "https://evil.test" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("reports usage with storage split, zero-filled series and rate limits", async () => {
    h = await makeHarness({
      rateLimitUploadsPerHour: 30,
      rateLimitSessionsPerHour: 0,
    });
    const t = await signIn();
    await seedFile("i1", "111", { size: 10 });
    await seedFile("v1", "111", {
      size: 10,
      kind: "video",
      mime: "video/mp4",
      name: "v1.mp4",
    });
    const body = await (
      await h.app.fetch(req("/api/me/usage?range=7d", t))
    ).json();
    expect(body.range).toBe("7d");
    expect(body.series).toHaveLength(7);
    expect(body.storage.images).toEqual({ count: 1, bytes: 10 });
    expect(body.storage.videos).toEqual({ count: 1, bytes: 10 });
    expect(body.storage.used).toBe(20);
    expect(body.rateLimits.uploads).toMatchObject({
      used: 0,
      limit: 30,
      remaining: 30,
    });
    expect(body.rateLimits.sessions.remaining).toBeNull();
  });

  it("defaults an unknown range to 30d", async () => {
    h = await makeHarness();
    const t = await signIn();
    const body = await (
      await h.app.fetch(req("/api/me/usage?range=999d", t))
    ).json();
    expect(body.range).toBe("30d");
    expect(body.series).toHaveLength(30);
  });
});
