import { Readable } from "node:stream";
import type { Context } from "hono";
import type { IncomingMessage } from "node:http";

/**
 * The raw Node request stream, so busboy can consume upload bytes without them
 * ever being buffered whole.
 *
 * Under @hono/node-server the original IncomingMessage is on `c.env.incoming`.
 * In tests the app is driven through `app.fetch()`, where only the Web stream
 * exists, so that path converts instead.
 */
export function requestNodeStream(c: Context): Readable {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)
    ?.incoming;
  if (incoming && typeof incoming.pipe === "function") return incoming;

  const body = c.req.raw.body;
  if (!body) return Readable.from([]);
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}
