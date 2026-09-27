import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ApiFile, ApiUsage } from "@server/me/types";
import { filterRecords, sortRecords } from "../../../public/gallery-filters.js";
import { deleteFile, deleteFiles } from "../lib/api";
import { formatBytes } from "../lib/format";
import { rangeSelect, toggleId } from "../lib/selection";
import {
  filesStore,
  refreshSummary,
  removeFiles,
  summaryStore,
} from "../lib/state";
import { useStore } from "../lib/store";
import { announce, toast } from "../lib/toast";
import ArmButton from "./ArmButton";
import { RenderedAt } from "./Expiry";
import FileTile from "./FileTile";
import Lightbox from "./Lightbox";
import StorageStrip from "./StorageStrip";

type Kind = "all" | "image" | "video";
const SORTS = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
  ["largest", "Largest"],
  ["smallest", "Smallest"],
  ["soonest", "Soonest to expire"],
] as const;

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export default function FilesView({
  initialFiles,
  initialSummary,
  renderedAt,
}: {
  initialFiles: ApiFile[];
  initialSummary: ApiUsage;
  /** Server clock at render time; keeps the hydrating countdowns identical. */
  renderedAt: number;
}) {
  // The stores are module state and can hold another page's data after a
  // client-side navigation, so the first (hydrating) render must use the
  // server's props. Switch to the stores once mounted.
  const [mounted, setMounted] = useState(false);
  const storedFiles = useStore(filesStore);
  const storedSummary = useStore(summaryStore);
  const files = mounted ? storedFiles : initialFiles;
  const summary = (mounted && storedSummary) || initialSummary;

  useEffect(() => {
    // Navigation re-renders the page on the server, so its list is the freshest.
    filesStore.set(initialFiles);
    summaryStore.set(initialSummary);
    setMounted(true);
  }, [initialFiles, initialSummary]);

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState("newest");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selectBtnRef = useRef<HTMLButtonElement>(null);

  // Highlight files that arrive after mount (finished uploads).
  const known = useRef(new Set(initialFiles.map((f) => f.id)));
  const freshTimers = useRef(new Set<number>());
  useEffect(() => {
    if (!mounted) return;
    const arrived = files
      .filter((f) => !known.current.has(f.id))
      .map((f) => f.id);
    for (const f of files) known.current.add(f.id);
    if (arrived.length === 0) return;
    setFresh((s) => new Set([...s, ...arrived]));
    // Not cleared on the next change: a second upload landing within the
    // window must not strand the first one's highlight.
    const t = window.setTimeout(() => {
      freshTimers.current.delete(t);
      setFresh((s) => new Set([...s].filter((id) => !arrived.includes(id))));
    }, 1300);
    freshTimers.current.add(t);
  }, [files, mounted]);
  useEffect(() => {
    const timers = freshTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const visible = useMemo(() => {
    const byKind =
      kind === "all" ? files : files.filter((f) => f.kind === kind);
    return sortRecords(filterRecords(byKind, query), sort);
  }, [files, kind, query, sort]);
  const order = useMemo(() => visible.map((f) => f.id), [visible]);

  // Tile handlers read this instead of closing over state, so they stay
  // stable and the memoised tiles only re-render when their own props change.
  const live = useRef({ selecting, order });
  live.current = { selecting, order };

  // ----- lightbox <-> URL hash: Back closes it, reload reopens it -----
  const pushed = useRef(false);
  useEffect(() => {
    const read = () => {
      const m = location.hash.match(/^#f=(.+)$/);
      setOpenId(m ? decodeURIComponent(m[1]!) : null);
      if (!m) pushed.current = false;
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const open = useCallback((id: string) => {
    pushed.current = true;
    location.hash = `f=${encodeURIComponent(id)}`;
  }, []);
  const navigate = useCallback((id: string) => {
    history.replaceState(history.state, "", `#f=${encodeURIComponent(id)}`);
    setOpenId(id);
  }, []);
  const close = useCallback(() => {
    if (pushed.current) history.back();
    else {
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
      setOpenId(null);
    }
  }, []);

  // ----- focus -----
  const focusId = useCallback((id: string | undefined) => {
    if (!id) return;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
      ?.focus();
  }, []);
  const columns = () => {
    const tiles = gridRef.current?.querySelectorAll<HTMLElement>("[data-tile]");
    if (!tiles || tiles.length === 0) return 1;
    const top = tiles[0]!.offsetTop;
    let n = 0;
    for (const t of tiles) {
      if (t.offsetTop !== top) break;
      n += 1;
    }
    return n || 1;
  };

  // ----- delete -----
  const removeOne = useCallback(async (file: ApiFile) => {
    try {
      await deleteFile(file.id);
      removeFiles([file.id]);
      toast(`Deleted ${file.name}`, "success");
      announce(`Deleted ${file.name}.`);
    } catch (err) {
      // 404 means it is already gone (another tab); drop it quietly.
      if ((err as { status?: number }).status === 404) removeFiles([file.id]);
      else toast((err as Error).message, "error");
    }
    void refreshSummary();
  }, []);

  /** A tile's own Delete: afterwards, keep keyboard focus in the grid. */
  const removeFromTile = useCallback(
    async (file: ApiFile) => {
      const { order } = live.current;
      const i = order.indexOf(file.id);
      const neighbour = order[i + 1] ?? order[i - 1];
      await removeOne(file);
      const stillThere = filesStore.get().some((f) => f.id === file.id);
      const lost =
        !document.activeElement || document.activeElement === document.body;
      if (lost)
        requestAnimationFrame(() => focusId(stillThere ? file.id : neighbour));
    },
    [removeOne, focusId],
  );

  const selectedFiles = useMemo(
    () => files.filter((f) => selected.has(f.id)),
    [files, selected],
  );
  const selectedBytes = selectedFiles.reduce((n, f) => n + f.size, 0);

  const exitSelect = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const removeSelected = useCallback(async () => {
    const ids = selectedFiles.map((f) => f.id);
    try {
      const { deleted, missing } = await deleteFiles(ids);
      removeFiles([...deleted, ...missing]);
      const msg = `Deleted ${plural(deleted.length, "file", "files")}${missing.length ? ` (${missing.length} already gone)` : ""}`;
      toast(msg, "success");
      announce(msg);
      exitSelect();
      requestAnimationFrame(() => selectBtnRef.current?.focus());
    } catch (err) {
      toast((err as Error).message, "error");
    }
    void refreshSummary();
  }, [selectedFiles, exitSelect]);

  const copySelected = useCallback(async () => {
    const links = selectedFiles.map((f) => f.watchUrl ?? f.url);
    try {
      await navigator.clipboard.writeText(links.join("\n"));
      toast(`Copied ${plural(links.length, "link", "links")}`, "success");
    } catch {
      toast("Copy failed. Your browser blocked clipboard access.", "error");
    }
  }, [selectedFiles]);

  // ----- selection -----
  const pick = useCallback((id: string, range: boolean) => {
    const from = anchor.current;
    const { order } = live.current;
    setSelected((s) =>
      range ? rangeSelect(order, from, id, s) : toggleId(s, id),
    );
    anchor.current = id;
  }, []);

  const activate = useCallback(
    (id: string, e: MouseEvent | KeyboardEvent) => {
      if (!live.current.selecting) {
        open(id);
        return;
      }
      pick(id, e.shiftKey);
    },
    [open, pick],
  );

  // ----- keyboard -----
  const tileKeys = useCallback(
    (id: string, e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      const { order } = live.current;
      const i = order.indexOf(id);
      let to: number | null = null;
      if (e.key === "ArrowRight") to = i + 1;
      else if (e.key === "ArrowLeft") to = i - 1;
      else if (e.key === "ArrowDown") to = i + columns();
      else if (e.key === "ArrowUp") to = i - columns();
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = order.length - 1;
      if (to !== null) {
        e.preventDefault();
        if (to >= 0 && to < order.length) focusId(order[to]);
      } else if (e.key === "Enter") {
        e.preventDefault();
        activate(id, e);
      } else if (e.key === "x" || e.key === " ") {
        e.preventDefault();
        setSelecting(true);
        pick(id, e.shiftKey);
      }
    },
    [activate, pick, focusId],
  );

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === "/" && plain && !typing && !openId) {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "Escape" && selecting && !openId) {
        exitSelect();
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "a" &&
        selecting &&
        !typing
      ) {
        e.preventDefault();
        setSelected(new Set(order));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting, order, openId, exitSelect]);

  const mod =
    typeof navigator !== "undefined" &&
    /Mac|iP(hone|ad)/.test(navigator.userAgent)
      ? "⌘"
      : "Ctrl+";

  return (
    <RenderedAt.Provider value={mounted ? null : renderedAt}>
      <StorageStrip summary={summary} />
      {files.length === 0 ? (
        <main className="empty">
          <img src="/assets/mascot.png" alt="" width="128" height="128" />
          <h2>No files yet</h2>
          <p className="muted">
            Drop a file anywhere, paste, or press <strong>Upload</strong>.
            Uploads from <code>/upload</code> in Discord land here too.
          </p>
        </main>
      ) : (
        <main className={`gallery-main${selecting ? " selecting" : ""}`}>
          <div className="toolbar">
            <label className="toolbar-label" htmlFor="filter">
              Filter
            </label>
            <input
              ref={filterRef}
              className="toolbar-input"
              type="search"
              id="filter"
              placeholder="Filter by filename  ( / )"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="seg" role="radiogroup" aria-label="Kind">
              {(["all", "image", "video"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => setKind(k)}
                >
                  {k === "all" ? "All" : k === "image" ? "Img" : "Vid"}
                </button>
              ))}
            </div>
            <label className="toolbar-label" htmlFor="sort">
              Sort
            </label>
            <select
              className="toolbar-select"
              id="sort"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              {SORTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <button
              ref={selectBtnRef}
              type="button"
              className="button small"
              aria-pressed={selecting}
              onClick={() => (selecting ? exitSelect() : setSelecting(true))}
            >
              {selecting ? "Done" : "Select"}
            </button>
            <span className="toolbar-count">
              {visible.length} of {files.length}
            </span>
          </div>
          <div
            className="sheet"
            id="sheet"
            role="grid"
            aria-label="Your uploads"
            aria-multiselectable={selecting || undefined}
            ref={gridRef}
          >
            {visible.map((f) => (
              <FileTile
                key={f.id}
                file={f}
                selecting={selecting}
                selected={selected.has(f.id)}
                fresh={fresh.has(f.id)}
                onActivate={activate}
                onOpen={open}
                onDelete={removeFromTile}
                onKeyDown={tileKeys}
              />
            ))}
          </div>
          {visible.length === 0 && (
            <p className="sheet-empty">No files match that filter.</p>
          )}
          <p className="sheet-note">
            Oldest files are cleared as storage fills. Keep your own copy of
            anything that matters.
          </p>
        </main>
      )}

      {selecting && files.length > 0 && (
        <div className="select-bar panel" role="region" aria-label="Selection">
          <div className="select-bar-in">
            {selectedFiles.length === 0 ? (
              <>
                <span className="select-bar-count">0 selected</span>
                <span className="muted select-bar-hint">
                  Click tiles · Shift for a range · {mod}A for all
                </span>
              </>
            ) : (
              <>
                <span className="select-bar-count">
                  {selectedFiles.length} selected · {formatBytes(selectedBytes)}
                </span>
                <button
                  type="button"
                  className="button small"
                  onClick={copySelected}
                >
                  Copy links
                </button>
                <ArmButton
                  describe={plural(selectedFiles.length, "file", "files")}
                  onConfirm={removeSelected}
                />
              </>
            )}
            <button
              type="button"
              className="button small"
              aria-label="Cancel selection"
              onClick={exitSelect}
            >
              Esc
            </button>
          </div>
        </div>
      )}

      {openId && (
        <Lightbox
          files={visible}
          openId={openId}
          onClose={close}
          onNavigate={navigate}
          onDelete={removeOne}
        />
      )}
    </RenderedAt.Provider>
  );
}
