import type { AppDeps } from "../app.js";
import type { Config } from "../config.js";
import { fileUrl, watchUrl } from "../discord/followup.js";
import { peekRateLimit } from "../storage/ratelimit.js";
import type { RateLimitResult } from "../storage/ratelimit.js";
import { expireDue, listUserFiles, userBytes } from "../storage/store.js";
import { getUserUsage } from "../storage/usage.js";
import { DEFAULT_TTL_MS, TTL_OPTIONS } from "../ttl.js";
import type { FileRecord } from "../types.js";
import type {
  ApiFile,
  ApiLimits,
  ApiRate,
  ApiUsage,
  UsageRange,
} from "./types.js";

export const RANGE_DAYS: Record<UsageRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
/** Dashboards list everything; the single-use gallery keeps its 200 cap. */
const ALL_FILES = 100_000;

export function parseRange(raw: string | undefined): UsageRange {
  return raw === "7d" || raw === "30d" || raw === "90d" ? raw : "30d";
}

export function toApiFile(config: Config, r: FileRecord): ApiFile {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    kind: r.kind,
    size: r.size,
    width: r.width,
    height: r.height,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    url: fileUrl(config, r),
    watchUrl: r.kind === "video" ? watchUrl(config, r) : null,
  };
}

export function limitsFor(config: Config): ApiLimits {
  return {
    maxFileBytes: config.maxFileBytes,
    maxUserBytes: config.maxUserBytes,
    ttlOptions: TTL_OPTIONS.map((o) => ({
      value: o.value,
      label: o.name,
      ms: o.ms,
    })),
    defaultTtl:
      TTL_OPTIONS.find((o) => o.ms === DEFAULT_TTL_MS)?.value ?? "30d",
    uploadsPerHour: config.rateLimitUploadsPerHour,
    sessionsPerHour: config.rateLimitSessionsPerHour,
  };
}

export async function listMyFiles(
  deps: AppDeps,
  userId: string,
): Promise<ApiFile[]> {
  await expireDue(deps.redis, deps.config);
  const records = await listUserFiles(deps.redis, userId, ALL_FILES);
  return records.map((r) => toApiFile(deps.config, r));
}

function toApiRate(r: RateLimitResult): ApiRate {
  if (r.limit <= 0)
    return { used: 0, limit: 0, remaining: null, resetAt: r.resetAt };
  return {
    used: r.limit - r.remaining,
    limit: r.limit,
    remaining: r.remaining,
    resetAt: r.resetAt,
  };
}

export async function getMyUsage(
  deps: AppDeps,
  userId: string,
  range: UsageRange,
  now = Date.now(),
): Promise<ApiUsage> {
  await expireDue(deps.redis, deps.config, now);
  const [records, used, usage, uploads, sessions] = await Promise.all([
    listUserFiles(deps.redis, userId, ALL_FILES),
    userBytes(deps.redis, userId),
    getUserUsage(deps.redis, userId, RANGE_DAYS[range], now),
    peekRateLimit(
      deps.redis,
      "upload",
      userId,
      deps.config.rateLimitUploadsPerHour,
      now,
    ),
    peekRateLimit(
      deps.redis,
      "session",
      userId,
      deps.config.rateLimitSessionsPerHour,
      now,
    ),
  ]);

  const images = { count: 0, bytes: 0 };
  const videos = { count: 0, bytes: 0 };
  for (const r of records) {
    const bucket = r.kind === "video" ? videos : images;
    bucket.count += 1;
    bucket.bytes += r.size;
  }

  return {
    range,
    storage: { used, quota: deps.config.maxUserBytes, images, videos },
    series: usage.series,
    totals: {
      uploads: usage.series.reduce((n, p) => n + p.uploads, 0),
      bytes: usage.series.reduce((n, p) => n + p.bytes, 0),
      prevUploads: usage.previous.uploads,
      prevBytes: usage.previous.bytes,
    },
    commands: { range: usage.commandsInRange, allTime: usage.commandsAllTime },
    rateLimits: { uploads: toApiRate(uploads), sessions: toApiRate(sessions) },
    trackingSince: usage.trackingSince,
  };
}
