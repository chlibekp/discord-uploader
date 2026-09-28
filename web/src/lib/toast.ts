import { createStore } from "./store";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
}

export const toastStore = createStore<Toast[]>([]);
/** Screen-reader-only announcements (armed delete, results). */
export const announceStore = createStore("");

let nextId = 1;

export function toast(
  message: string,
  kind: Toast["kind"] = "info",
  ms = 4000,
): void {
  const id = nextId++;
  toastStore.set((list) => [...list.slice(-3), { id, message, kind }]);
  setTimeout(
    () => toastStore.set((list) => list.filter((t) => t.id !== id)),
    ms,
  );
}

export function announce(message: string): void {
  // Clearing first makes a repeated message announce again.
  announceStore.set("");
  queueMicrotask(() => announceStore.set(message));
}
