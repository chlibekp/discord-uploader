"use strict";

const body = document.body;
const sid = body.dataset.sid;
const expiresAt = Number(body.dataset.expiresAt);
const maxBytes = Number(body.dataset.maxBytes);

const ACCEPTED = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime",
]);

const drop = document.getElementById("drop");
const picker = document.getElementById("picker");
const preview = document.getElementById("preview");
const previewSlot = document.getElementById("preview-slot");
const filenameEl = document.getElementById("filename");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const statusEl = document.getElementById("status");
const sendButton = document.getElementById("send");
const countdown = document.getElementById("countdown");

let selected = null;
let dimensions = { width: 0, height: 0 };
let objectUrl = null;
let uploading = false;

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind ? `status ${kind}` : "status";
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Read intrinsic dimensions in the browser. The server has no ffmpeg, and
 * Discord will not render an inline player without og:video width and height.
 */
function readDimensions(file, url) {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith("video/");
    const element = document.createElement(isVideo ? "video" : "img");
    const done = () => {
      resolve(
        isVideo
          ? { width: element.videoWidth, height: element.videoHeight }
          : { width: element.naturalWidth, height: element.naturalHeight },
      );
    };
    if (isVideo) {
      element.preload = "metadata";
      element.muted = true;
      element.addEventListener("loadedmetadata", done, { once: true });
    } else {
      element.addEventListener("load", done, { once: true });
    }
    element.addEventListener("error", () => resolve({ width: 0, height: 0 }), { once: true });
    element.src = url;
  });
}

async function select(file) {
  if (uploading) return;

  if (!ACCEPTED.has(file.type)) {
    setStatus("Only images and videos are accepted.", "error");
    return;
  }
  if (file.size > maxBytes) {
    setStatus(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes)}.`, "error");
    return;
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  selected = file;

  const isVideo = file.type.startsWith("video/");
  previewSlot.replaceChildren();
  const element = document.createElement(isVideo ? "video" : "img");
  element.src = objectUrl;
  if (isVideo) {
    element.controls = true;
    element.muted = true;
  } else {
    element.alt = file.name;
  }
  previewSlot.appendChild(element);

  filenameEl.textContent = `${file.name} — ${formatBytes(file.size)}`;
  preview.hidden = false;
  sendButton.disabled = false;
  setStatus("");

  dimensions = await readDimensions(file, objectUrl);
}

function upload() {
  if (!selected || uploading) return;
  uploading = true;
  sendButton.disabled = true;
  progressWrap.hidden = false;
  setStatus("Uploading…");

  const form = new FormData();
  // Fields precede the file so the server has the dimensions before it finishes.
  form.append("width", String(dimensions.width || 0));
  form.append("height", String(dimensions.height || 0));
  form.append("file", selected, selected.name);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/u/${sid}/file`);

  xhr.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    progressBar.style.width = `${(event.loaded / event.total) * 100}%`;
  });

  xhr.addEventListener("load", () => {
    uploading = false;
    let payload = {};
    try {
      payload = JSON.parse(xhr.responseText);
    } catch {
      /* handled below by status code */
    }

    if (xhr.status >= 200 && xhr.status < 300) {
      progressBar.style.width = "100%";
      if (payload.posted) {
        setStatus("Uploaded and posted to Discord. You can close this tab.", "success");
      } else {
        statusEl.className = "status success";
        statusEl.replaceChildren(
          document.createTextNode("Uploaded, but the Discord message could not be posted. Link: "),
        );
        const link = document.createElement("a");
        link.href = payload.url || "#";
        link.textContent = payload.url || "";
        statusEl.appendChild(link);
      }
      drop.hidden = true;
      return;
    }

    sendButton.disabled = false;
    setStatus(payload.error || `Upload failed (${xhr.status}).`, "error");
  });

  xhr.addEventListener("error", () => {
    uploading = false;
    sendButton.disabled = false;
    setStatus("Network error during upload.", "error");
  });

  xhr.send(form);
}

drop.addEventListener("click", () => picker.click());
drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    picker.click();
  }
});

picker.addEventListener("change", () => {
  const file = picker.files && picker.files[0];
  if (file) select(file);
});

for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, () => drop.classList.remove("dragging"));
}
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (file) select(file);
});

sendButton.addEventListener("click", upload);

function tick() {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    countdown.textContent = "0:00";
    if (!uploading) {
      sendButton.disabled = true;
      setStatus("This link has expired. Run /upload in Discord again.", "error");
    }
    return;
  }
  const total = Math.floor(remaining / 1000);
  countdown.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  setTimeout(tick, 1000);
}
tick();
