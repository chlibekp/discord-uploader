import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import {
  readSessionCookie,
  clearSessionCookie,
  setSessionCookie,
  setStateCookie,
  takeStateCookie,
} from "../auth/cookies.js";
import {
  authorizeUrl,
  consumeOAuthState,
  createOAuthState,
  exchangeCode,
  safeNext,
} from "../auth/oauth.js";
import {
  createAuthSession,
  deleteAllAuthSessions,
  deleteAuthSession,
} from "../auth/sessions.js";
import type { AuthEnv } from "../auth/types.js";

export function authRoutes(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/auth/login", async (c) => {
    if (!deps.config.discordClientSecret) return c.redirect("/login", 302);
    const next = safeNext(c.req.query("next"));
    if (c.get("user")) return c.redirect(next, 302);
    const state = await createOAuthState(deps.redis, next);
    setStateCookie(c, state);
    return c.redirect(authorizeUrl(deps.config, state), 302);
  });

  app.get("/auth/callback", async (c) => {
    const cookieState = takeStateCookie(c);
    if (c.req.query("error")) return c.redirect("/login?error=cancelled", 302);

    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    if (!state || !code || state !== cookieState)
      return c.redirect("/login?error=expired", 302);
    const next = await consumeOAuthState(deps.redis, state);
    if (next === null) return c.redirect("/login?error=expired", 302);

    let user;
    try {
      user = await exchangeCode(deps.config, deps.fetch, code);
    } catch (err) {
      console.error("Discord sign-in failed:", err);
      return c.redirect("/login?error=discord", 302);
    }

    const token = await createAuthSession(deps.redis, user);
    setSessionCookie(c, token);
    console.log(`Signed in ${user.id}`);
    return c.redirect(next, 302);
  });

  app.post("/auth/logout", async (c) => {
    const user = c.get("user");
    const form = await c.req
      .parseBody()
      .catch(() => ({}) as Record<string, unknown>);
    if (form.everywhere === "1" && user) {
      await deleteAllAuthSessions(deps.redis, user.id);
    } else {
      await deleteAuthSession(deps.redis, readSessionCookie(c));
    }
    clearSessionCookie(c);
    return c.redirect("/login?signedout=1", 302);
  });

  return app;
}
