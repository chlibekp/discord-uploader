# discord-uploader — Design

Date: 2026-09-02
Status: Approved

## Purpose

A Discord bot exposing a single `/upload` command. The command is available as a
**user-installed** app, so it works in any guild, DM, or group DM the invoker is in,
whether or not the bot is a member there.

Running `/upload` returns a private link to a web upload page. The user drops in an
image or video; the file is stored on the server's persistent disk; the bot then posts
a public message containing an embed (images) or an unfurled inline player (videos)
into the channel the command was run in.

## Non-goals

- General-purpose file hosting. Only images and videos are accepted.
- Transcoding, thumbnail generation, or any ffmpeg dependency.
- Multi-replica horizontal scaling. The design is explicitly single-instance.
- Per-user quotas, auth beyond the interaction, or an upload history UI.

## Runtime and infrastructure

Hosted on Railway as one service plus two attached resources.

| Piece           | Choice                     | Reason                                                                       |
| --------------- | -------------------------- | ---------------------------------------------------------------------------- |
| Runtime         | Node 22, TypeScript, ESM   | Current LTS; native `fetch`, `node:stream/promises`.                         |
| HTTP            | Hono + `@hono/node-server` | Small, Web-standard `Request`/`Response`, easy to test via `app.fetch()`.    |
| Sessions        | Railway Redis (`ioredis`)  | TTL keys and atomic single-use claim, which is what an upload session needs. |
| Files           | Railway Volume at `/data`  | Persistent across deploys.                                                   |
| Tests           | vitest                     | Fast, ESM-native.                                                            |
| Package manager | pnpm                       |                                                                              |

**Single replica is a hard constraint.** A Railway Volume attaches to exactly one
service instance. Two replicas would each see a different disk, and a file written by
one would 404 from the other. The Railway service is configured with
`numReplicas: 1`.

### Environment variables

| Name                 | Example                    | Notes                                                    |
| -------------------- | -------------------------- | -------------------------------------------------------- |
| `DISCORD_APP_ID`     | `123...`                   | Application id.                                          |
| `DISCORD_PUBLIC_KEY` | hex                        | Ed25519 key for interaction signature verification.      |
| `DISCORD_BOT_TOKEN`  | `Bot ...`                  | Used **only** for command registration.                  |
| `PUBLIC_URL`         | `https://x.up.railway.app` | No trailing slash. Used to build every user-facing link. |
| `REDIS_URL`          | `redis://...`              | From the Railway Redis plugin.                           |
| `DATA_DIR`           | `/data`                    | Volume mount path.                                       |
| `MAX_FILE_BYTES`     | `2147483648`               | 2 GB per file.                                           |
| `MAX_TOTAL_BYTES`    | `4831838208`               | 4.5 GB, ~10% under a 5 GB volume.                        |

All are required at boot except `DATA_DIR`, `MAX_FILE_BYTES`, and `MAX_TOTAL_BYTES`,
which have the defaults above. Startup validates the set and exits non-zero on a
missing variable rather than failing later at request time.

## The 15-minute constraint

This shapes the whole flow, so it is stated before the flow.

A user-installed command can be invoked in a channel where the bot is not a member. In
that situation the bot has no permission to `POST /channels/{channel_id}/messages` —
the request returns 403. The only channel-posting capability available is the
**interaction followup webhook**:

```
POST /webhooks/{application_id}/{interaction_token}
```

This webhook requires no bot permissions in the target channel, but the interaction
token it depends on **expires 15 minutes after the command is invoked**.

Consequences, all of which the implementation must honour:

- Upload session TTL is **14 minutes**, one minute inside the token's life.
- The upload page displays a live countdown to the session deadline.
- If an upload completes after the token has expired, the file is still stored and the
  page shows the permanent link, but no Discord message is posted. The page says so
  explicitly rather than silently succeeding.
- A followup may be non-ephemeral even when the initial interaction response was
  ephemeral. That is precisely how the private link turns into a public embed.

## Request flow

```
Discord ──POST /interactions──► server ──create session──► Redis
   ▲                              │
   │  ephemeral reply + link      ▼
 user ──────────────────► GET /u/:sid   (upload page)
                                  │  POST /u/:sid/file  (streamed to /data)
                                  ▼
                          followup webhook ──► public message in channel
```

## Routes

### `POST /interactions`

Discord's webhook endpoint.

1. Read the raw body as bytes **before** any parsing. Verify
   `X-Signature-Ed25519` / `X-Signature-Timestamp` against `DISCORD_PUBLIC_KEY`.
   Failure → `401` with no body. This check happens before anything else, including
   JSON parsing.
