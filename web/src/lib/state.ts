import type { ApiFile, ApiUsage } from "@server/me/types";
import { getJson } from "./api";
import { createStore, useStore } from "./store";

/** The Files tab's list. Uploads insert here, so the grid updates without a refetch. */
export const filesStore = createStore<ApiFile[]>([]);
/** 7-day usage summary: storage strip, tray pre-checks. */
export const summaryStore = createStore<ApiUsage | null>(null);

export function addFile(file: ApiFile): void {
  filesStore.set((list) => [file, ...list.filter((f) => f.id !== file.id)]);
}

export function removeFiles(ids: readonly string[]): void {
  const gone = new Set(ids);
  filesStore.set((list) => list.filter((f) => !gone.has(f.id)));
}

let inflight: Promise<void> | null = null;
export function refreshSummary(): Promise<void> {
  inflight ??= getJson<ApiUsage>("/api/me/usage?range=7d")
    .then((u) => summaryStore.set(u))
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** One shared 1s clock, so countdowns do not each run their own interval. */
export const nowStore = createStore(Date.now());
let ticking = false;
export function useNow(): number {
  if (!ticking && typeof window !== "undefined") {
    ticking = true;
    setInterval(() => nowStore.set(Date.now()), 1000);
  }
  return useStore(nowStore);
}
