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
