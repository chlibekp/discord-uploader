/**
 * The dashboard and login pages never opt out of Astro's own CSP (see
 * `web/astro.config.mjs` `security.csp` and `src/web/csp.ts`), so there is no
 * `DASHBOARD_CSP` here to set. This only marks the response as
 * personalised and never cacheable.
 */
export function dashboardHeaders(headers: Headers): void {
  headers.set("Cache-Control", "no-store");
}
