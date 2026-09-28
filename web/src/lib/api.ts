import type { ApiFile } from "@server/me/types";
import { toast } from "./toast";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let redirecting = false;
export function handleUnauthorized(): void {
  if (redirecting) return;
  redirecting = true;
  toast("Session ended, sign in again", "error");
  const next = encodeURIComponent(location.pathname + location.search);
  setTimeout(() => location.assign(`/login?next=${next}`), 1200);
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "Network error. Check your connection.");
  }
  if (res.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, "Session ended");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok)
    throw new ApiError(
      res.status,
      body.error ?? `Request failed (${res.status})`,
    );
  return body as T;
}

export const getJson = <T>(path: string) => request<T>(path);

export const deleteFile = (id: string) =>
  request<void>(`/api/me/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const deleteFiles = (ids: string[]) =>
  request<{ deleted: string[]; missing: string[] }>("/api/me/files/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });

export type { ApiFile };
