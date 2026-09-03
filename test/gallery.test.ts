import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { USER_KEY, fileDir, listUserFiles } from "../src/storage/store.js";
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

function galleryCommand(userId: string) {
  return uploadCommand({ data: { name: "gallery", type: 1 }, member: { user: { id: userId } } });
}

async function openSession(payload: unknown): Promise<string> {
  const res = await h.app.fetch(interactionRequest(payload));
  const url: string = (await res.json()).data.components[0].components[0].url;
  return url.split("/").pop() as string;
}

/** Run the full /upload flow so the file lands in Redis and on disk. */
async function uploadAs(userId: string, filename = "photo.png"): Promise<string> {
  const sid = await openSession(uploadCommand({ member: { user: { id: userId } } }));
  const part = multipart({ width: "800", height: "600" }, {
    field: "file",
    filename,
    contentType: "image/png",
    content: fixtures.png(),
  });

  const res = await h.app.fetch(
    new Request(`https://uploader.test/u/${sid}/file`, {
      method: "POST",
      headers: { "Content-Type": part.contentType },
      body: part.body,
    }),
  );
  return (await res.json()).fileUrl;
}

async function openGallery(userId: string): Promise<Response> {
  const gid = await openSession(galleryCommand(userId));
  return h.app.fetch(new Request(`https://uploader.test/g/${gid}`));
}

