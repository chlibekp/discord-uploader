import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";
import {
  AUTH_SESSION_TTL_SECONDS,
  createAuthSession,
  deleteAllAuthSessions,
  deleteAuthSession,
  digest,
  readAuthSession,
} from "../src/auth/sessions.js";
import {
  authorizeUrl,
  consumeOAuthState,
  createOAuthState,
  exchangeCode,
  OAuthError,
  safeNext,
} from "../src/auth/oauth.js";

let h: Harness;
afterEach(() => h?.cleanup());

const alice = {
  id: "111",
  username: "alice",
  globalName: "Alice",
  avatar: "abc",
};

describe("safeNext", () => {
  it.each([
    [undefined, "/dashboard"],
    ["", "/dashboard"],
    ["/dashboard/usage?range=7d", "/dashboard/usage?range=7d"],
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["https://evil.com", "/dashboard"],
    ["/%2F%2Fevil.com", "/dashboard"],
    ["dashboard", "/dashboard"],
    ["/ok#frag", "/ok#frag"],
    // The raw value must itself start with "/": a percent-encoded slash
    // must not be decoded into one after the fact.
    ["%2Fdashboard", "/dashboard"],
    ["/%5Cevil.com", "/dashboard"],
    ["/\t/evil.com", "/dashboard"],
    ["/%zz", "/dashboard"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

describe("auth sessions", () => {
  it("stores only a digest of the token", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    expect(await h.deps.redis.exists(`auth:${token}`)).toBe(0);
    expect(await h.deps.redis.exists(`auth:${digest(token)}`)).toBe(1);
    expect(await h.deps.redis.ttl(`auth:${digest(token)}`)).toBeGreaterThan(
      AUTH_SESSION_TTL_SECONDS - 5,
    );
  });

  it("reads back the user without refreshing a fresh session", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    expect(await readAuthSession(h.deps.redis, token)).toEqual({
      user: alice,
      refreshed: false,
    });
  });

  it("slides the expiry once less than 29 days remain", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    await h.deps.redis.expire(`auth:${digest(token)}`, 86_400);
    const found = await readAuthSession(h.deps.redis, token);
    expect(found?.refreshed).toBe(true);
    expect(await h.deps.redis.ttl(`auth:${digest(token)}`)).toBeGreaterThan(
      AUTH_SESSION_TTL_SECONDS - 5,
    );
  });

  it("returns null for unknown, expired or empty tokens", async () => {
    h = await makeHarness();
    expect(await readAuthSession(h.deps.redis, "nope")).toBeNull();
    expect(await readAuthSession(h.deps.redis, "")).toBeNull();
  });

  it("deletes one session, or every session for a user", async () => {
    h = await makeHarness();
    const a = await createAuthSession(h.deps.redis, alice);
    const b = await createAuthSession(h.deps.redis, alice);
    await deleteAuthSession(h.deps.redis, a);
    expect(await readAuthSession(h.deps.redis, a)).toBeNull();
    expect(await readAuthSession(h.deps.redis, b)).not.toBeNull();
    const c = await createAuthSession(h.deps.redis, alice);
    expect(await deleteAllAuthSessions(h.deps.redis, alice.id)).toBe(2);
    expect(await readAuthSession(h.deps.redis, b)).toBeNull();
    expect(await readAuthSession(h.deps.redis, c)).toBeNull();
  });

  it("does not drop a session that finishes signing in mid-call", async () => {
    h = await makeHarness();
    const a = await createAuthSession(h.deps.redis, alice);
    const originalSmembers = h.deps.redis.smembers.bind(h.deps.redis);
    let created: string | undefined;
    h.deps.redis.smembers = (async (key: string) => {
      const snapshot = await originalSmembers(key);
      // A second login finishes here, after the set is read but before it
      // is trimmed: its digest must survive being SREM'd for digests that
      // were never part of this snapshot.
      created = await createAuthSession(h.deps.redis, alice);
      return snapshot;
    }) as typeof h.deps.redis.smembers;

    const ended = await deleteAllAuthSessions(h.deps.redis, alice.id);

    expect(ended).toBe(1);
    expect(await readAuthSession(h.deps.redis, a)).toBeNull();
    expect(await readAuthSession(h.deps.redis, created!)).not.toBeNull();
    expect(
      await h.deps.redis.sismember(`auth:user:${alice.id}`, digest(created!)),
    ).toBe(1);
  });
});

describe("oauth state", () => {
  it("is single use and remembers next", async () => {
    h = await makeHarness();
    const state = await createOAuthState(h.deps.redis, "/dashboard/usage");
    expect(await consumeOAuthState(h.deps.redis, state)).toBe(
      "/dashboard/usage",
    );
    expect(await consumeOAuthState(h.deps.redis, state)).toBeNull();
  });

  it("builds the authorize URL with identify scope and our callback", async () => {
    h = await makeHarness();
    const url = new URL(authorizeUrl(h.deps.config, "st"));
    expect(url.origin + url.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(h.deps.config.discordAppId);
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://uploader.test/auth/callback",
    );
    // Discord only skips the consent screen for users who already
    // authorized; first-time users still see it either way.
    expect(url.searchParams.get("prompt")).toBe("none");
  });
});

describe("exchangeCode", () => {
  it("trades the code and returns only identity fields", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "at", token_type: "Bearer" })
        : undefined,
    );
    h.respond.push((url) =>
      url.endsWith("/users/@me")
        ? Response.json({
            id: "111",
            username: "alice",
            global_name: "Alice",
            avatar: "abc",
            email: "x@y",
          })
        : undefined,
    );
    const user = await exchangeCode(h.deps.config, h.deps.fetch, "the-code");
    expect(user).toEqual(alice);
    const tokenCall = h.calls.find((c) => c.url.endsWith("/oauth2/token"))!;
    expect(tokenCall.body).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: h.deps.config.discordAppId,
      client_secret: "test-secret",
      redirect_uri: "https://uploader.test/auth/callback",
    });
  });

  it("throws OAuthError when Discord fails", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? new Response("no", { status: 500 })
        : undefined,
    );
    await expect(
      exchangeCode(h.deps.config, h.deps.fetch, "x"),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("throws OAuthError when /users/@me is not OK", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "at" })
        : undefined,
    );
    h.respond.push((url) =>
      url.endsWith("/users/@me")
        ? new Response("no", { status: 500 })
        : undefined,
    );
    await expect(
      exchangeCode(h.deps.config, h.deps.fetch, "x"),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("throws OAuthError when the token body is null", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token") ? Response.json(null) : undefined,
    );
    await expect(
      exchangeCode(h.deps.config, h.deps.fetch, "x"),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("throws OAuthError when the token request itself rejects", async () => {
    h = await makeHarness();
    h.respond.push((url) => {
      if (url.endsWith("/oauth2/token")) throw new Error("network down");
      return undefined;
    });
    await expect(
      exchangeCode(h.deps.config, h.deps.fetch, "x"),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

function cookieFrom(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie();
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0]?.slice(name.length + 1);
}

const ORIGIN = { Origin: "https://uploader.test" };

describe("GET /auth/login", () => {
  it("redirects to Discord with a state that matches a __Host- cookie", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/login?next=/dashboard/usage"),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    const state = loc.searchParams.get("state")!;
    expect(cookieFrom(res, "__Host-oauth_state")).toBe(state);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/__Host-oauth_state=.*HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(await h.deps.redis.get(`oauth:state:${state}`)).toBe(
      "/dashboard/usage",
    );
  });

  it("goes to /login when sign-in is not configured", async () => {
    h = await makeHarness({ discordClientSecret: "" });
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/login"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("GET /auth/callback", () => {
  function discordOk(h: Harness) {
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "at" })
        : undefined,
    );
    h.respond.push((url) =>
      url.endsWith("/users/@me")
        ? Response.json({
            id: "111",
            username: "alice",
            global_name: "Alice",
            avatar: null,
          })
        : undefined,
    );
  }

  async function begin(h: Harness, next = "/dashboard") {
    const res = await h.app.fetch(
      new Request(
        `https://uploader.test/auth/login?next=${encodeURIComponent(next)}`,
      ),
    );
    const state = new URL(res.headers.get("location")!).searchParams.get(
      "state",
    )!;
    return state;
  }

  it("signs in and redirects to next", async () => {
    h = await makeHarness();
    discordOk(h);
    const state = await begin(h, "/dashboard/usage");
    const res = await h.app.fetch(
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: `__Host-oauth_state=${state}` },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/usage");
    const token = cookieFrom(res, "__Host-session")!;
    expect(token).toBeTruthy();
    expect(res.headers.getSetCookie().join("\n")).toMatch(
      /__Host-session=.*HttpOnly.*|HttpOnly.*__Host-session/s,
    );
  });

  it("rejects a state that does not match the cookie", async () => {
    h = await makeHarness();
    discordOk(h);
    const state = await begin(h);
    const res = await h.app.fetch(
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: "__Host-oauth_state=other" },
      }),
    );
    expect(res.headers.get("location")).toBe("/login?error=expired");
  });

  it("rejects a reused state", async () => {
    h = await makeHarness();
    discordOk(h);
    const state = await begin(h);
    const req = () =>
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: `__Host-oauth_state=${state}` },
      });
    await h.app.fetch(req());
    const second = await h.app.fetch(req());
    expect(second.headers.get("location")).toBe("/login?error=expired");
  });

  it("maps a cancelled consent to error=cancelled", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/callback?error=access_denied"),
    );
    expect(res.headers.get("location")).toBe("/login?error=cancelled");
  });

  it("maps a Discord failure to error=discord", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? new Response("x", { status: 500 })
        : undefined,
    );
    const state = await begin(h);
    const res = await h.app.fetch(
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: `__Host-oauth_state=${state}` },
      }),
    );
    expect(res.headers.get("location")).toBe("/login?error=discord");
  });
});

