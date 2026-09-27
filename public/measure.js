/**
 * Read intrinsic dimensions in the browser. The server has no ffmpeg, and
 * Discord will not render an inline player without og:video width and height.
 * Shared by the single-use upload page and the dashboard upload tray.
 */
export function readDimensions(file, url) {
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
    element.addEventListener("error", () => resolve({ width: 0, height: 0 }), {
      once: true,
    });
    element.src = url;
  });
}
