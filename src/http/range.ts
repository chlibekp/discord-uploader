export type RangeResult =
  | { type: "ok"; start: number; end: number }
  | { type: "unsatisfiable" }
  | { type: "none" };

/**
 * Parse a single byte range. Multi-range requests are answered with the whole
 * body ("none"), which is a legal response and all the Discord player needs.
 */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { type: "none" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { type: "none" };

  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return { type: "none" };
  if (size === 0) return { type: "unsatisfiable" };

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return { type: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { type: "none" };
  if (start >= size || start > end) return { type: "unsatisfiable" };

  return { type: "ok", start, end };
}
