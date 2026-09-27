import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AppDeps } from "../app.js";

/** Replaced by the import from ../auth/types.js in Task 8. */
export interface AuthUser {
  id: string;
  username: string;
  globalName: string;
  avatar: string;
}

export interface WebLocals {
  deps: AppDeps;
  user: AuthUser | null;
}

export type WebRenderer = (
  request: Request,
  locals: WebLocals,
) => Promise<Response | null>;

/** `web/dist` sits two levels above both `src/web/` and `dist/web/`. */
const webDist = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "dist",
);

export async function loadWebRenderer(): Promise<WebRenderer> {
  const entry = path.join(webDist, "server", "entry.mjs");
  if (!existsSync(entry)) {
    throw new Error(`Astro build missing at ${entry}. Run: pnpm build:web`);
  }
  const mod = (await import(pathToFileURL(entry).href)) as {
    render: WebRenderer;
  };
  return mod.render;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

/**
 * Hashed client assets plus the catch-all that hands everything Hono did not
 * match to Astro. Must be the last routes registered.
 */
export function webRoutes(
  deps: AppDeps,
): Hono<{ Variables: { user?: AuthUser | null } }> {
  // `user` is set by the auth middleware (Task 9) on the parent app; context
  // variables are shared with sub-apps, so it is visible here. Unset means signed out.
  const app = new Hono<{ Variables: { user?: AuthUser | null } }>();

  app.get("/_astro/:file", async (c) => {
    const file = c.req.param("file");
    // Build output names only: no separators, no dot-dot.
    if (!/^[\w.-]+$/.test(file) || file.includes("..")) return c.notFound();
    try {
      const body = await readFile(path.join(webDist, "client", "_astro", file));
      return c.body(body, 200, {
        "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": IMMUTABLE,
      });
    } catch {
      return c.notFound();
    }
  });

  app.all("*", async (c) => {
    if (!deps.web) return c.text("Not found", 404);
    const res = await deps.web(c.req.raw, {
      deps,
      user: c.get("user") ?? null,
    });
    return res ?? c.text("Not found", 404);
  });

  return app;
}
