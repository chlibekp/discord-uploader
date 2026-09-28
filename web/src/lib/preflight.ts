import { formatBytes } from "./format";

export const ACCEPTED_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
export const ACCEPT_ATTR = [...ACCEPTED_TYPES].join(",");

export interface PreflightLimits {
  maxFileBytes: number;
  maxUserBytes: number;
  /** null = no hourly limit. */
  uploadsRemaining: number | null;
}

/**
 * Catch what the server would refuse before sending a byte. Quota is not one
 * of those: the server evicts the uploader's own oldest files to make room, so
 * that only earns a warning.
 */
export function preflight(
  files: readonly { name: string; size: number; type: string }[],
  limits: PreflightLimits,
  quotaFree: number,
): { errors: (string | null)[]; willEvict: boolean } {
  let accepted = 0;
  let bytes = 0;
  const errors = files.map((f) => {
    if (!ACCEPTED_TYPES.has(f.type))
      return "Only images and videos are accepted";
    if (f.size > limits.maxFileBytes)
      return `Over the ${formatBytes(limits.maxFileBytes)} file limit`;
    if (f.size > limits.maxUserBytes)
      return `Bigger than your whole ${formatBytes(limits.maxUserBytes)} quota`;
    if (limits.uploadsRemaining !== null && accepted >= limits.uploadsRemaining)
      return "Over your hourly upload limit";
    accepted += 1;
    bytes += f.size;
    return null;
  });
  return { errors, willEvict: bytes > quotaFree };
}
