# discord-uploader

A Discord bot with two commands, `/upload` and `/gallery`. It is **user-installable**, so it works in
any server, DM, or group DM you are in — the bot does not have to be a member there.

Running `/upload` replies privately with a link to a web upload page. You drop in an
image or video, and the bot posts it back into the channel you ran the command in:
images as an embed, videos as an inline player.

`/gallery` replies with another private link, this one showing a full-bleed contact
sheet of everything
you have uploaded, newest first, with a copy-link button on each tile. It lists only
your own files, never anyone else's.

The pages share one stylesheet and the assets in `public/brand/`. The mascot's palette
is where the interface colours come from, so replacing the sprite means revisiting the
custom properties at the top of `public/upload.css`.

Headings, labels and numbers are set in [Silkscreen](https://github.com/googlefonts/silkscreen),
a bitmap face bundled under the OFL (see `public/brand/SILKSCREEN-OFL.txt`). It is
served from this origin because the pages run under a CSP with `font-src 'self'`, and
it stays crisp only at 8, 12, 16 and 20px, so those are the only sizes used for it.
Filenames and body copy stay in the system sans, which is legible at any length.

Runs as a single Railway service with a Redis plugin and a mounted volume.

## How it works

```
Discord ──POST /interactions──► service ──create session──► Redis
   ▲                              │
   │  ephemeral reply + link      ▼
 you ───────────────────► GET /u/:sid   (upload page)
                                  │  POST /u/:sid/file  (streamed to /data)
                                  ▼
                          followup webhook ──► public message in channel
```

Each command mints a single-use session with a 128-bit random id. The link is
ephemeral, works once, and expires in 14 minutes. A session records which command
opened it, so an upload link cannot be spent on the gallery route or the reverse.

The gallery renders in full on the first request and spends its session doing it, so a
reload finds a dead link. Run `/gallery` again for a fresh one.

### The 14-minute limit

A user-installed command can run where the bot is not a member, so it cannot post to
the channel directly — the only channel-posting capability is the interaction followup
webhook, and its token dies **15 minutes** after the command. Sessions therefore live
14 minutes. If an upload finishes after that, the file is still stored and the page
shows you the permanent link; only the Discord message is skipped.

### Videos

Discord will not render a video from an arbitrary URL inside a custom embed. So a video
upload posts a bare link to `/v/:id`, an HTML page carrying `og:video` and
`twitter:player` tags, and Discord's own unfurl turns that into an inline player. The
page needs explicit width and height, which the browser measures from the file before
upload — no ffmpeg on the server.

## Setup

### 1. Discord application

In the [Developer Portal](https://discord.com/developers/applications):

1. Create an application. Copy the **Application ID** and **Public Key** from
   *General Information*.
2. Under *Bot*, copy the **token**. It is only used to register the command.
3. Under *Installation*, enable both **User Install** and **Guild Install**.
4. Under *General Information*, set **Interactions Endpoint URL** to
   `https://<your-domain>/interactions`. Discord verifies it with a signed PING, so
   deploy first, then save this.

Command registration happens **inside the service**: on every boot it does a
`PUT /applications/{id}/commands`, which is a full idempotent replace. There is no
separate registration script to run. Global commands can take up to an hour to appear.

### 2. Railway

1. Create a project from this repo. The `Dockerfile` and `railway.json` are picked up
   automatically.
2. Add the **Redis** plugin. It provides `REDIS_URL`.
3. Add a **Volume** mounted at `/data`.
4. Generate a public domain and set `PUBLIC_URL` to it — this cannot be inferred, and
   every link the bot posts depends on it.
5. Set the remaining variables from `.env.example`.

**Single replica only.** A Railway volume attaches to one instance; a second replica
would have a different disk and 404 on files the first one wrote. `railway.json` pins
`numReplicas: 1`.

## Environment

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DISCORD_APP_ID` | yes | | Application ID |
| `DISCORD_PUBLIC_KEY` | yes | | 64 hex chars; verifies interaction signatures |
| `DISCORD_BOT_TOKEN` | yes | | Registration only |
| `PUBLIC_URL` | yes | | No trailing slash |
| `REDIS_URL` | yes | | From the Redis plugin |
| `DATA_DIR` | no | `/data` | Volume mount path |
| `MAX_FILE_BYTES` | no | `2147483648` | 2 GB per file |
| `MAX_TOTAL_BYTES` | no | `4831838208` | 4.5 GB, ~10% under a 5 GB volume |
| `PORT` | no | `3000` | Set by Railway |

## Storage and eviction

Files live at `/data/{fileId}/{name}.{ext}`, one directory each. Redis holds the
metadata, a `files:lru` sorted set scored by last access, and a `user:{id}:files` set
per uploader that backs `/gallery`. The per-user sets are derived data and are rebuilt
from the file records at boot, so files stored before the gallery existed still show up.

After each upload, a sweep deletes least-recently-accessed files until total usage fits
`MAX_TOTAL_BYTES`. Files younger than 60 seconds are never evicted — otherwise an
upload larger than the remaining headroom would delete itself and hand you a dead link.
At boot, Redis and the volume are reconciled and the byte counter recomputed.

Set `MAX_TOTAL_BYTES` below your actual volume size. Going over the cap with nothing
evictable is logged and otherwise ignored; the disk filling up is not.

## Accepted files

PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, and QuickTime. The type is decided by the
file's leading bytes, and the stored extension comes from that — never from the
uploaded filename. A `.png` containing HTML is rejected, so nothing can be uploaded and
then served as script from this origin.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /interactions` | Discord webhook |
| `GET /u/:sid` | Upload page |
| `GET /g/:gid` | Gallery page, scoped to the invoker |
| `GET /assets/*` | Stylesheet, scripts and the mascot sprite |
| `POST /u/:sid/file` | Streaming upload |
| `GET /f/:id/:name` | Serves the file, with Range support |
| `GET /v/:id` | OG player page for videos |
| `GET /healthz` | Railway healthcheck |

## Development

```sh
pnpm install
cp .env.example .env      # fill it in; point PUBLIC_URL at a tunnel
pnpm dev
pnpm test
pnpm typecheck
```

Discord must reach `/interactions` over HTTPS, so local work needs a tunnel
(`cloudflared tunnel --url http://localhost:3000` or similar) with `PUBLIC_URL` set to
the tunnel's address.

Tests run against `ioredis-mock` and a temporary data directory, and drive the app
through `app.fetch()` with Discord calls stubbed. No network or Redis needed.

## Design

Full design notes: [`docs/superpowers/specs/2026-09-02-discord-uploader-design.md`](docs/superpowers/specs/2026-09-02-discord-uploader-design.md).