describe("session cookie handling", () => {
  it("treats a stale cookie as signed out and clears it", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/api/me", {
        headers: { Cookie: "__Host-session=stale" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join("\n")).toMatch(
      /__Host-session=;.*Max-Age=0/,
    );
  });

  it("redirects /dashboard to login with next when signed out", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/dashboard/usage?range=7d"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent("/dashboard/usage?range=7d")}`,
    );
  });

  it("refuses a cross-origin POST", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/logout", {
        method: "POST",
        headers: {
          Cookie: `__Host-session=${token}`,
          Origin: "https://evil.test",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(await readAuthSession(h.deps.redis, token)).not.toBeNull();
  });

  it("logs out one session, or all with everywhere=1", async () => {
    h = await makeHarness();
    const a = await createAuthSession(h.deps.redis, alice);
    const b = await createAuthSession(h.deps.redis, alice);
    const out = await h.app.fetch(
      new Request("https://uploader.test/auth/logout", {
        method: "POST",
        headers: { Cookie: `__Host-session=${a}`, ...ORIGIN },
      }),
    );
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/login?signedout=1");
    expect(await readAuthSession(h.deps.redis, a)).toBeNull();
    expect(await readAuthSession(h.deps.redis, b)).not.toBeNull();

    // A third, untouched session: only "everywhere" logout should reach
    // it. If the everywhere branch were ignored, only the cookie's own
    // session (b) would be deleted and c would survive.
    const c = await createAuthSession(h.deps.redis, alice);
    const body = new URLSearchParams({ everywhere: "1" });
    await h.app.fetch(
      new Request("https://uploader.test/auth/logout", {
        method: "POST",
        body,
        headers: {
          Cookie: `__Host-session=${b}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...ORIGIN,
        },
      }),
    );
    expect(await readAuthSession(h.deps.redis, b)).toBeNull();
    expect(await readAuthSession(h.deps.redis, c)).toBeNull();
  });

  it("keeps the session cookie when the Redis read fails", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    const originalPipeline = h.deps.redis.pipeline.bind(h.deps.redis);
    h.deps.redis.pipeline = (() => {
      const fake = {
        hgetall: () => fake,
        ttl: () => fake,
        exec: async () => [
          [new Error("redis down"), undefined],
          [new Error("redis down"), undefined],
        ],
      };
      return fake;
    }) as typeof h.deps.redis.pipeline;

    const res = await h.app.fetch(
      new Request("https://uploader.test/api/me", {
        headers: { Cookie: `__Host-session=${token}` },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join("\n")).not.toMatch(
      /__Host-session=;/,
    );

    h.deps.redis.pipeline = originalPipeline;
  });
});

describe("session cookies on Astro-rendered pages", () => {
  function sessionCookies(res: Response): string[] {
    return res.headers
      .getSetCookie()
      .filter((c) => c.startsWith("__Host-session="));
  }

  for (const page of ["/dashboard", "/dashboard/usage"]) {
    it(`re-issues a sliding session cookie on ${page}`, async () => {
      h = await makeHarness();
      const token = await createAuthSession(h.deps.redis, alice);
      await h.deps.redis.expire(`auth:${digest(token)}`, 86_400);

      const res = await h.app.fetch(
        new Request(`https://uploader.test${page}`, {
          headers: { Cookie: `__Host-session=${token}` },
        }),
      );

      expect(res.status).toBe(200);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(`__Host-session=${token};`);
      expect(cookies[0]).toMatch(`Max-Age=${AUTH_SESSION_TTL_SECONDS}`);
      // The page's own headers survive the merge.
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    });
  }

  it("clears a stale cookie on /login", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/login", {
        headers: { Cookie: "__Host-session=stale" },
      }),
    );

    expect(res.status).toBe(200);
    const cookies = sessionCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/__Host-session=;.*Max-Age=0/);
  });

  for (const path of ["/api/me", "/dashboard"]) {
    it(`clears a stale cookie exactly once on ${path}`, async () => {
      h = await makeHarness();
      const res = await h.app.fetch(
        new Request(`https://uploader.test${path}`, {
          headers: { Cookie: "__Host-session=stale" },
        }),
      );

      expect(sessionCookies(res)).toHaveLength(1);
    });
  }
});
