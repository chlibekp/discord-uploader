import { defineConfig, passthroughImageService } from "astro/config";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import honoAdapter from "./adapter/index.mjs";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  srcDir: "./src",
  publicDir: "./public",
  outDir: "./dist",
  output: "server",
  adapter: honoAdapter(),
  integrations: [react()],
  trailingSlash: "ignore",
  build: {
    client: "./client",
    server: "./server",
    serverEntry: "entry.mjs",
    assets: "_astro",
    // No inline <style>: keeps style hashes out of the CSP so 'unsafe-inline'
    // (needed by Motion's style attributes) stays effective on the dashboard.
    inlineStylesheets: "never",
  },
  // The adapter declares sharp unsupported and no page uses astro:assets
  // optimisation; without this, every build logs a spurious sharp error.
  image: { service: passthroughImageService() },
  devToolbar: { enabled: false },
  vite: {
    resolve: {
      alias: { "@server": fileURLToPath(new URL("../src", import.meta.url)) },
    },
    ssr: { external: ["ioredis", "busboy"] },
  },
});
