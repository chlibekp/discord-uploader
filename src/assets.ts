import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `public/` sits one level above both `src/` and `dist/`, so the same relative
 * path resolves under tsx and under the compiled build.
 */
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

function readText(name: string): string {
  return readFileSync(path.join(publicDir, name), "utf8");
}

function readBinary(name: string): Buffer {
  return readFileSync(path.join(publicDir, name));
}

export const assets = {
  uploadHtml: readText("upload.html"),
  uploadJs: readText("upload.js"),
  uploadCss: readText("upload.css"),
  galleryHtml: readText("gallery.html"),
  galleryJs: readText("gallery.js"),
  galleryFiltersJs: readText("gallery-filters.js"),
  /** 128px sprite for the brand bar and the favicon. */
  mascotSmall: readBinary("brand/mascot-small.png"),
  /** 512px sprite for the empty state and link previews. */
  mascot: readBinary("brand/mascot.png"),
  /** Silkscreen, bundled under the OFL so no remote font request is needed. */
  fontRegular: readBinary("brand/silkscreen-400.woff2"),
  fontBold: readBinary("brand/silkscreen-700.woff2"),
};

export const UPLOAD_PAGE_CSP =
  "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";
