"use strict";

/**
 * Pure helpers behind the gallery's filter box, sort control and live
 * countdown. Kept dependency-free and DOM-free so they can be unit tested
 * directly and imported by gallery.js as an ES module.
 */

/** Case-insensitive substring match, empty query matches everything. */
export function matchesFilter(name, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return true;
  return (name ?? "").toLowerCase().includes(q);
}

/** Filters a list of `{name, ...}` records down to those matching the query. */
export function filterRecords(records, query) {
  return records.filter((record) => matchesFilter(record.name, query));
}

/** A file with no expiry sorts after every file that does have one. */
function expirySortValue(expiresAt) {
  return expiresAt ? expiresAt : Infinity;
}

export const SORTS = {
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  largest: (a, b) => b.size - a.size,
  smallest: (a, b) => a.size - b.size,
  soonest: (a, b) => expirySortValue(a.expiresAt) - expirySortValue(b.expiresAt),
};

export const SORT_MODES = Object.keys(SORTS);

/** Stable sort of `records` by `mode`; falls back to newest for an unknown mode. */
export function sortRecords(records, mode) {
  const cmp = SORTS[mode] || SORTS.newest;
  return [...records].sort(cmp);
}

/**
 * Remaining-lifetime label, recomputed on every tick so it counts down live
 * instead of freezing at render time. `expiresAt` of 0 means the file has no
 * expiry.
 */
export function formatRemaining(expiresAt, now = Date.now()) {
  if (!expiresAt) return "kept until full";

  const remainMs = expiresAt - now;
  if (remainMs <= 0) return "expiring now";

  const totalSeconds = Math.floor(remainMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days >= 1) return `deletes in ${days}d ${hours}h`;
  if (hours >= 1) return `deletes in ${hours}h ${minutes}m`;
  if (minutes >= 1) return `deletes in ${minutes}m ${seconds}s`;
  return `deletes in ${seconds}s`;
}
