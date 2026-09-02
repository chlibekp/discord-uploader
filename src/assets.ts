import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `public/` sits one level above both `src/` and `dist/`, so the same relative
 * path resolves under tsx and under the compiled build.
 */
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

function read(name: string): string {
  return readFileSync(path.join(publicDir, name), "utf8");
}

export const assets = {
  uploadHtml: read("upload.html"),
  uploadJs: read("upload.js"),
  uploadCss: read("upload.css"),
};

export const UPLOAD_PAGE_CSP =
  "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";