2. `type: 1` (PING) → `{ "type": 1 }`.
3. `type: 2` (APPLICATION_COMMAND), `data.name === "upload"`:
   - Generate a 128-bit random session id, base64url encoded.
   - Store the session in Redis (below) with a 14-minute TTL.
   - Respond `type: 4` with `flags: 64` (ephemeral), a short body, and an
     `ACTION_ROW` containing a link-style button to `${PUBLIC_URL}/u/{sid}`.
4. Anything else → `400`.

Discord requires a response within 3 seconds. The handler does one Redis write and
returns, so it is well inside that.

The channel id is read from `body.channel_id`, which is present in guild, DM, and
group-DM contexts alike. `guild_id` is stored when present but is only used for
logging.

#### Session record

Redis key `sess:{sid}`, a hash, TTL 840 seconds:

```
userId            invoker's user id (body.member?.user?.id ?? body.user.id)
channelId         body.channel_id
guildId           body.guild_id, or "" in DM contexts
interactionToken  body.token
createdAt         epoch ms
expiresAt         createdAt + 840_000
status            "pending" | "claimed"
```

Single-use is enforced by an atomic claim, not by a read-then-write. The upload
handler runs `HSETNX sess:{sid} status claimed`-style logic via a small Lua script that
checks `status == "pending"` and flips it in one step, returning the record. A second
concurrent upload to the same session loses the race and gets a 409.

### `GET /u/:sid`

The upload page. Looks up the session; if it is missing, expired, or already claimed,
returns `404` with a plain explanatory page. Otherwise returns the upload page HTML
with the session id and `expiresAt` inlined.

The page provides: a drop zone and file picker, a progress bar driven by
`XMLHttpRequest.upload.onprogress`, a countdown to `expiresAt`, and client-side
rejection of files over `MAX_FILE_BYTES` or outside the accepted MIME list, before any
bytes leave the browser.

Before uploading, the page loads the file into an `<img>` or `<video>` element to read
its intrinsic dimensions, and sends them as `width` / `height` fields ahead of the file
part. This exists because Discord will not unfurl an `og:video` without explicit
`width` and `height`, and the server has no ffmpeg to measure the file itself.
Dimensions are advisory: if they are absent or unparseable, the server falls back to
1280×720 for videos and omits them for images.

The page is served with a strict CSP (`default-src 'none'; img-src 'self' blob:;
media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'`) and
its assets are static files, not inline script.

### `POST /u/:sid/file`

Streaming multipart upload. `busboy` parses the stream; the file part is piped to disk
without ever being buffered whole in memory.

Order of operations:

1. Atomically claim the session. Not claimable → `404` (unknown/expired) or `409`
   (already used).
2. Reject on `Content-Length > MAX_FILE_BYTES` → `413`.
3. Generate a file id (128-bit random, base64url). Create `${DATA_DIR}/{id}/`.
4. Pipe the file part to `${DATA_DIR}/{id}/.part`, counting bytes as they pass. If the
   counter exceeds `MAX_FILE_BYTES`, destroy the stream, unlink the partial file,
   remove the directory, and return `413`. The counter is authoritative; a truthful
   `Content-Length` is not assumed.
5. Sniff the **first chunk** against the magic-byte allowlist. On no match, abort as
   above and return `415`.
6. On completion, rename `.part` to `{basename}.{ext}` where `ext` comes from the
   sniffed type and `basename` is the client filename stripped of its extension,
   slugified to `[a-zA-Z0-9._-]`, truncated to 64 chars, defaulting to `file`. The
   client's own extension is never used.
7. Write the file record to Redis and add it to the LRU set.
8. Run the eviction sweep.
9. Post the Discord followup. On failure, log it and continue — the file stays.
10. Delete the session key. Respond `200` with `{ url, posted: boolean }`.

If the session is claimed but the upload then fails, the session is not restored. The
user reruns `/upload`. This is deliberate: restoring it would reopen the
double-upload race the claim exists to close.

#### Accepted types

| Sniffed type      | Ext  | Kind  |
| ----------------- | ---- | ----- |
| `image/png`       | png  | image |
| `image/jpeg`      | jpg  | image |
| `image/gif`       | gif  | image |
| `image/webp`      | webp | image |
| `image/avif`      | avif | image |
| `video/mp4`       | mp4  | video |
| `video/webm`      | webm | video |
| `video/quicktime` | mov  | video |

