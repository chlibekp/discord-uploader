/**
 * Strict policy for the single-use upload/gallery pages. Unchanged from the
 * Hono-rendered originals.
 *
 * Astro's own CSP feature (`security.csp` in `web/astro.config.mjs`)
 * overwrites the `Content-Security-Policy` header on every on-demand route
 * with its own hash-based policy, so a page cannot just set this header
 * directly in its frontmatter and expect it to survive. Instead, `/u/:sid`
 * and `/g/:gid` set this value on the internal `x-page-csp` header
 * (`Astro.response.headers.set("x-page-csp", UPLOAD_PAGE_CSP)`); the
 * catch-all route in `src/web/mount.ts` (`applyPageCsp`) reads that header,
 * applies it as the real `Content-Security-Policy` header, and strips
 * `x-page-csp` before the response reaches the client. `/v/:id` sets
 * `x-page-csp` to `"none"` to strip Astro's CSP entirely, matching the
 * pre-Astro original, which had no CSP header at all. Routes that never set
 * `x-page-csp` (the login and dashboard pages) keep whatever Astro computed
 * from `security.csp`'s own directives and script/style hashes.
 */
export const UPLOAD_PAGE_CSP =
  "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";
