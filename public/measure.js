/**
 * Read intrinsic dimensions in the browser. The server has no ffmpeg, and
 * Discord will not render an inline player without og:video width and height.
 * Shared by the single-use upload page and the dashboard upload tray.
 *
 * Always settles: a media element that never fires load, loadedmetadata or
 * error (a background tab deferring media, a codec the browser can't parse)
 * gives up after `timeoutMs`, and aborting `signal` gives up at once. Giving
 * up resolves 0×0, which the server replaces with its own fallback.
 */
export function readDimensions(file, url, { timeoutMs = 8000, signal } = {}) {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith("video/");
    const element = document.createElement(isVideo ? "video" : "img");
    let timer;
    const settle = (dims) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", giveUp);
      // Let go of the file: a video element otherwise keeps its decoder and
      // the blob it points at alive.
      element.removeAttribute("src");
      if (isVideo) element.load();
      resolve(dims);
    };
    const giveUp = () => settle({ width: 0, height: 0 });
    const done = () =>
      settle(
        isVideo
          ? { width: element.videoWidth, height: element.videoHeight }
          : { width: element.naturalWidth, height: element.naturalHeight },
      );
    if (signal?.aborted) {
      resolve({ width: 0, height: 0 });
      return;
    }
    if (isVideo) {
      element.preload = "metadata";
      element.muted = true;
      element.addEventListener("loadedmetadata", done, { once: true });
    } else {
      element.addEventListener("load", done, { once: true });
    }
    element.addEventListener("error", giveUp, { once: true });
    signal?.addEventListener("abort", giveUp, { once: true });
    timer = setTimeout(giveUp, timeoutMs);
    element.src = url;
  });
}
