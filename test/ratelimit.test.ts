import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, minutesUntil } from "../src/storage/ratelimit.js";
import { deleteRecord, userBytes } from "../src/storage/store.js";
import {
  fixtures,
  interactionRequest,
  makeHarness,
  multipart,
  uploadCommand,
  type Harness,
} from "./helpers.js";

let h: Harness;

afterEach(() => {
  h?.cleanup();
});

function post(sid: string, part: ReturnType<typeof multipart>): Request {
  return new Request(`https://uploader.test/u/${sid}/file`, {
    method: "POST",
    headers: { "Content-Type": part.contentType },
    body: part.body,
  });
}

function imagePart(content = fixtures.png(), filename = "photo.png") {
  return multipart(
    { width: "800", height: "600" },
    {
      field: "file",
      filename,
      contentType: "image/png",
      content,
    },
  );
}

async function startSession(app: Harness["app"]): Promise<string> {
  const res = await app.fetch(interactionRequest(uploadCommand()));
  const body = await res.json();
  const url: string = body.data.components[0].components[0].url;
  return url.split("/u/")[1];
}

describe("checkRateLimit", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("allows requests up to the limit and blocks the next one", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await checkRateLimit(h.deps.redis, "test", "u1", 3);
      expect(result.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(h.deps.redis, "test", "u1", 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("tracks separate users independently", async () => {
    await checkRateLimit(h.deps.redis, "test", "a", 1);
    const b = await checkRateLimit(h.deps.redis, "test", "b", 1);
    expect(b.allowed).toBe(true);
  });

  it("resets once the window rolls over", async () => {
    const hour = 60 * 60 * 1000;
    const t0 = Date.parse("2026-01-01T00:59:00Z");
    const t1 = t0 + 2 * 60 * 1000; // into the next hour bucket

    await checkRateLimit(h.deps.redis, "test", "u2", 1, t0);
    const stillInWindow = await checkRateLimit(
      h.deps.redis,
      "test",
      "u2",
      1,
      t0,
    );
    expect(stillInWindow.allowed).toBe(false);

    const afterReset = await checkRateLimit(h.deps.redis, "test", "u2", 1, t1);
    expect(afterReset.allowed).toBe(true);
    void hour;
  });

  it("treats a limit of 0 as disabled", async () => {
    for (let i = 0; i < 10; i++) {
      const result = await checkRateLimit(h.deps.redis, "test", "u3", 0);
      expect(result.allowed).toBe(true);
    }
  });
});

describe("minutesUntil", () => {
  it("rounds up and never returns less than 1", () => {
    const now = Date.now();
    expect(minutesUntil(now + 500, now)).toBe(1);
    expect(minutesUntil(now + 61_000, now)).toBe(2);
  });
});

describe("session rate limiting on /interactions", () => {
  beforeEach(async () => {
    h = await makeHarness({ rateLimitSessionsPerHour: 2 });
  });

  it("returns 429-shaped ephemeral content once the session limit is hit", async () => {
    await h.app.fetch(interactionRequest(uploadCommand()));
    await h.app.fetch(interactionRequest(uploadCommand()));

    const res = await h.app.fetch(interactionRequest(uploadCommand()));
    const body = await res.json();

    expect(res.status).toBe(200); // Discord interaction responses are always 200
    expect(body.data.flags).toBe(64); // ephemeral
    expect(body.data.content).toMatch(/too quickly/i);
    expect(body.data.content).toMatch(/minute/i);
    expect(body.data.components).toBeUndefined();
  });

  it("does not rate limit a different user", async () => {
    await h.app.fetch(interactionRequest(uploadCommand()));
    await h.app.fetch(interactionRequest(uploadCommand()));

    const other = uploadCommand({ member: { user: { id: "someone-else" } } });
    const res = await h.app.fetch(interactionRequest(other));
    const body = await res.json();
    expect(body.data.components[0].components[0].url).toBeDefined();
  });

  it("does not gate /help, /support, /info or /stats", async () => {
    await h.app.fetch(interactionRequest(uploadCommand()));
    await h.app.fetch(interactionRequest(uploadCommand()));

    const res = await h.app.fetch(
      interactionRequest(uploadCommand({ data: { name: "stats", type: 1 } })),
    );
    const body = await res.json();
    expect(body.data.embeds[0].title).toContain("Your storage");
  });
});

describe("upload rate limiting on POST /u/:sid/file", () => {
  beforeEach(async () => {
    h = await makeHarness({ rateLimitUploadsPerHour: 1 });
  });

  it("blocks an upload once the per-hour limit is spent, with a 429", async () => {
    const sidOk = await startSession(h.app);
    const okRes = await h.app.fetch(post(sidOk, imagePart()));
    expect(okRes.status).toBe(200);

    const sidBlocked = await startSession(h.app);
    const res = await h.app.fetch(
      post(sidBlocked, imagePart(fixtures.png(), "other.png")),
    );
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toMatch(/too quickly/i);
    expect(typeof body.retryAfterSeconds).toBe("number");
  });

  it("leaves the session unclaimed when rate limited, so it does not 409 on a real retry later", async () => {
    const sidOk = await startSession(h.app);
    await h.app.fetch(post(sidOk, imagePart()));

    const sid = await startSession(h.app);
    const blocked = await h.app.fetch(
      post(sid, imagePart(fixtures.png(), "other.png")),
    );
    expect(blocked.status).toBe(429);

    const session = await h.deps.redis.hgetall(`sess:${sid}`);
    expect(session.claimed).toBeUndefined();
  });

  it("does not rate limit a different user's upload", async () => {
    const sidA = await startSession(h.app);
    await h.app.fetch(post(sidA, imagePart()));

    const otherRes = await h.app.fetch(
      interactionRequest(
        uploadCommand({ member: { user: { id: "someone-else" } } }),
      ),
    );
    const otherBody = await otherRes.json();
    const sidB: string =
      otherBody.data.components[0].components[0].url.split("/u/")[1];

    const res = await h.app.fetch(
      post(sidB, imagePart(fixtures.png(), "other.png")),
    );
    expect(res.status).toBe(200);
  });
});

describe("per-user quota is reclaimed on delete", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("frees the tracked byte total when a file is deleted", async () => {
    const sid = await startSession(h.app);
    const res = await h.app.fetch(post(sid, imagePart()));
    const body = await res.json();
    const id = new URL(body.fileUrl).pathname.split("/")[2];

    const before = await userBytes(h.deps.redis, "user-42");
    expect(before).toBeGreaterThan(0);

    await deleteRecord(h.deps.redis, h.deps.config, id);

    const after = await userBytes(h.deps.redis, "user-42");
    expect(after).toBe(0);
  });

  it("frees quota via the message Delete button path", async () => {
    const sid = await startSession(h.app);
    const uploadRes = await h.app.fetch(post(sid, imagePart()));
    const uploadBody = await uploadRes.json();
    const id = new URL(uploadBody.fileUrl).pathname.split("/")[2];

    expect(await userBytes(h.deps.redis, "user-42")).toBeGreaterThan(0);

    const componentPayload = {
      type: 3,
      token: "component-token",
      member: { user: { id: "user-42" } },
      data: { custom_id: `del:${id}` },
    };
    const res = await h.app.fetch(interactionRequest(componentPayload));
    expect(res.status).toBe(200);

    // The button's cleanup runs after the ack; give the microtask queue a turn.
    await vi.waitFor(async () => {
      expect(await userBytes(h.deps.redis, "user-42")).toBe(0);
    });
  });

  it("frees quota via the gallery delete endpoint", async () => {
    const sid = await startSession(h.app);
    const uploadRes = await h.app.fetch(post(sid, imagePart()));
    const uploadBody = await uploadRes.json();
    const id = new URL(uploadBody.fileUrl).pathname.split("/")[2];

    const galleryRes = await h.app.fetch(
      interactionRequest(uploadCommand({ data: { name: "gallery", type: 1 } })),
    );
    const galleryBody = await galleryRes.json();
    const gid: string =
      galleryBody.data.components[0].components[0].url.split("/g/")[1];

    const page = await h.app.fetch(
      new Request(`https://uploader.test/g/${gid}`),
    );
    const html = await page.text();
    const token = html.match(/data-token="([^"]+)"/)?.[1];

    expect(token).toBeTruthy();

    const del = await h.app.fetch(
      new Request(`https://uploader.test/api/files/${id}`, {
        method: "DELETE",
        headers: { "X-Action-Token": token! },
      }),
    );
    expect(del.status).toBe(204);
    expect(await userBytes(h.deps.redis, "user-42")).toBe(0);
  });
});
