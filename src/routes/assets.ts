import { Hono } from "hono";
import { assets } from "../assets.js";

const SCRIPT = "text/javascript; charset=utf-8";
const NO_CACHE = "no-cache";
/** Brand art is content-stable, so it can be cached hard. */
const IMMUTABLE = "public, max-age=604800";

/** Every static asset the pages reference, in one place. */
export function assetRoutes(): Hono {
  const app = new Hono();

  app.get("/assets/upload.css", (c) =>
    c.body(assets.uploadCss, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": NO_CACHE }),
  );
  app.get("/assets/upload.js", (c) =>
    c.body(assets.uploadJs, 200, { "Content-Type": SCRIPT, "Cache-Control": NO_CACHE }),
  );
  app.get("/assets/gallery.js", (c) =>
    c.body(assets.galleryJs, 200, { "Content-Type": SCRIPT, "Cache-Control": NO_CACHE }),
  );
  app.get("/assets/gallery-filters.js", (c) =>
    c.body(assets.galleryFiltersJs, 200, { "Content-Type": SCRIPT, "Cache-Control": NO_CACHE }),
  );

  for (const [route, body] of [
    ["/assets/silkscreen-400.woff2", assets.fontRegular],
    ["/assets/silkscreen-700.woff2", assets.fontBold],
  ] as const) {
    app.get(route, (c) =>
      c.body(new Uint8Array(body), 200, { "Content-Type": "font/woff2", "Cache-Control": IMMUTABLE }),
    );
  }

  for (const [route, body] of [
    ["/assets/mascot.png", assets.mascot],
    ["/assets/mascot-small.png", assets.mascotSmall],
    ["/favicon.ico", assets.mascotSmall],
  ] as const) {
    app.get(route, (c) =>
      c.body(new Uint8Array(body), 200, { "Content-Type": "image/png", "Cache-Control": IMMUTABLE }),
    );
  }

  return app;
}
