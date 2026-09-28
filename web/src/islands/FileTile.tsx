import { memo, type KeyboardEvent, type MouseEvent } from "react";
import type { ApiFile } from "@server/me/types";
import { formatBytes, formatDate } from "../lib/format";
import ArmButton from "./ArmButton";
import CopyButton from "./CopyButton";
import Expiry from "./Expiry";

interface Props {
  file: ApiFile;
  selecting: boolean;
  selected: boolean;
  fresh: boolean;
  /** The grid's single Tab stop (roving tabindex). */
  tabStop: boolean;
  /** Handlers take the file's id so FilesView can pass one stable function to every tile. */
  onActivate(id: string, e: MouseEvent | KeyboardEvent): void;
  onOpen(id: string): void;
  onDelete(file: ApiFile): Promise<void>;
  onKeyDown(id: string, e: KeyboardEvent<HTMLElement>): void;
  onFocus(id: string): void;
}

/** Same markup and classes as the legacy gallery tile, so it inherits its look. */
function FileTile({
  file,
  selecting,
  selected,
  fresh,
  tabStop,
  onActivate,
  onOpen,
  onDelete,
  onKeyDown,
  onFocus,
}: Props) {
  const share = file.watchUrl ?? file.url;
  const video = file.kind === "video";
  // Only the Tab-stop tile's actions are in the Tab order, so Tab walks the
  // current tile's actions and then leaves the grid; arrows move between tiles.
  const inner = tabStop ? undefined : -1;
  return (
    <figure
      className={`tile panel${selected ? " selected" : ""}${fresh ? " fresh" : ""}${selecting ? " selecting" : ""}`}
      tabIndex={tabStop ? 0 : -1}
      role="gridcell"
      aria-label={file.name}
      aria-selected={selecting ? selected : undefined}
      data-tile
      data-id={file.id}
      onKeyDown={(e) => onKeyDown(file.id, e)}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocus(file.id);
      }}
      onClick={(e) => onActivate(file.id, e)}
    >
      <div className="tile-in">
        <a
          className="shot"
          href={share}
          tabIndex={-1}
          onClick={(e) => {
            // Ctrl/Cmd/Shift-click keeps the browser's "open in new tab/window".
            if (!selecting && (e.metaKey || e.ctrlKey || e.shiftKey)) {
              e.stopPropagation();
              return;
            }
            e.preventDefault();
          }}
        >
          {video ? (
            <>
              <video
                preload="metadata"
                muted
                playsInline
                src={`${file.url}#t=0.1`}
              />
              <span className="badge">VIDEO</span>
            </>
          ) : (
            <img
              loading="lazy"
              decoding="async"
              src={file.url}
              alt={file.name}
            />
          )}
          {selecting && (
            <span
              className={`tile-check${selected ? " on" : ""}`}
              aria-hidden="true"
            />
          )}
        </a>
        <div className="tile-body">
          <figcaption className="tile-name" title={file.name}>
            {file.name}
          </figcaption>
          <div className="tile-meta">
            <span>{formatBytes(file.size)}</span>
            <span>{formatDate(file.createdAt)}</span>
            <span className="tile-expiry">
              <Expiry at={file.expiresAt} />
            </span>
          </div>
          {/* Hidden, not removed, while selecting, so tiles keep their height. */}
          <div className="tile-actions">
            <button
              type="button"
              className="button small"
              tabIndex={inner}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(file.id);
              }}
            >
              View
            </button>
            <CopyButton
              text={share}
              label={video ? "Copy page" : "Copy link"}
              tabIndex={inner}
            />
            <ArmButton
              describe={file.name}
              onConfirm={() => onDelete(file)}
              tabIndex={inner}
            />
          </div>
        </div>
      </div>
    </figure>
  );
}

export default memo(FileTile);
