import type { SniffResult } from "../types.js";

/** Longest prefix any check below inspects. */
export const SNIFF_BYTES = 64;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** ISO base media brands we accept as MP4. */
const MP4_BRANDS = new Set([
  "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1",
  "dash", "mmp4", "M4V ", "M4A ", "3gp4", "3gp5",
]);

/**
 * Identify a file from its leading bytes.
 *
 * The result decides the stored extension and the Content-Type we later serve,
 * so a client-supplied filename or MIME type never influences either. Returns
 * null for anything outside the image/video allowlist.
 */
export function sniff(head: Buffer): SniffResult | null {
  if (head.length < 12) return null;

  if (head.subarray(0, 8).equals(PNG)) {
    return { mime: "image/png", ext: "png", kind: "image" };
  }
  if (head.subarray(0, 3).equals(JPEG)) {
    return { mime: "image/jpeg", ext: "jpg", kind: "image" };
  }

  const first6 = head.subarray(0, 6).toString("latin1");
  if (first6 === "GIF87a" || first6 === "GIF89a") {
    return { mime: "image/gif", ext: "gif", kind: "image" };
  }

  if (
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp", kind: "image" };
  }

  if (head.subarray(0, 4).equals(EBML)) {
    // Matroska and WebM share the EBML header; only WebM is accepted, and its
    // DocType appears within the first EBML element.
    if (head.subarray(0, SNIFF_BYTES).toString("latin1").includes("webm")) {
      return { mime: "video/webm", ext: "webm", kind: "video" };
    }
    return null;
  }

  if (head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") {
      return { mime: "image/avif", ext: "avif", kind: "image" };
    }
    if (brand === "qt  ") {
      return { mime: "video/quicktime", ext: "mov", kind: "video" };
    }
    if (MP4_BRANDS.has(brand)) {
      return { mime: "video/mp4", ext: "mp4", kind: "video" };
    }
    return null;
  }

  return null;
}

/**
 * Reduce a client filename to the display portion of a URL path. The extension
 * is dropped because the sniffed type supplies it.
 */
export function slugifyBasename(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]{1,10}$/, "");
  const slug = withoutExt
    .normalize("NFKD")
    // Drop the combining marks NFKD split off, so "é" folds to "e" rather than
    // to a separator.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "file";
}
