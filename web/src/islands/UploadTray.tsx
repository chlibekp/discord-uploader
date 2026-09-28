import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ApiLimits } from "@server/me/types";
import { readDimensions } from "../../../public/measure.js";
import { formatBytes } from "../lib/format";
import { ACCEPT_ATTR, preflight } from "../lib/preflight";
import {
  isBusy,
  nextToStart,
  queueReducer,
  type QueueAction,
  type QueueItem,
} from "../lib/queue";
import { addFile, refreshSummary, summaryStore } from "../lib/state";
import { ApiError } from "../lib/api";
import { toast } from "../lib/toast";
import { uploadFile } from "../lib/uploader";
import CopyButton from "./CopyButton";

const TTL_KEY = "dash:ttl";

function readTtl(limits: ApiLimits): string {
  try {
    const saved = localStorage.getItem(TTL_KEY);
    if (saved && limits.ttlOptions.some((o) => o.value === saved)) return saved;
  } catch {
    /* storage blocked: fall through */
  }
  return limits.defaultTtl;
}

/** Paste into a text field belongs to the field unless it carries only files. */
function isTextTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

function Thumb({ file }: { file: File | undefined }) {
  const url = useMemo(
    () =>
      file && file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    [file],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (url) return <img className="tray-thumb" src={url} alt="" />;
  return (
    <span className="tray-thumb pixel" aria-hidden="true">
      {file?.type.startsWith("video/") ? "VID" : "?"}
    </span>
  );
}

const STATUS_TEXT: Record<QueueItem["status"], (i: QueueItem) => string> = {
  queued: () => "waiting",
  uploading: (i) => `${Math.round(i.progress * 100)}%`,
  done: () => "done",
  failed: () => "failed",
  cancelled: () => "cancelled",
};

export default function UploadTray({ limits }: { limits: ApiLimits }) {
  const [items, dispatch] = useReducer(queueReducer, []);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const files = useRef(new Map<string, File>());
  const running = useRef<{ key: string; abort(): void } | null>(null);
  /** Names uploaded since the queue last drained, for one summary toast. */
  const uploaded = useRef<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [said, setSaid] = useState("");
  const [ttl, setTtl] = useState(limits.defaultTtl);
  const ttlRef = useRef(ttl);
  ttlRef.current = ttl;

  useEffect(() => setTtl(readTtl(limits)), [limits]);
  useEffect(() => {
    if (!summaryStore.get()) void refreshSummary();
  }, []);

  const enqueue = useCallback(
    (list: File[]) => {
      if (list.length === 0) return;
      const s = summaryStore.get();
      const pending = itemsRef.current.filter(
        (i) => i.status === "queued" || i.status === "uploading",
      );
      const remaining = s?.rateLimits.uploads.remaining ?? null;
      const quotaFree =
        (s ? s.storage.quota - s.storage.used : limits.maxUserBytes) -
        pending.reduce((n, i) => n + i.size, 0);
      const result = preflight(
        list,
        {
          maxFileBytes: limits.maxFileBytes,
          maxUserBytes: limits.maxUserBytes,
          uploadsRemaining:
            remaining === null ? null : Math.max(0, remaining - pending.length),
        },
        quotaFree,
      );
      if (result.willEvict)
        toast(
          "Not enough free space: your oldest files will be removed to make room.",
          "info",
          7000,
        );
      const add = list.map((f, i) => {
        const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        files.current.set(key, f);
        return {
          key,
          name: f.name || "pasted-image.png",
          size: f.size,
          type: f.type,
          error: result.errors[i] ?? null,
        };
      });
      dispatch({ type: "add", items: add });
      const refused = result.errors.filter(Boolean).length;
      const queued = list.length - refused;
      setSaid(
        [
          queued > 0 && `${queued} ${queued === 1 ? "file" : "files"} queued`,
          refused > 0 && `${refused} refused`,
        ]
          .filter(Boolean)
          .join(", "),
      );
      setOpen(true);
    },
    [limits],
  );

  // Run one upload at a time.
  useEffect(() => {
    const next = nextToStart(items);
    if (!next || running.current) return;
    const file = files.current.get(next.key);
    if (!file) {
      dispatch({
        type: "fail",
        key: next.key,
        error: "File is no longer available",
      });
      return;
    }
    dispatch({ type: "start", key: next.key });
    // Cancel while measuring aborts the measurement, which settles at once.
    const measuring = new AbortController();
    running.current = { key: next.key, abort: () => measuring.abort() };
    void (async () => {
      const url = URL.createObjectURL(file);
      const dims = await readDimensions(file, url, {
        signal: measuring.signal,
      });
      URL.revokeObjectURL(url);
      // Cancelled while measuring: free the slot, then nudge the effect (a
      // progress action always yields a new array) so the next file starts.
      // Only the abort flag can say so. itemsRef is refreshed on render, and a
      // fast measurement can finish before the "start" above has rendered, so
      // reading the row's status there saw "queued", bailed out, and left the
      // row stuck at 0% for good.
      if (measuring.signal.aborted) {
        running.current = null;
        dispatch({ type: "progress", key: next.key, progress: 0 });
        return;
      }
      const handle = uploadFile(file, { ttl: ttlRef.current, ...dims }, (p) =>
        dispatch({ type: "progress", key: next.key, progress: p }),
      );
      running.current = { key: next.key, abort: handle.abort };
      let outcome: QueueAction;
      try {
        const result = await handle.promise;
        outcome = { type: "done", key: next.key, result };
        addFile(result);
        void refreshSummary();
        uploaded.current.push(next.name);
      } catch (err) {
        const error = (err as Error).message;
        outcome = { type: "fail", key: next.key, error };
        // The user's own cancel needs no toast; status -1 is an abort.
        if (!(err instanceof ApiError && err.status === -1))
          toast(`Couldn't upload ${next.name}: ${error}`, "error", 8000);
      }
      // Free the slot *before* dispatching: the dispatch re-runs this effect,
      // which must see the slot empty to start the next queued file.
      running.current = null;
      dispatch(outcome);
    })();
  }, [items]);

  // Upload button, drag anywhere, paste.
  useEffect(() => {
    // Dragging a tile or link inside the page is not an upload.
    let internal = false;
    const onStart = () => {
      internal = true;
    };
    const onEnd = () => {
      internal = false;
      setDragging(false);
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-upload-trigger]"))
        input.current?.click();
    };
    const hasFiles = (e: DragEvent) =>
      !internal && [...(e.dataTransfer?.types ?? [])].includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      enqueue([...(e.dataTransfer?.files ?? [])]);
    };
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      const pasted = [...(data?.files ?? [])];
      if (pasted.length === 0) return;
      if (isTextTarget(e.target) && data?.types.includes("text/plain")) return;
      e.preventDefault();
      enqueue(pasted);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("dragstart", onStart);
    document.addEventListener("dragend", onEnd);
    window.addEventListener("dragenter", onOver);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("dragstart", onStart);
      document.removeEventListener("dragend", onEnd);
      window.removeEventListener("dragenter", onOver);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, [enqueue]);

  const busy = isBusy(items);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  // One success toast when the queue drains, not one per file: a batch of
  // ten would push any error toast out of the four-deep stack, and each row
  // already shows its own "done".
  useEffect(() => {
    if (busy || uploaded.current.length === 0) return;
    const names = uploaded.current;
    uploaded.current = [];
    toast(
      names.length === 1
        ? `Uploaded ${names[0]}`
        : `Uploaded ${names.length} files`,
      "success",
    );
  }, [busy]);

  // Finished rows keep their File until cleared, so Retry can resend it.
  const clearFinished = () => {
    for (const i of itemsRef.current)
      if (i.status !== "queued" && i.status !== "uploading")
        files.current.delete(i.key);
    dispatch({ type: "clearFinished" });
  };

  const cancel = (key: string) => {
    if (running.current?.key === key) running.current.abort();
    dispatch({ type: "cancel", key });
  };

  const done = items.filter((i) => i.status === "done").length;
  const hasFinished = items.some(
    (i) => i.status !== "queued" && i.status !== "uploading",
  );

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          enqueue([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-in panel">
            <div>
              <span className="pixel">Drop to upload</span>
            </div>
          </div>
        </div>
      )}
      <section className="tray panel" aria-label="Uploads">
        <div className="tray-in">
          <header className="tray-head">
            <button
              type="button"
              className="tray-toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <span className="pixel">Uploads</span>
              {items.length > 0 && (
                <span className="count">
                  {done}/{items.length}
                </span>
              )}
            </button>
            <label className="tray-ttl">
              <span className="muted">Keep for</span>
              <select
                className="toolbar-select"
                value={ttl}
                onChange={(e) => {
                  setTtl(e.target.value);
                  try {
                    localStorage.setItem(TTL_KEY, e.target.value);
                  } catch {
                    /* per-viewer convenience only */
                  }
                }}
              >
                {limits.ttlOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {hasFinished && (
              <button
                type="button"
                className="button small"
                onClick={clearFinished}
              >
                Clear
              </button>
            )}
          </header>
          {open &&
            (items.length === 0 ? (
              <p className="muted tray-hint">
                Drop files anywhere, paste an image, or press Upload.
              </p>
            ) : (
              <ul className="tray-list">
                {items.map((i) => (
                  <li key={i.key} className={`tray-row ${i.status}`}>
                    <Thumb file={files.current.get(i.key)} />
                    <div className="tray-main">
                      <span className="tray-name" title={i.name}>
                        {i.name}
                      </span>
                      <span className="muted">
                        {formatBytes(i.size)} · {STATUS_TEXT[i.status](i)}
                      </span>
                      {i.status === "uploading" && (
                        <div
                          className="progress"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(i.progress * 100)}
                          aria-label={`Uploading ${i.name}`}
                        >
                          <div
                            className="progress-bar"
                            style={{ width: `${i.progress * 100}%` }}
                          />
                        </div>
                      )}
                      {i.status === "failed" && i.error && (
                        <span className="status error">{i.error}</span>
                      )}
                    </div>
                    <div className="tray-acts">
                      {i.status === "done" && i.result && (
                        <CopyButton
                          text={i.result.watchUrl ?? i.result.url}
                          label="Copy"
                        />
                      )}
                      {(i.status === "failed" || i.status === "cancelled") &&
                        i.retryable && (
                          <button
                            type="button"
                            className="button small"
                            aria-label={`Retry ${i.name}`}
                            onClick={() =>
                              dispatch({ type: "retry", key: i.key })
                            }
                          >
                            Retry
                          </button>
                        )}
                      {(i.status === "queued" || i.status === "uploading") && (
                        <button
                          type="button"
                          className="button small"
                          aria-label={`Cancel ${i.name}`}
                          onClick={() => cancel(i.key)}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ))}
          <div className="sr-only" role="status" aria-live="polite">
            {said}
          </div>
        </div>
      </section>
    </>
  );
}