Detection is by leading bytes: PNG signature; JPEG `FF D8 FF`; GIF `GIF87a`/`GIF89a`;
RIFF container with `WEBP` at offset 8; ISO-BMFF `ftyp` at offset 4 with a brand
distinguishing `avif` / `mp4` / `qt` ; EBML `1A 45 DF A3` for WebM.

### `GET /f/:id/:name`

Serves a stored file.

- Looks up `file:{id}`; missing → `404`.
- `:name` must equal the stored filename, else `404`. Neither `:id` nor `:name` is
  ever joined into a path from user input — the path comes from the Redis record.
- Sets `Content-Type` from the stored sniffed type, `Content-Disposition: inline`,
  `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options:
nosniff`, and `Accept-Ranges: bytes`.
- Honours a single-range `Range` header with `206` and a correct `Content-Range`;
  unsatisfiable ranges get `416`. Range support is required for video seeking in the
  Discord player.
- Updates the LRU score to now. This write is fire-and-forget: a Redis failure must
  not break file delivery.

### `GET /v/:id`

The OG landing page for videos, and the URL the bot posts for a video upload. It
returns a minimal HTML document carrying:

```html
<meta property="og:type" content="video.other" />
<meta property="og:video" content="{PUBLIC_URL}/f/{id}/{name}" />
<meta property="og:video:secure_url" content="{PUBLIC_URL}/f/{id}/{name}" />
<meta property="og:video:type" content="{mime}" />
<meta property="og:video:width" content="{width}" />
<meta property="og:video:height" content="{height}" />
<meta name="twitter:card" content="player" />
<meta name="twitter:player:stream" content="{PUBLIC_URL}/f/{id}/{name}" />
```

The visible body is a `<video controls>` pointing at the same file, so a human opening
the link gets a working player.

Requesting `/v/:id` for a file whose kind is `image` redirects `302` to
`/f/:id/:name`.

### `GET /healthz`

Returns `200 {"ok":true}` when Redis responds to `PING` and `DATA_DIR` is writable;
`503` otherwise. Configured as the Railway healthcheck path.

## Posting to Discord

Sent as `POST /webhooks/{DISCORD_APP_ID}/{interactionToken}` with no auth header —
the token in the path is the credential.

**Image:**

```json
{
  "embeds": [
    {
      "description": "<@{userId}> uploaded an image",
      "image": { "url": "{PUBLIC_URL}/f/{id}/{name}" },
      "color": 5793266
    }
  ]
}
```

**Video:** a plain `content` of `` `<@{userId}> uploaded a video` `` followed by the
`{PUBLIC_URL}/v/{id}` link. Videos deliberately do **not** use an embed object: a
custom embed suppresses Discord's own URL unfurl, and the unfurl is the thing that
produces the inline player.

`allowed_mentions` is set to `{ "parse": [] }` so the `<@id>` renders as a name
without pinging.

## Storage layout and LRU eviction

```
/data/
  {fileId}/
    {name}.{ext}
```

One directory per file so that eviction is a single `rm -rf` of a directory whose name
is a generated id, never a user-controlled path.

Redis holds two structures:

- `file:{id}` — hash: `name`, `ext`, `mime`, `kind`, `size`, `width`, `height`,
  `createdAt`, `userId`, `channelId`. No TTL.
- `files:lru` — sorted set, member `{id}`, score last-access epoch ms.

A `total:bytes` counter key is maintained alongside, incremented on store and
decremented on eviction, so the sweep does not have to sum the whole set each time. It
is recomputed from the file records at boot.

**Sweep** runs after each successful upload. While `total:bytes > MAX_TOTAL_BYTES`,
take the lowest-scored member of `files:lru`, delete its directory, delete `file:{id}`,
remove it from the set, and decrement the counter. Never evict a file created in the
last 60 seconds — that guards against a single upload larger than the remaining
headroom immediately deleting itself. If the set empties and the total is still over,
log an error and stop.

**Boot reconciliation** walks `DATA_DIR`, removes directories with no matching
`file:{id}`, removes records whose directory is gone, and recomputes `total:bytes`.

## Command registration

Runs once at boot, after config validation and before the server begins listening.

```
PUT https://discord.com/api/v10/applications/{DISCORD_APP_ID}/commands
Authorization: Bot {DISCORD_BOT_TOKEN}
```

```json
[
  {
    "name": "upload",
    "description": "Upload an image or video",
    "type": 1,
    "integration_types": [0, 1],
    "contexts": [0, 1, 2]
  }
]
```

