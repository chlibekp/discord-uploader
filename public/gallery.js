"use strict";

/**
 * Each tile carries its permanent URL in a data attribute, so the page needs no
 * inlined script and the strict CSP still applies.
 */
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;

  const url = button.dataset.copy;
  const original = button.textContent;

  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "Copied";
    button.classList.add("copied");
  } catch {
    // Clipboard access is refused outside a secure context or without focus.
    button.textContent = "Press Ctrl+C";
    const field = document.createElement("input");
    field.value = url;
    field.className = "copy-fallback";
    button.after(field);
    field.select();
    setTimeout(() => field.remove(), 4000);
  }

  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
  }, 1600);
});
