import type { MiddlewareHandler } from "hono";
import type { AppDeps } from "../app.js";
import type { Config } from "../config.js";
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from "./cookies.js";
import { readAuthSession } from "./sessions.js";
import type { AuthEnv } from "./types.js";

/** Resolves the session cookie to a user. Never throws: a Redis error means "signed out". */
export function loadUser(deps: AppDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    c.set("user", null);
    const token = readSessionCookie(c);
    if (token) {
      try {
        const found = await readAuthSession(deps.redis, token);
        if (found) {
          c.set("user", found.user);
          if (found.refreshed) setSessionCookie(c, token);
        } else {
          clearSessionCookie(c);
        }
      } catch (err) {
        console.error("Failed to read auth session:", err);
      }
    }
    await next();
  };
}

export const requireApiUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Not signed in" }, 401);
  await next();
};

export const requirePageUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get("user")) return next();
  const url = new URL(c.req.url);
  return c.redirect(
    `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
    302,
  );
};

/** Belt and braces on top of SameSite=Lax for every state-changing request. */
export function sameOrigin(config: Config): MiddlewareHandler {
  const expected = new URL(config.publicUrl).origin;
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    if (c.req.header("origin") !== expected) {
      return c.json({ error: "Cross-origin request refused" }, 403);
    }
    await next();
  };
}
