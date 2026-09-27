import type { ApiFile } from "@server/me/types";
import { ApiError, handleUnauthorized } from "./api";

export interface UploadHandle {
  promise: Promise<ApiFile>;
  abort(): void;
}

/** XHR rather than fetch: fetch still has no upload progress events. */
export function uploadFile(
  file: File,
  fields: { ttl: string; width: number; height: number },
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<ApiFile>((resolve, reject) => {
    xhr.open("POST", "/api/me/files");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      let body: { file?: ApiFile; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* status decides below */
      }
      if (xhr.status === 201 && body.file) return resolve(body.file);
      if (xhr.status === 401) handleUnauthorized();
      reject(
        new ApiError(xhr.status, body.error ?? `Upload failed (${xhr.status})`),
      );
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError(0, "Network error during upload")),
    );
    xhr.addEventListener("abort", () => reject(new ApiError(-1, "Cancelled")));

    const form = new FormData();
    // Fields precede the file so the server knows ttl and dimensions before the bytes.
    form.append("ttl", fields.ttl);
    form.append("width", String(fields.width || 0));
    form.append("height", String(fields.height || 0));
    form.append("file", file, file.name || "pasted-image.png");
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
