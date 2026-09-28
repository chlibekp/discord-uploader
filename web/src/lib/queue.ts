import type { ApiFile } from "@server/me/types";

export type QueueStatus =
  "queued" | "uploading" | "done" | "failed" | "cancelled";

export interface QueueItem {
  key: string;
  name: string;
  size: number;
  type: string;
  status: QueueStatus;
  progress: number;
  error: string | null;
  /** False for pre-check failures: sending them again cannot succeed. */
  retryable: boolean;
  result: ApiFile | null;
}

export type QueueAction =
  | {
      type: "add";
      items: {
        key: string;
        name: string;
        size: number;
        type: string;
        error: string | null;
      }[];
    }
  | { type: "start"; key: string }
  | { type: "progress"; key: string; progress: number }
  | { type: "done"; key: string; result: ApiFile }
  | { type: "fail"; key: string; error: string }
  | { type: "cancel"; key: string }
  | { type: "retry"; key: string }
  | { type: "clearFinished" };

const live = (s: QueueStatus) => s === "queued" || s === "uploading";

export function queueReducer(
  state: QueueItem[],
  action: QueueAction,
): QueueItem[] {
  const map = (
    key: string,
    when: (i: QueueItem) => boolean,
    patch: Partial<QueueItem>,
  ) => state.map((i) => (i.key === key && when(i) ? { ...i, ...patch } : i));
  switch (action.type) {
    case "add":
      return [
        ...state,
        ...action.items.map((i) => ({
          ...i,
          status: (i.error ? "failed" : "queued") as QueueStatus,
          progress: 0,
          retryable: !i.error,
          result: null,
        })),
      ];
    case "start":
      return map(action.key, (i) => i.status === "queued", {
        status: "uploading",
        progress: 0,
        error: null,
      });
    case "progress":
      return map(action.key, (i) => i.status === "uploading", {
        progress: Math.min(1, Math.max(0, action.progress)),
      });
    case "done":
      return map(action.key, (i) => i.status === "uploading", {
        status: "done",
        progress: 1,
        result: action.result,
      });
    case "fail":
      return map(action.key, (i) => i.status !== "cancelled", {
        status: "failed",
        error: action.error,
      });
    case "cancel":
      return map(action.key, (i) => live(i.status), { status: "cancelled" });
    case "retry":
      return map(
        action.key,
        (i) =>
          i.retryable && (i.status === "failed" || i.status === "cancelled"),
        {
          status: "queued",
          progress: 0,
          error: null,
        },
      );
    case "clearFinished":
      return state.filter((i) => live(i.status));
  }
}

export function nextToStart(state: QueueItem[]): QueueItem | undefined {
  if (state.some((i) => i.status === "uploading")) return undefined;
  return state.find((i) => i.status === "queued");
}

export function isBusy(state: QueueItem[]): boolean {
  return state.some((i) => live(i.status));
}