describe("/gallery command", () => {
  it("replies ephemerally with a link to the gallery route", async () => {
    const res = await h.app.fetch(interactionRequest(galleryCommand("user-42")));
    const body = await res.json();

    expect(body.data.flags).toBe(64);
    const button = body.data.components[0].components[0];
    expect(button.url).toMatch(/^https:\/\/uploader\.test\/g\/[\w-]{22}$/);
    expect(button.label).toBe("Open gallery");
  });

  it("marks the session so it cannot be spent on the upload routes", async () => {
    const gid = await openSession(galleryCommand("user-42"));
    expect((await h.deps.redis.hgetall(`sess:${gid}`)).kind).toBe("gallery");

    expect((await h.app.fetch(new Request(`https://uploader.test/u/${gid}`))).status).toBe(404);

    const part = multipart({}, {
      field: "file",
      filename: "x.png",
      contentType: "image/png",
      content: fixtures.png(),
    });
    const res = await h.app.fetch(
      new Request(`https://uploader.test/u/${gid}/file`, {
        method: "POST",
        headers: { "Content-Type": part.contentType },
        body: part.body,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an upload session used on the gallery route", async () => {
    const sid = await openSession(uploadCommand());
    expect((await h.app.fetch(new Request(`https://uploader.test/g/${sid}`))).status).toBe(404);
  });
});

describe("gallery page", () => {
  it("lists the invoker's uploads, newest first", async () => {
    await uploadAs("user-42", "first.png");
    await uploadAs("user-42", "second.png");

    const html = await (await openGallery("user-42")).text();

    expect(html).toContain("first.png");
    expect(html).toContain("second.png");
    expect(html).toContain(">2 files<");
    expect(html.indexOf("second.png")).toBeLessThan(html.indexOf("first.png"));
  });

  it("never shows another user's files", async () => {
    await uploadAs("user-42", "mine.png");
    await uploadAs("intruder", "theirs.png");

    const html = await (await openGallery("user-42")).text();

    expect(html).toContain("mine.png");
    expect(html).not.toContain("theirs.png");
    expect(html).toContain(">1 file<");
  });

  it("shows an empty state for a user with no uploads", async () => {
    const html = await (await openGallery("nobody")).text();
    expect(html).toContain("No files yet");
    expect(html).not.toContain('class="sheet"');
  });

  it("offers the watch page for videos and the file itself for images", async () => {
    await uploadAs("user-42", "shot.png");

    const sid = await openSession(uploadCommand({ member: { user: { id: "user-42" } } }));
    const part = multipart({ width: "1920", height: "1080" }, {
      field: "file",
      filename: "clip.mp4",
      contentType: "video/mp4",
      content: fixtures.mp4(),
    });
    await h.app.fetch(
      new Request(`https://uploader.test/u/${sid}/file`, {
        method: "POST",
        headers: { "Content-Type": part.contentType },
        body: part.body,
      }),
    );

    const html = await (await openGallery("user-42")).text();

    expect(html).toMatch(/data-copy="https:\/\/uploader\.test\/v\/[\w-]{22}"/);
    expect(html).toMatch(/data-copy="https:\/\/uploader\.test\/f\/[\w-]{22}\/shot\.png"/);
  });

  it("shows each file's remaining lifetime on its tile", async () => {
    await uploadAs("user-42", "temp.png");
    const html = await (await openGallery("user-42")).text();
    // The default ttl is 30 days.
    expect(html).toMatch(/deletes in (29|30) days/);
  });

  it("labels a forever upload as kept", async () => {
    const sid = await openSession(
      uploadCommand({
        member: { user: { id: "user-42" } },
        data: { name: "upload", type: 1, options: [{ name: "ttl", type: 3, value: "forever" }] },
      }),
    );
    const part = multipart({ width: "1", height: "1" }, {
      field: "file",
      filename: "keep.png",
      contentType: "image/png",
      content: fixtures.png(),
    });
    await h.app.fetch(
      new Request(`https://uploader.test/u/${sid}/file`, {
        method: "POST",
        headers: { "Content-Type": part.contentType },
        body: part.body,
      }),
    );

    const html = await (await openGallery("user-42")).text();
    expect(html).toContain("kept until full");
  });

  it("escapes filenames rather than rendering them as markup", async () => {
    // The stored name is already slugified, so this asserts the second line of
    // defence rather than the first.
    await uploadAs("user-42", "ok.png");
    await h.deps.redis.hset(
      `file:${(await h.deps.redis.zrange(USER_KEY("user-42"), 0, 0))[0]}`,
      "name",
      '"><script>alert(1)</script>.png',
    );

    const html = await (await openGallery("user-42")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("burns the session, so a reload finds a dead link", async () => {
    const gid = await openSession(galleryCommand("user-42"));

    expect((await h.app.fetch(new Request(`https://uploader.test/g/${gid}`))).status).toBe(200);
    const second = await h.app.fetch(new Request(`https://uploader.test/g/${gid}`));
    expect(second.status).toBe(404);
    expect(await second.text()).toContain("Link expired");
  });

  it("sets the same strict CSP as the upload page", async () => {
    const res = await openGallery("user-42");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves the gallery script", async () => {
    const res = await h.app.fetch(new Request("https://uploader.test/assets/gallery.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
  });

  it("brands every page from the same sprite", async () => {
    const html = await (await openGallery("user-42")).text();
    expect(html).toContain('src="/assets/mascot-small.png"');

    for (const route of ["/assets/mascot.png", "/assets/mascot-small.png", "/favicon.ico"]) {
      const res = await h.app.fetch(new Request(`https://uploader.test${route}`));
      expect(res.status, route).toBe(200);
      expect(res.headers.get("Content-Type"), route).toBe("image/png");
    }
  });

  it("serves the bundled bitmap font, which the CSP requires to be same-origin", async () => {
    for (const route of ["/assets/silkscreen-400.woff2", "/assets/silkscreen-700.woff2"]) {
      const res = await h.app.fetch(new Request(`https://uploader.test${route}`));
      expect(res.status, route).toBe(200);
      expect(res.headers.get("Content-Type"), route).toBe("font/woff2");
    }

    const page = await openGallery("user-42");
    expect(page.headers.get("Content-Security-Policy")).toContain("font-src 'self'");
  });

  it("keeps a long filename on one line and marks videos as playable", async () => {
    const sid = await openSession(uploadCommand({ member: { user: { id: "user-42" } } }));
    const part = multipart({ width: "1920", height: "1080" }, {
      field: "file",
      filename: "a-long-upload-name-that-would-otherwise-wrap.mp4",
      contentType: "video/mp4",
      content: fixtures.mp4(),
    });
    await h.app.fetch(
      new Request(`https://uploader.test/u/${sid}/file`, {
        method: "POST",
        headers: { "Content-Type": part.contentType },
        body: part.body,
      }),
    );

    const html = await (await openGallery("user-42")).text();
    // The full name stays reachable as a tooltip even though the tile clips it.
    expect(html).toContain('title="a-long-upload-name-that-would-otherwise-wrap.mp4"');
    expect(html).toContain('<span class="badge">VIDEO</span>');
  });
});

describe("gallery page: search, sort and keyboard support", () => {
  it("renders a filter box, a sort control and a live count region", async () => {
    await uploadAs("user-42", "one.png");
    const html = await (await openGallery("user-42")).text();

    expect(html).toContain('id="filter"');
    expect(html).toContain('id="sort"');
    expect(html).toContain('<option value="soonest">Soonest to expire</option>');
    expect(html).toContain('id="filterCount"');
    expect(html).toContain('id="liveRegion"');
    expect(html).toMatch(/id="liveRegion"[^>]*aria-live="assertive"/);
  });

  it("gives every tile the data attributes the client needs for filtering, sorting and the live countdown", async () => {
    await uploadAs("user-42", "one.png");
    const html = await (await openGallery("user-42")).text();

    expect(html).toMatch(/data-tile[\s\S]*?data-id="[\w-]+"/);
    expect(html).toContain('data-name="one.png"');
    expect(html).toMatch(/data-size="\d+"/);
    expect(html).toMatch(/data-created="\d+"/);
    expect(html).toMatch(/data-expires="\d+"/);
    expect(html).toContain("data-expiry");
  });

  it("makes each tile keyboard-focusable for arrow-key navigation", async () => {
    await uploadAs("user-42", "one.png");
    const html = await (await openGallery("user-42")).text();

    expect(html).toMatch(/<figure class="tile panel" tabindex="0"/);
  });

  it("loads the gallery script as a module and serves its filter/sort helpers", async () => {
    const html = await (await openGallery("user-42")).text();
    expect(html).toContain('<script type="module" src="/assets/gallery.js">');

    const res = await h.app.fetch(new Request("https://uploader.test/assets/gallery-filters.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(await res.text()).toContain("export function matchesFilter");
  });

  it("includes a hidden no-match message for a filtered-to-nothing state", async () => {
    await uploadAs("user-42", "one.png");
    const html = await (await openGallery("user-42")).text();
    expect(html).toMatch(/<p class="sheet-empty" id="sheetEmpty" hidden>/);
  });
});

describe("deleting a file", () => {
  /** The page carries a token because its session is spent on render. */
  async function galleryWithToken(userId: string): Promise<{ token: string; html: string }> {
    const html = await (await openGallery(userId)).text();
    const token = /data-token="([\w-]+)"/.exec(html)?.[1] ?? "";
    return { token, html };
  }

  function del(id: string, token: string | null): Request {
    return new Request(`https://uploader.test/api/files/${id}`, {
      method: "DELETE",
      ...(token === null ? {} : { headers: { "X-Action-Token": token } }),
    });
  }

  it("removes the owner's file from disk and from Redis", async () => {
    const url = await uploadAs("user-42", "gone.png");
    const id = new URL(url).pathname.split("/")[2] as string;
    const { token } = await galleryWithToken("user-42");

    const res = await h.app.fetch(del(id, token));
    expect(res.status).toBe(204);

    expect(existsSync(fileDir(h.deps.config, id))).toBe(false);
    expect(await h.deps.redis.hgetall(`file:${id}`)).toEqual({});
    expect(await h.deps.redis.zrange(USER_KEY("user-42"), 0, -1)).toEqual([]);
    expect(await h.deps.redis.zrange("files:lru", 0, -1)).toEqual([]);
    expect(await h.deps.redis.get("total:bytes")).toBe("0");

    expect((await h.app.fetch(new Request(url))).status).toBe(404);
  });

  it("refuses to delete a file belonging to someone else", async () => {
    const url = await uploadAs("victim", "theirs.png");
    const id = new URL(url).pathname.split("/")[2] as string;
    const { token } = await galleryWithToken("attacker");

    // 404 rather than 403, so the endpoint cannot confirm the id exists.
    const res = await h.app.fetch(del(id, token));
    expect(res.status).toBe(404);
    expect(existsSync(fileDir(h.deps.config, id))).toBe(true);
  });

  it("rejects a missing, unknown or expired token", async () => {
    const url = await uploadAs("user-42");
    const id = new URL(url).pathname.split("/")[2] as string;

    expect((await h.app.fetch(del(id, null))).status).toBe(401);
    expect((await h.app.fetch(del(id, "not-a-real-token"))).status).toBe(401);

    const { token } = await galleryWithToken("user-42");
    await h.deps.redis.del(`act:${token}`);
    expect((await h.app.fetch(del(id, token))).status).toBe(401);

    expect(existsSync(fileDir(h.deps.config, id))).toBe(true);
  });

  it("404s for an id that does not exist", async () => {
    const { token } = await galleryWithToken("user-42");
    expect((await h.app.fetch(del("no-such-file", token))).status).toBe(404);
  });

  it("gives the page a token and a delete control per tile", async () => {
    await uploadAs("user-42", "one.png");
    const { html, token } = await galleryWithToken("user-42");

    expect(token).toHaveLength(22);
    expect(html).toContain("data-delete=");
    expect(html).not.toContain("{{TOKEN}}");
  });
});

describe("per-user index", () => {
  it("indexes a file on upload", async () => {
    await uploadAs("user-42");
    expect(await h.deps.redis.zrange(USER_KEY("user-42"), 0, -1)).toHaveLength(1);
  });

  it("drops the entry when the file is evicted", async () => {
    h.cleanup();
    h = await makeHarness({ maxTotalBytes: 700 });

    const first = await uploadAs("user-42", "old.png");
    const firstId = new URL(first).pathname.split("/")[2] as string;
    await h.deps.redis.hset(`file:${firstId}`, "createdAt", String(Date.now() - 120_000));
    await h.deps.redis.zadd("files:lru", Date.now() - 120_000, firstId);

    await uploadAs("user-42", "new.png");

    const remaining = await h.deps.redis.zrange(USER_KEY("user-42"), 0, -1);
    expect(remaining).not.toContain(firstId);
    expect(remaining).toHaveLength(1);
  });

  it("returns records newest first and skips ids with no record", async () => {
    await uploadAs("user-42", "a.png");
    await uploadAs("user-42", "b.png");
    await h.deps.redis.zadd(USER_KEY("user-42"), Date.now() + 1000, "ghost");

    const files = await listUserFiles(h.deps.redis, "user-42");
    expect(files.map((f) => f.name)).toEqual(["b.png", "a.png"]);
  });
});
