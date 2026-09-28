/**
 * Minimal adapter: the build emits a server entry exporting
 * `render(request, locals)`, which Hono mounts. No HTTP server of its own.
 */
export default function honoAdapter() {
  return {
    name: "hono-fetch-adapter",
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name: "hono-fetch-adapter",
          entrypointResolution: "auto",
          serverEntrypoint: new URL("./server.mjs", import.meta.url),
          supportedAstroFeatures: {
            serverOutput: "stable",
            staticOutput: "unsupported",
            hybridOutput: "unsupported",
            sharpImageService: "unsupported",
            envGetSecret: "unsupported",
            i18nDomains: "unsupported",
          },
        });
      },
    },
  };
}
