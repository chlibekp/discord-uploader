"use strict";

const token = document.body.dataset.token;

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
 */
function confirmDelete(button) {
  if (button.dataset.armed !== "true") {
    disarmAll();
    button.dataset.armed = "true";
    button.textContent = "Delete?";
    button.classList.add("armed");
    button.dataset.timer = String(setTimeout(() => disarm(button), 4000));
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
      tile.remove();
      recount();
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
}

/** Keep the header honest after a tile disappears. */
function recount() {
  const tiles = document.querySelectorAll(".tile");
  const count = document.querySelector(".count");
  if (count) count.textContent = `${tiles.length} ${tiles.length === 1 ? "file" : "files"}`;

  if (tiles.length === 0) {
    const sheet = document.querySelector(".sheet");
    if (sheet) {
      sheet.className = "empty";
      sheet.innerHTML =
        '<img src="/assets/mascot.png" alt="" width="160" height="160">' +
        "<h2>No files yet</h2>" +
        '<p class="muted">Run <code>/upload</code> in Discord and whatever you send lands here.</p>';
    }
    const sub = document.querySelector(".bar-sub");
    if (sub) sub.textContent = "Nothing stored yet";
    if (count) count.textContent = "";
  }
}
