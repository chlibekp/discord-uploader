import { useEffect, useRef } from "react";
import type { ApiFile } from "@server/me/types";
import { formatBytes, formatDate } from "../lib/format";
import ArmButton from "./ArmButton";
import CopyButton from "./CopyButton";
import Expiry from "./Expiry";

interface Props {
  files: ApiFile[];
  openId: string;
  onClose(): void;
  onNavigate(id: string): void;
  onDelete(file: ApiFile): Promise<void>;
}

/** Focusable elements a Tab trap should cycle between. */
const FOCUSABLE = "button, a[href], video[controls], select, input";

export default function Lightbox({
  files,
  openId,
  onClose,
  onNavigate,
  onDelete,
}: Props) {
  const index = files.findIndex((f) => f.id === openId);
  const file = index >= 0 ? files[index] : undefined;
  const dialog = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  // An id that is not (or no longer) in the visible list closes the viewer,
  // e.g. after a filter change or a delete elsewhere removes the last copy.
  useEffect(() => {
    if (!file) onClose();
  }, [file, onClose]);

  // Runs once per mount: capture the triggering element, move focus into the
  // dialog, lock the page scroll, and restore both on unmount. Navigating
  // between files does not remount the component, so this does not re-fire.
  useEffect(() => {
    returnTo.current = document.activeElement;
    dialog.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      (returnTo.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && index < files.length - 1) {
        onNavigate(files[index + 1]!.id);
      } else if (e.key === "ArrowLeft" && index > 0) {
        onNavigate(files[index - 1]!.id);
      } else if (e.key === "Tab" && dialog.current) {
        // Keep focus inside the dialog.
        const focusable = Array.from(
          dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE),
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (!active || !focusable.includes(active as HTMLElement)) {
          // Focus isn't on any of the dialog's tabbable elements: it's still
          // on the dialog root itself (right after open, which sits at
          // tabIndex -1 and so never matches FOCUSABLE), or it was knocked
          // out to <body> because whatever held it disappeared — the
          // prev/next button at a list edge, or ArmButton going `disabled`
          // mid-delete. Either way, pull it back into the dialog rather than
          // let Tab/Shift+Tab escape to the page behind.
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [files, index, onClose, onNavigate]);

  if (!file) return null;
  const share = file.watchUrl ?? file.url;
  const video = file.kind === "video";

  async function remove() {
    // Navigate first, then delete in the background. onDelete resolves once
    // the file list has already dropped the deleted id, so if the list
    // update lands before this function's continuation, the "id no longer
    // in the list" effect above would otherwise race this navigation and
    // close the viewer instead of advancing it.
    const target = file!;
    const next = files[index + 1] ?? files[index - 1];
    if (next) onNavigate(next.id);
    else onClose();
    await onDelete(target);
  }

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      tabIndex={-1}
      ref={dialog}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="lb-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {video ? (
          <video key={file.id} controls autoPlay playsInline src={file.url} />
        ) : (
          <img key={file.id} src={file.url} alt={file.name} />
        )}
      </div>
      <aside className="lb-side panel">
        <div className="lb-side-in">
          <h2 className="lb-name">{file.name}</h2>
          <dl className="lb-facts">
            <dt>Size</dt>
            <dd>{formatBytes(file.size)}</dd>
            <dt>Dimensions</dt>
            <dd>
              {file.width && file.height
                ? `${file.width}×${file.height}`
                : "unknown"}
            </dd>
            <dt>Uploaded</dt>
            <dd>{formatDate(file.createdAt)}</dd>
            <dt>Lifetime</dt>
            <dd>
              <Expiry at={file.expiresAt} />
            </dd>
          </dl>
          <div className="lb-actions">
            <CopyButton
              text={share}
              label={video ? "Copy page" : "Copy link"}
            />
            {video && <CopyButton text={file.url} label="Copy direct" />}
            <a
              className="button small"
              href={share}
              target="_blank"
              rel="noopener"
            >
              Open
            </a>
            <ArmButton describe={file.name} onConfirm={remove} />
          </div>
          <p className="muted">
            {index + 1} / {files.length} · ← → browse · Esc close
          </p>
        </div>
      </aside>
      <button
        type="button"
        className="button small lb-close"
        onClick={onClose}
        aria-label="Close viewer"
      >
        Esc
      </button>
      {index > 0 && (
        <button
          type="button"
          className="button small lb-prev"
          aria-label="Previous file"
          onClick={() => onNavigate(files[index - 1]!.id)}
        >
          ←
        </button>
      )}
      {index < files.length - 1 && (
        <button
          type="button"
          className="button small lb-next"
          aria-label="Next file"
          onClick={() => onNavigate(files[index + 1]!.id)}
        >
          →
        </button>
      )}
    </div>
  );
}
