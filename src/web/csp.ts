/** Strict policy for the single-use upload/gallery pages. Unchanged from the Hono-rendered originals. */
export const UPLOAD_PAGE_CSP =
  "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";
