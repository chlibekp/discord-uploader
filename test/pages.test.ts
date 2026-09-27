import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { createSession } from "../src/storage/sessions.js";
import { fileDir, saveRecord } from "../src/storage/store.js";
import type { FileRecord } from "../src/types.js";
import { createAuthSession } from "../src/auth/sessions.js";

let h: Harness;
afterEach(() => h?.cleanup());

const EVIL = `a"><img src=x onerror=alert(1)>.png`;

async function seed(record: Partial<FileRecord>): Promise<FileRecord> {
  const full: FileRecord = {
    id: "evilevilevilevilevilev",
    name: EVIL,
    mime: "image/png",
    kind: "image",
    size: 3,
    width: 1,
    height: 1,
    createdAt: Date.UTC(2026, 0, 1),
    expiresAt: 0,
    userId: "u1",
    channelId: "c1",
    ...record,
  };
  // path.join treats a literal "/" inside a hostile filename (e.g. "</script>")
  // as a path separator, so the parent directory of the *full* path — not
  // just fileDir(id) — must exist before the write.
  const target = path.join(fileDir(h.deps.config, full.id), full.name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "abc");
  await saveRecord(h.deps.redis, full);
  return full;
}

describe("page escaping", () => {
  it("escapes a hostile filename on the gallery page", async () => {
    h = await makeHarness();
    await seed({});
    const s = await createSession(h.deps.redis, {
      kind: "gallery",
      userId: "u1",
      channelId: "c1",
      guildId: "",
      interactionToken: "t",
      ttlMs: 0,
    });
    const res = await h.app.fetch(
      new Request(`https://uploader.test/g/${s.sid}`),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a hostile filename on the watch page", async () => {
    h = await makeHarness();
    await seed({
      kind: "video",
      mime: "video/mp4",
      name: `v"><script>x</script>.mp4`,
    });
    const res = await h.app.fetch(
      new Request("https://uploader.test/v/evilevilevilevilevilev"),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("/login", () => {
  it.each([
    ["cancelled", 200, "Sign-in cancelled."],
    ["expired", 400, "That sign-in link expired. Try again."],
    ["discord", 502, "Discord didn't answer. Try again in a moment."],
  ])("error=%s renders status %i", async (error, status, message) => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request(`https://uploader.test/login?error=${error}`),
    );
    expect(res.status).toBe(status);
    // Astro escapes the apostrophe in "didn't" as &#39;.
    const pattern = new RegExp(
      message.replace(/[.?]/g, "\\$&").replace("'", "(&#39;|')"),
    );
    expect(await res.text()).toMatch(pattern);
  });

  it("says sign-in is not set up when there is no client secret", async () => {
    h = await makeHarness({ discordClientSecret: "" });
    const html = await (
      await h.app.fetch(new Request("https://uploader.test/login"))
    ).text();
    expect(html).toContain("Sign-in isn");
    expect(html).not.toContain('action="/auth/login"');
  });

  it("keeps next on the Discord button, sanitised", async () => {
    h = await makeHarness();
    const html = await (
      await h.app.fetch(
        new Request("https://uploader.test/login?next=//evil.com"),
      )
    ).text();
    expect(html).toContain('name="next" value="/dashboard"');
  });

  it("sends a signed-in visitor on to the dashboard", async () => {
    h = await makeHarness();
    const t = await createAuthSession(h.deps.redis, {
      id: "1",
      username: "a",
      globalName: "",
      avatar: "",
    });
    const res = await h.app.fetch(
      new Request("https://uploader.test/login", {
        headers: { Cookie: `__Host-session=${t}` },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("sets the dashboard CSP header", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(new Request("https://uploader.test/login"));
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});

describe("/dashboard shell", () => {
  async function signedIn(
    user = { id: "7", username: "neo", globalName: "Neo", avatar: "" },
  ) {
    return createAuthSession(h.deps.redis, user);
  }

  it("renders tabs, the account menu and the dashboard CSP", async () => {
    h = await makeHarness();
    const t = await signedIn();
    const res = await h.app.fetch(
      new Request("https://uploader.test/dashboard", {
        headers: { Cookie: `__Host-session=${t}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "https://cdn.discordapp.com",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("@neo");
    expect(html).toMatch(/<a href="\/dashboard"[^>]*aria-current="page"/);
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain("data-upload-trigger");
  });

  it("uses the Discord CDN avatar when the user has one", async () => {
    h = await makeHarness();
    const t = await signedIn({
      id: "7",
      username: "neo",
      globalName: "",
      avatar: "a1b2",
    });
    const html = await (
      await h.app.fetch(
        new Request("https://uploader.test/dashboard/usage", {
          headers: { Cookie: `__Host-session=${t}` },
        }),
      )
    ).text();
    expect(html).toContain(
      "https://cdn.discordapp.com/avatars/7/a1b2.png?size=64",
    );
    expect(html).toMatch(
      /<a href="\/dashboard\/usage"[^>]*aria-current="page"/,
    );
  });
});
