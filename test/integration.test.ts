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

    const id = new URL(body.fileUrl).pathname.split("/")[2];
    expect(payload.components[0].components[0]).toMatchObject({
      type: 2,
      style: 4,
      label: "Delete",
      custom_id: `del:${id}`,
    });
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

describe("delete button on a posted upload", () => {
  async function uploadAndGetId(userId = "user-42"): Promise<string> {
    const sid = (
      await (
        await h.app.fetch(
          interactionRequest(uploadCommand({ member: { user: { id: userId } } })),
        )
      ).json()
    ).data.components[0].components[0].url.split("/u/")[1];
    const body = await (await h.app.fetch(post(sid, imagePart()))).json();
    return new URL(body.fileUrl).pathname.split("/")[2];
  }

  function buttonPress(id: string, userId: string) {
    return interactionRequest({
      type: 3,
      token: "interaction-token-abc",
      channel_id: "channel-99",
      member: { user: { id: userId } },
      data: { custom_id: `del:${id}`, component_type: 2 },
    });
  }

  it("lets the uploader delete their own upload and removes the message", async () => {
    const id = await uploadAndGetId("user-42");
    h.calls.length = 0;

    const body = await (await h.app.fetch(buttonPress(id, "user-42"))).json();
    expect(body.type).toBe(6);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(
      "https://discord.com/api/v10/webhooks/1234567890/interaction-token-abc/messages/@original",
    );

    expect(existsSync(fileDir(h.deps.config, id))).toBe(false);
    expect(await h.deps.redis.hgetall(`file:${id}`)).toEqual({});
  });

  it("refuses a delete from anyone else and keeps the file and message", async () => {
    const id = await uploadAndGetId("user-42");
    h.calls.length = 0;

    const body = await (await h.app.fetch(buttonPress(id, "intruder"))).json();
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("Only the person who uploaded");

    expect(h.calls).toHaveLength(0);
    expect(existsSync(fileDir(h.deps.config, id))).toBe(true);
  });

  it("still removes the message when the file is already gone", async () => {
    const body = await (await h.app.fetch(buttonPress("missingid", "user-42"))).json();
    expect(body.type).toBe(6);
    expect(h.calls.at(-1)?.url).toContain("/messages/@original");
  });
});

describe("/stats", () => {
  const statsCommand = () => uploadCommand({ data: { name: "stats", type: 1 } });

  it("reports nothing stored for a new user", async () => {
    const body = await (await h.app.fetch(interactionRequest(statsCommand()))).json();
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("nothing stored");
  });

  it("counts the caller's files and bytes after an upload", async () => {
    await h.app.fetch(post(await startSession(), imagePart()));
    const body = await (await h.app.fetch(interactionRequest(statsCommand()))).json();
    expect(body.data.content).toContain("**Files:** 1");
    expect(body.data.content).toMatch(/\*\*Used:\*\* .+ \/ .+ \(\d+%\)/);
  });
});

describe("upload ttl", () => {
  function ttlCommand(value: string) {
    return uploadCommand({
      data: { name: "upload", type: 1, options: [{ name: "ttl", type: 3, value }] },
    });
  }

  async function startWithTtl(value: string): Promise<string> {
    const res = await h.app.fetch(interactionRequest(ttlCommand(value)));
    const url: string = (await res.json()).data.components[0].components[0].url;
    return url.split("/u/")[1];
  }

  it("stamps an expiry and indexes it when a ttl is chosen", async () => {
    const body = await (await h.app.fetch(post(await startWithTtl("1h"), imagePart()))).json();
    const id = new URL(body.fileUrl).pathname.split("/")[2];

    const expiresAt = Number(await h.deps.redis.hget(`file:${id}`, "expiresAt"));
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(await h.deps.redis.zscore("files:expiry", id)).toBe(String(expiresAt));
  });

  it("keeps forever uploads out of the expiry index", async () => {
    const body = await (await h.app.fetch(post(await startWithTtl("forever"), imagePart()))).json();
    const id = new URL(body.fileUrl).pathname.split("/")[2];

    expect(await h.deps.redis.hget(`file:${id}`, "expiresAt")).toBe("0");
    expect(await h.deps.redis.zscore("files:expiry", id)).toBe(null);
  });

  it("reaps a file whose expiry has passed on the next gallery open", async () => {
    const body = await (await h.app.fetch(post(await startWithTtl("1h"), imagePart()))).json();
    const id = new URL(body.fileUrl).pathname.split("/")[2];
    await h.deps.redis.zadd("files:expiry", Date.now() - 1000, id);

    const gid = await openSessionGallery();
    await h.app.fetch(new Request(`https://uploader.test/g/${gid}`));

    expect(existsSync(fileDir(h.deps.config, id))).toBe(false);
    expect(await h.deps.redis.hgetall(`file:${id}`)).toEqual({});
  });

  async function openSessionGallery(): Promise<string> {
    const payload = uploadCommand({ data: { name: "gallery", type: 1 } });
    const url: string = (await (await h.app.fetch(interactionRequest(payload))).json()).data
      .components[0].components[0].url;
    return url.split("/g/")[1];
  }
});

describe("per-user quota", () => {
  it("evicts the uploader's own oldest file to fit a new one", async () => {
    h.cleanup();
    h = await makeHarness({ maxUserBytes: 4000, maxTotalBytes: 10 * 1024 * 1024 });

    const first = await (
      await h.app.fetch(post(await startSession(), imagePart(fixtures.png(3000))))
    ).json();
    const firstId = new URL(first.fileUrl).pathname.split("/")[2];

    const second = await (
      await h.app.fetch(post(await startSession(), imagePart(fixtures.png(3000))))
    ).json();
    const secondId = new URL(second.fileUrl).pathname.split("/")[2];

    expect(existsSync(fileDir(h.deps.config, firstId))).toBe(false);
    expect(existsSync(fileDir(h.deps.config, secondId))).toBe(true);
    expect(Number(await h.deps.redis.get("user:user-42:bytes"))).toBe(3000);
  });

  it("rejects a single file larger than the whole quota", async () => {
    h.cleanup();
    h = await makeHarness({ maxUserBytes: 2000, maxFileBytes: 10 * 1024 * 1024 });

    const res = await h.app.fetch(post(await startSession(), imagePart(fixtures.png(5000))));
    expect(res.status).toBe(413);
    expect(readdirSync(h.deps.config.dataDir)).toEqual([]);
  });
});

describe("GET /healthz", () => {
  it("reports ok when Redis and the volume are reachable", async () => {
    const res = await h.app.fetch(new Request("https://uploader.test/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
