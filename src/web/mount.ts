import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AppDeps } from "../app.js";
import { UPLOAD_PAGE_CSP } from "./csp.js";

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
    if (!res) return c.text("Not found", 404);
    const pathname = new URL(c.req.raw.url).pathname;
    return withHtmlCharset(await applyPageCsp(res, pathname));
  });

  return app;
}

/**
 * Astro sends a bare `text/html`. A scraper that ignores `<meta charset>`
 * (Discord reads the OG tags on /v/:id) could misdecode non-ASCII filenames,
 * so restore the charset the Hono pages always sent. Headers can be
 * immutable, hence a new Response rather than a set().
 */
function withHtmlCharset(res: Response): Response {
  if (res.headers.get("Content-Type") !== "text/html") return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Type", "text/html; charset=UTF-8");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** Pages that pin their own fixed policy, keyed by path prefix. */
const FIXED_CSP: Array<[prefix: string, policy: string]> = [
  ["/u/", UPLOAD_PAGE_CSP],
  ["/g/", UPLOAD_PAGE_CSP],
];

/**
 * Astro's CSP feature (enabled in `web/astro.config.mjs`) computes script and
 * style hashes across the whole build and writes them straight onto every
 * on-demand route's `Content-Security-Policy` header, clobbering whatever a
 * page set for itself in its frontmatter (`Astro.response.headers.set(...)`).
 * For pages that pin a fixed policy (`UPLOAD_PAGE_CSP`, and `DASHBOARD_CSP`
 * once Tasks 13/14 wire it up), this restores that exact header afterwards
 * and folds Astro's own hash-bearing value into a `<meta>` tag instead, so
 * the browser enforces the intersection of both. Routes with no fixed policy
 * (`/v/:id`) have Astro's header stripped entirely, so they stay exactly as
 * CSP-free as the pre-Astro pages were.
 */
async function applyPageCsp(
  res: Response,
  pathname: string,
): Promise<Response> {
  const astroCsp = res.headers.get("Content-Security-Policy");
  if (!astroCsp) return res;

  const headers = new Headers(res.headers);
  const fixed = FIXED_CSP.find(([prefix]) => pathname.startsWith(prefix))?.[1];
  if (!fixed) {
    headers.delete("Content-Security-Policy");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  headers.set("Content-Security-Policy", fixed);
  const html = await res.text();
  const withMeta = html.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${astroCsp.replace(/"/g, "&quot;")}">`,
  );
  return new Response(withMeta, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
