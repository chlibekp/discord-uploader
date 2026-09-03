"use strict";

import { filterRecords, formatRemaining, sortRecords } from "./gallery-filters.js";

const token = document.body.dataset.token;

const sheetEl = document.querySelector("#sheet");
const filterInput = document.querySelector("#filter");
const sortSelect = document.querySelector("#sort");
const countEl = document.querySelector("#filterCount");
const emptyEl = document.querySelector("#sheetEmpty");
const liveRegion = document.querySelector("#liveRegion");

/**
 * Each tile carries its own URL and id in data attributes, so the page needs no
 * inlined script and the strict CSP still applies.
 */
document.addEventListener("click", (event) => {
  const copy = event.target.closest("[data-copy]");
  if (copy) return copyLink(copy);

  const remove = event.target.closest("[data-delete]");
  if (remove) return confirmDelete(remove);
});

async function copyLink(button) {
  const url = button.dataset.copy;
  const original = button.textContent;

  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "Copied";
    button.classList.add("copied");
  } catch {
    // Clipboard access is refused outside a secure context or without focus.
    button.textContent = "Select";
    const field = document.createElement("input");
    field.value = url;
    field.className = "copy-fallback";
    button.closest(".tile-actions").after(field);
    field.select();
    setTimeout(() => field.remove(), 6000);
  }

  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
  }, 1600);
}

/**
 * Deleting is not reversible, so the first click only arms the button. It
 * disarms itself after a few seconds, or as soon as another one is armed.
 * The armed state is announced through the aria-live region so it is not a
 * silent visual-only change for screen reader users.
 */
function confirmDelete(button) {
  if (button.dataset.armed !== "true") {
    disarmAll();
    button.dataset.armed = "true";
    button.textContent = "Delete?";
    button.classList.add("armed");
    button.dataset.timer = String(setTimeout(() => disarm(button), 4000));
    announce(`Press delete again to remove ${tileNameFor(button)}. This cannot be undone.`);
    return;
  }

  disarm(button);
  runDelete(button);
}

function disarm(button) {
  clearTimeout(Number(button.dataset.timer));
  delete button.dataset.armed;
  button.classList.remove("armed");
  button.textContent = "Delete";
}

function disarmAll() {
  document.querySelectorAll('[data-delete][data-armed="true"]').forEach(disarm);
}

function tileNameFor(button) {
  return button.dataset.name || button.closest("[data-tile]")?.dataset.name || "this file";
}

async function runDelete(button) {
  const tile = button.closest(".tile");
  button.disabled = true;
  button.textContent = "…";

  try {
    const res = await fetch(`/api/files/${encodeURIComponent(button.dataset.delete)}`, {
      method: "DELETE",
      headers: { "X-Action-Token": token },
    });

    if (res.status === 204) {
      const name = tileNameFor(button);
      tile.remove();
      recount();
      applyFilters();
      announce(`Deleted ${name}.`);
      return;
    }

    const payload = await res.json().catch(() => ({}));
    fail(button, payload.error || `Could not delete (${res.status}).`);
  } catch {
    fail(button, "Network error. Nothing was deleted.");
  }
}

function fail(button, message) {
  button.disabled = false;
  button.textContent = "Delete";

  const note = document.querySelector(".sheet-note");
  if (note) {
    note.textContent = message;
    note.classList.add("error");
  }
  announce(message);
}

function announce(message) {
  if (liveRegion) liveRegion.textContent = message;
}

/** Keep the header honest after a tile disappears. */
function recount() {
  const tiles = document.querySelectorAll(".tile");
  const count = document.querySelector(".count");
  if (count) count.textContent = `${tiles.length} ${tiles.length === 1 ? "file" : "files"}`;

  if (tiles.length === 0) {
    const main = document.querySelector(".gallery-main");
    if (main) {
      main.innerHTML =
        '<img src="/assets/mascot.png" alt="" width="160" height="160">' +
        "<h2>No files yet</h2>" +
        '<p class="muted">Run <code>/upload</code> in Discord and whatever you send lands here.</p>';
      main.className = "empty";
    }
    const sub = document.querySelector(".bar-sub");
    if (sub) sub.textContent = "Nothing stored yet";
    if (count) count.textContent = "";
  }
}

// ---------- Filter + sort ----------

function readRecords() {
  return Array.from(document.querySelectorAll("[data-tile]")).map((el) => ({
    el,
    id: el.dataset.id,
    name: el.dataset.name,
    size: Number(el.dataset.size),
    createdAt: Number(el.dataset.created),
    expiresAt: Number(el.dataset.expires),
  }));
}

function applyFilters() {
  if (!sheetEl) return;
  const records = readRecords();
  const query = filterInput ? filterInput.value : "";
  const mode = sortSelect ? sortSelect.value : "newest";

  const matched = filterRecords(records, query);
  const matchedIds = new Set(matched.map((r) => r.id));

  for (const record of records) {
    record.el.hidden = !matchedIds.has(record.id);
  }

  const ordered = sortRecords(matched, mode);
  for (const record of ordered) sheetEl.appendChild(record.el);

  if (countEl) countEl.textContent = `${matched.length} of ${records.length}`;
  if (emptyEl) emptyEl.hidden = records.length === 0 || matched.length > 0;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

if (filterInput) filterInput.addEventListener("input", debounce(applyFilters, 150));
if (sortSelect) sortSelect.addEventListener("change", applyFilters);
applyFilters();

// ---------- Live-ticking remaining lifetime ----------

function tickExpiries() {
  for (const el of document.querySelectorAll("[data-tile]")) {
    const expiry = el.querySelector("[data-expiry]");
    if (expiry) expiry.textContent = formatRemaining(Number(el.dataset.expires));
  }
}

tickExpiries();
setInterval(tickExpiries, 1000);

// ---------- Keyboard navigation ----------

function visibleTiles() {
  return Array.from(document.querySelectorAll("[data-tile]")).filter((el) => !el.hidden);
}

function columnCount() {
  if (!sheetEl || sheetEl.children.length === 0) return 1;
  const first = sheetEl.querySelector("[data-tile]:not([hidden])");
  if (!first) return 1;
  const rowTop = first.getBoundingClientRect().top;
  let count = 0;
  for (const el of visibleTiles()) {
    if (Math.abs(el.getBoundingClientRect().top - rowTop) < 1) count += 1;
    else break;
  }
  return count || 1;
}

if (sheetEl) {
  sheetEl.addEventListener("keydown", (event) => {
    const tile = event.target.closest("[data-tile]");
    if (!tile) return;

    const tiles = visibleTiles();
    const index = tiles.indexOf(tile);
    if (index === -1) return;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusTile(tiles, index + 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        focusTile(tiles, index - 1);
        return;
      case "ArrowDown":
        event.preventDefault();
        focusTile(tiles, index + columnCount());
        return;
      case "ArrowUp":
        event.preventDefault();
        focusTile(tiles, index - columnCount());
        return;
      case "Enter": {
        event.preventDefault();
        const href = tile.dataset.href;
        if (href) window.open(href, "_blank", "noopener");
        return;
      }
      case "c":
      case "C": {
        event.preventDefault();
        const copyButton = tile.querySelector("[data-copy]");
        if (copyButton) copyLink(copyButton);
        return;
      }
      case "Delete":
      case "Backspace": {
        event.preventDefault();
        const deleteButton = tile.querySelector("[data-delete]");
        if (deleteButton) confirmDelete(deleteButton);
        return;
      }
      default:
        return;
    }
  });
}

function focusTile(tiles, index) {
  if (index < 0 || index >= tiles.length) return;
  tiles[index].focus();
}
