/** Auto-delete choices offered by /upload, shared by command registration and
 * the interaction handler so the values never drift apart. */
export const TTL_OPTIONS = [
  { name: "1 hour", value: "1h", ms: 3_600_000 },
  { name: "24 hours", value: "24h", ms: 86_400_000 },
  { name: "7 days", value: "7d", ms: 604_800_000 },
  { name: "30 days", value: "30d", ms: 2_592_000_000 },
  { name: "Forever", value: "forever", ms: 0 },
] as const;

/** Applied when the uploader does not pick a ttl option. */
export const DEFAULT_TTL_MS = 2_592_000_000; // 30 days

export function ttlValueToMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TTL_MS;
  return TTL_OPTIONS.find((o) => o.value === value)?.ms ?? DEFAULT_TTL_MS;
}

export function describeTtl(ms: number): string {
  if (ms <= 0) return "kept until storage fills";
  return `auto-deletes after ${TTL_OPTIONS.find((o) => o.ms === ms)?.name ?? `${Math.round(ms / 86_400_000)} days`}`;
}