`integration_types: [0, 1]` = guild install and user install. `contexts: [0, 1, 2]` =
guild, bot DM, and private channel (DMs and group DMs). Together these make the command
available anywhere the invoker is, which is the user-installable requirement.

`PUT` is a full replace and is idempotent, so running it every deploy is safe. A
failure is logged as an error but does **not** prevent startup — an already-registered
command keeps working, and refusing to boot over a transient Discord 5xx would be worse
than the alternative. Discord may take up to an hour to propagate global command
changes.

## Error handling

| Condition                                   | Response                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| Bad/missing interaction signature           | `401`, empty body                                          |
| Unknown interaction type                    | `400`                                                      |
| Session missing or expired                  | `404` page or JSON                                         |
| Session already claimed                     | `409`                                                      |
| `Content-Length` or streamed bytes over cap | `413`, partial file removed                                |
| Disallowed file type                        | `415`, partial file removed                                |
| Redis unreachable during `/interactions`    | `503`                                                      |
| Redis unreachable at boot                   | log and exit non-zero; Railway restarts                    |
| Followup post fails                         | file kept, `200` with `posted: false`, page shows the link |
| Disk write fails mid-upload                 | `500`, partial file removed                                |

Nothing in an error response echoes a client-supplied filename or path.

## Security

- Ed25519 verification on the raw body precedes all other interaction handling.
- Session ids and file ids are 128-bit CSPRNG values, so the ephemeral link is not
  guessable and no further authorization check is needed on `/u/:sid`.
- The stored extension always comes from magic-byte sniffing, so an attacker cannot
  upload HTML or SVG and get it served as such from our origin. `nosniff` is set on
  every file response.
- Filesystem paths are built exclusively from generated ids. Client filenames are
  slugified and used only for the display portion of the URL, and are compared against
  the stored value rather than trusted.
- `DISCORD_BOT_TOKEN` is used only for registration; the request path never touches it.
- Rate limiting is not implemented. The attack surface is one ephemeral single-use link
  per `/upload`, and Discord rate-limits the command itself.

## Testing

vitest, with `ioredis-mock` and a per-test temporary `DATA_DIR`. Integration tests
drive `app.fetch()` directly rather than binding a port, and stub global `fetch` for
Discord calls.

Unit:

- Ed25519 verification: valid, tampered body, wrong timestamp, missing headers.
- Magic-byte sniffing: one fixture per accepted type, plus rejection of HTML, SVG,
  ZIP, and a file whose extension lies about its content.
- Filename slugification, including traversal attempts and unicode.
- `Range` header parsing: open-ended, closed, suffix, unsatisfiable, malformed.
- LRU eviction arithmetic, including the 60-second protection window and the
  empty-set-still-over case.
- Config validation: each missing required variable exits.

Integration:

- PING → PONG.
- `/upload` → ephemeral reply shape, session written with correct TTL and channel id.
- Full path: command → `GET /u/:sid` 200 → upload → file on disk → correct followup
  body → session gone → `GET /u/:sid` now 404.
- Image and video each produce their respective followup payload shape.
- Concurrent double upload on one session: one 200, one 409.
- Oversized upload: 413 and no file left on disk.
- Expired token: file stored, `posted: false`.
- `GET /f` returns correct headers, and a range request returns 206 with the right
  bytes.
- Eviction: fill past `MAX_TOTAL_BYTES`, assert the oldest-accessed file is gone from
  both disk and Redis.

## Repository layout

```
src/
  index.ts            boot: config, redis, reconcile, register, listen
  config.ts           env parsing and validation
  redis.ts            client + Lua claim script
  discord/
    verify.ts         Ed25519
    register.ts       PUT commands
    followup.ts       webhook post + payload builders
  routes/
    interactions.ts
    upload.ts         GET /u/:sid, POST /u/:sid/file
    files.ts          GET /f/:id/:name, GET /v/:id
    health.ts
  storage/
    store.ts          write, record, delete
    lru.ts            sweep + reconcile
    sniff.ts          magic bytes
  http/range.ts
public/
  upload.html upload.js upload.css
test/
Dockerfile
railway.json
```

## Deployment

Dockerfile on Node 22 slim, pnpm, multi-stage, non-root user. `railway.json` sets the
healthcheck path to `/healthz`, `numReplicas: 1`, and restart-on-failure. The volume is
mounted at `/data`; the Redis plugin supplies `REDIS_URL`. `PUBLIC_URL` must be set by
hand to the service's public domain — it cannot be inferred, and every link the bot
posts depends on it being right.
