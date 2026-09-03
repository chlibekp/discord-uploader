import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { SESSION_TTL_SECONDS } from "../src/storage/sessions.js";
import { fileDir } from "../src/storage/store.js";
import {
  fixtures,
  interactionRequest,
  makeHarness,
  multipart,
  uploadCommand,
  type Harness,
} from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

function post(sid: string, part: ReturnType<typeof multipart>): Request {
  return new Request(`https://uploader.test/u/${sid}/file`, {
    method: "POST",
    headers: { "Content-Type": part.contentType },
    body: part.body,
  });
}

function imagePart(content = fixtures.png(), filename = "photo.png") {
  return multipart({ width: "800", height: "600" }, {
    field: "file",
    filename,
    contentType: "image/png",
    content,
  });
}

async function startSession(): Promise<string> {
  const res = await h.app.fetch(interactionRequest(uploadCommand()));
  const body = await res.json();
  const url: string = body.data.components[0].components[0].url;
  return url.split("/u/")[1];
}

describe("POST /interactions", () => {
  it("answers PING with PONG", async () => {
    const res = await h.app.fetch(interactionRequest({ type: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("rejects a bad signature before doing anything else", async () => {
    const res = await h.app.fetch(interactionRequest({ type: 1 }, { valid: false }));
    expect(res.status).toBe(401);
  });

  it("rejects an unknown interaction type", async () => {
    expect((await h.app.fetch(interactionRequest({ type: 99 }))).status).toBe(400);
  });

  it("replies ephemerally with a link button", async () => {
    const res = await h.app.fetch(interactionRequest(uploadCommand()));
    const body = await res.json();

    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);

    const button = body.data.components[0].components[0];
    expect(button.style).toBe(5);
    expect(button.url).toMatch(/^https:\/\/uploader\.test\/u\/[\w-]{22}$/);
  });

  it("stores the session with the invoker, channel, token and a TTL", async () => {
    const sid = await startSession();
    const stored = await h.deps.redis.hgetall(`sess:${sid}`);

    expect(stored.userId).toBe("user-42");
    expect(stored.channelId).toBe("channel-99");
    expect(stored.interactionToken).toBe("interaction-token-abc");

    const ttl = await h.deps.redis.ttl(`sess:${sid}`);
    expect(ttl).toBeGreaterThan(SESSION_TTL_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
  });

  it("answers /info with an ephemeral infrastructure report", async () => {
    const payload = uploadCommand({ data: { name: "info", type: 1 } });
    const res = await h.app.fetch(interactionRequest(payload));
    const body = await res.json();

    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("**Region:**");
    expect(body.data.content).toContain("**CPU:**");
    expect(body.data.content).toContain("**Memory:**");
    expect(body.data.content).toContain("**Disk:**");
  });

  it("reads the user id from a DM payload, where there is no member object", async () => {
    const payload = uploadCommand({ member: undefined, user: { id: "dm-user" }, guild_id: undefined });
    const res = await h.app.fetch(interactionRequest(payload));
    const sid = (await res.json()).data.components[0].components[0].url.split("/u/")[1];
    expect((await h.deps.redis.hgetall(`sess:${sid}`)).userId).toBe("dm-user");
  });
});

describe("GET /u/:sid", () => {
  it("serves the upload page for a live session", async () => {
    const sid = await startSession();
    const res = await h.app.fetch(new Request(`https://uploader.test/u/${sid}`));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(html).toContain(`data-sid="${sid}"`);
    expect(html).not.toContain("{{SID}}");
  });

  it("404s for an unknown session", async () => {
    const res = await h.app.fetch(new Request("https://uploader.test/u/nope"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Link expired");
  });
});

describe("upload flow", () => {
  it("stores an image and posts an embed to the channel", async () => {
    const sid = await startSession();
    const res = await h.app.fetch(post(sid, imagePart()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.posted).toBe(true);
    expect(body.kind).toBe("image");
    expect(body.url).toMatch(/^https:\/\/uploader\.test\/f\/[\w-]{22}\/photo\.png$/);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(
      "https://discord.com/api/v10/webhooks/1234567890/interaction-token-abc",
    );
    const payload = h.calls[0].body;
    expect(payload.embeds[0].image.url).toBe(body.url);
    expect(payload.embeds[0].description).toBe("<@user-42> uploaded an image");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("posts a bare link for a video so Discord unfurls the player", async () => {
    const sid = await startSession();
    const part = multipart({ width: "1920", height: "1080" }, {
      field: "file",
      filename: "clip.mp4",
      contentType: "video/mp4",
      content: fixtures.mp4(),
    });

    const body = await (await h.app.fetch(post(sid, part))).json();
    expect(body.kind).toBe("video");
    expect(body.url).toMatch(/^https:\/\/uploader\.test\/v\/[\w-]{22}$/);

    const payload = h.calls[0].body;
    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toContain(body.url);
  });

  it("consumes the session, so the page and a second upload both fail after", async () => {
    const sid = await startSession();
    expect((await h.app.fetch(post(sid, imagePart()))).status).toBe(200);

    expect((await h.app.fetch(new Request(`https://uploader.test/u/${sid}`))).status).toBe(404);
    expect((await h.app.fetch(post(sid, imagePart()))).status).toBe(404);
  });

  it("lets only one of two concurrent uploads through", async () => {
    const sid = await startSession();
    const [a, b] = await Promise.all([
      h.app.fetch(post(sid, imagePart())),
      h.app.fetch(post(sid, imagePart())),
    ]);

    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
  });

  it("rejects a non-media file and leaves nothing on disk", async () => {
    const sid = await startSession();
    const part = multipart({}, {
      field: "file",
      filename: "payload.png",
      contentType: "image/png",
      content: fixtures.html(),
    });

    const res = await h.app.fetch(post(sid, part));
    expect(res.status).toBe(415);
    expect(readdirSync(h.deps.config.dataDir)).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an oversized file and cleans up the partial write", async () => {
    h.cleanup();
    h = await makeHarness({ maxFileBytes: 1024 });
    const sid = await startSession();

    const res = await h.app.fetch(post(sid, imagePart(fixtures.png(4096))));
    expect(res.status).toBe(413);
    expect(readdirSync(h.deps.config.dataDir)).toEqual([]);
  });

  it("names the file from the sniffed type, not the client extension", async () => {
    const sid = await startSession();
    const part = multipart({}, {
      field: "file",
      filename: "../../evil.exe",
      contentType: "application/octet-stream",
      content: fixtures.mp4(),
    });

    const body = await (await h.app.fetch(post(sid, part))).json();
    expect(body.fileUrl).toMatch(/\/evil\.mp4$/);
    expect(body.fileUrl).not.toContain("..");
  });

  it("keeps the file but reports posted:false once the token has expired", async () => {
    const sid = await startSession();
    // Backdate the session past the 15-minute interaction token lifetime.
    await h.deps.redis.hset(`sess:${sid}`, "createdAt", String(Date.now() - 16 * 60 * 1000));

    const body = await (await h.app.fetch(post(sid, imagePart()))).json();
    expect(body.posted).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(readdirSync(h.deps.config.dataDir)).toHaveLength(1);
  });

  it("reports posted:false when Discord rejects the followup, keeping the file", async () => {
    h.deps.fetch = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    const sid = await startSession();

    const body = await (await h.app.fetch(post(sid, imagePart()))).json();
    expect(body.posted).toBe(false);
    expect(readdirSync(h.deps.config.dataDir)).toHaveLength(1);
  });
});

describe("serving files", () => {
  async function upload(content = fixtures.png(), filename = "photo.png") {
    const sid = await startSession();
    const body = await (await h.app.fetch(post(sid, imagePart(content, filename)))).json();
    return new URL(body.fileUrl).pathname;
  }

  it("serves the file with the sniffed type and immutable caching", async () => {
    const res = await h.app.fetch(new Request(`https://uploader.test${await upload()}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(fixtures.png());
  });

  it("answers a range request with the right bytes", async () => {
    const path = await upload();
    const res = await h.app.fetch(
      new Request(`https://uploader.test${path}`, { headers: { Range: "bytes=0-9" } }),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-9/512");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(fixtures.png().subarray(0, 10));
  });

  it("answers an unsatisfiable range with 416", async () => {
    const res = await h.app.fetch(
      new Request(`https://uploader.test${await upload()}`, { headers: { Range: "bytes=9999-" } }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */512");
  });

  it("404s when the name does not match the stored record", async () => {
    const path = await upload();
    const wrong = path.replace(/[^/]+$/, "other.png");
    expect((await h.app.fetch(new Request(`https://uploader.test${wrong}`))).status).toBe(404);
  });

  it("404s for an unknown id", async () => {
    const res = await h.app.fetch(new Request("https://uploader.test/f/missing/x.png"));
    expect(res.status).toBe(404);
  });
});

describe("GET /v/:id", () => {
  it("serves OG player tags with the client-reported dimensions", async () => {
    const sid = await startSession();
    const part = multipart({ width: "1920", height: "1080" }, {
      field: "file",
      filename: "clip.mp4",
      contentType: "video/mp4",
      content: fixtures.mp4(),
    });
    const body = await (await h.app.fetch(post(sid, part))).json();

    const html = await (await h.app.fetch(new Request(body.url))).text();
    expect(html).toContain('property="og:video" content="https://uploader.test/f/');
    expect(html).toContain('content="video/mp4"');
    expect(html).toContain('property="og:video:width" content="1920"');
    expect(html).toContain('property="og:video:height" content="1080"');
    expect(html).toContain('name="twitter:card" content="player"');
  });

  it("falls back to 1280x720 when the browser reported no dimensions", async () => {
    const sid = await startSession();
    const part = multipart({ width: "0", height: "0" }, {
      field: "file",
      filename: "clip.mp4",
      contentType: "video/mp4",
      content: fixtures.mp4(),
    });
    const body = await (await h.app.fetch(post(sid, part))).json();

    const html = await (await h.app.fetch(new Request(body.url))).text();
    expect(html).toContain('property="og:video:width" content="1280"');
    expect(html).toContain('property="og:video:height" content="720"');
  });

  it("redirects to the file for an image", async () => {
    const sid = await startSession();
    const body = await (await h.app.fetch(post(sid, imagePart()))).json();
    const id = new URL(body.fileUrl).pathname.split("/")[2];

    const res = await h.app.fetch(new Request(`https://uploader.test/v/${id}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(body.fileUrl);
  });
});

describe("eviction during upload", () => {
  it("frees space by dropping the least recently used file", async () => {
    h.cleanup();
    h = await makeHarness({ maxTotalBytes: 700 });

    const first = await (await h.app.fetch(post(await startSession(), imagePart()))).json();
    const firstId = new URL(first.fileUrl).pathname.split("/")[2];

    // Backdate the first upload so it is outside the protection window.
    await h.deps.redis.hset(`file:${firstId}`, "createdAt", String(Date.now() - 120_000));
    await h.deps.redis.zadd("files:lru", Date.now() - 120_000, firstId);

    await h.app.fetch(post(await startSession(), imagePart()));

    expect(existsSync(fileDir(h.deps.config, firstId))).toBe(false);
    expect(await h.deps.redis.hgetall(`file:${firstId}`)).toEqual({});
  });
});

describe("GET /healthz", () => {
  it("reports ok when Redis and the volume are reachable", async () => {
    const res = await h.app.fetch(new Request("https://uploader.test/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
