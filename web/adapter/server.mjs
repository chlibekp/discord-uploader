import { createApp } from "astro/app/entrypoint";

const app = createApp();

/**
 * Returns null when no Astro route matches, so Hono can answer with its own 404.
 * @param {Request} request
 * @param {Record<string, unknown>} locals
 */
export async function render(request, locals) {
  const route = app.match(request);
  if (!route) return null;
  return app.render(request, { routeData: route, locals });
}
