import type { AuthUser } from "../auth/types.js";

export type UsageRange = "7d" | "30d" | "90d";

export interface ApiFile {
  id: string;
  name: string;
  mime: string;
  kind: "image" | "video";
  size: number;
  width: number;
  height: number;
  createdAt: number;
  expiresAt: number;
  url: string;
  watchUrl: string | null;
}

export interface ApiLimits {
  maxFileBytes: number;
  maxUserBytes: number;
  ttlOptions: { value: string; label: string; ms: number }[];
  defaultTtl: string;
  uploadsPerHour: number;
  sessionsPerHour: number;
}

/** `remaining: null` means unlimited. */
export interface ApiRate {
  used: number;
  limit: number;
  remaining: number | null;
  resetAt: number;
}

export interface ApiStorage {
  used: number;
  quota: number;
  images: { count: number; bytes: number };
  videos: { count: number; bytes: number };
}

export interface ApiUsage {
  range: UsageRange;
  storage: ApiStorage;
  series: { date: string; uploads: number; bytes: number }[];
  totals: {
    uploads: number;
    bytes: number;
    prevUploads: number;
    prevBytes: number;
  };
  commands: { range: Record<string, number>; allTime: Record<string, number> };
  rateLimits: { uploads: ApiRate; sessions: ApiRate };
  trackingSince: number;
}

export interface ApiMe {
  user: AuthUser;
  limits: ApiLimits;
}
