/** Strict policy for the single-use upload/gallery pages. Unchanged from the Hono-rendered originals. */
export const UPLOAD_PAGE_CSP =
  "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";

/**
 * Header policy for the login and dashboard pages. Astro adds a <meta> policy
 * carrying the hashes of its inline island scripts; browsers enforce both, so
 * the effective script policy is 'self' plus those hashes. Styles allow
 * 'unsafe-inline' because Motion and React write style attributes.
 */
export const DASHBOARD_CSP =
  "default-src 'self'; img-src 'self' blob: data: https://cdn.discordapp.com; media-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; " +
  "form-action 'self' https://discord.com; base-uri 'none'; frame-ancestors 'none'";
