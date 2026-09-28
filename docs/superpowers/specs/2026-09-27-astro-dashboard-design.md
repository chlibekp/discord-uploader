# Astro pages, Discord sign-in and user dashboard — design

Date: 2026-09-27
Branch: `feat/astro-dashboard` (from `main` @ 720e25a)

## Goal

1. Rewrite every HTML page the service serves in [Astro](https://astro.build), with no
   visible change.
2. Add Discord sign-in (OAuth2) with persistent sessions.
3. Add a signed-in dashboard: a gallery, uploading, and per-user usage figures drawn with
   [dither-kit](https://www.tripwire.sh/dither-kit).

## Decisions already made

| Topic                 | Decision                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slash commands        | `/upload` and `/gallery` keep their single-use ephemeral links, unchanged. Their replies gain an "Open dashboard" link button. Only the `/upload` link can post into a channel, because only it carries an interaction token. |
| Dashboard uploads     | Stored and linked, never posted to Discord.                                                                                                                                                                                   |
| Usage shown           | Storage vs quota (images/videos split); uploads and bytes per day over 7/30/90 days; rate-limit headroom; per-command breakdown.                                                                                              |
| Gallery/upload extras | Multi-file upload queue; drop-anywhere and paste; lightbox; bulk select and delete. **Not** in scope: changing the expiry of an existing file.                                                                                |
| Architecture          | Astro SSR mounted inside the existing Hono server through a small fetch-native adapter (section 1). Hono keeps every API, interaction, file-serving and streaming route.                                                      |
| Database              | Redis stays the only database. A reconciliation guard (below) protects files if Redis ever comes back empty.                                                                                                                  |
| Look                  | Existing pages stay pixel-identical. The dashboard uses the same visual language: `upload.css` tokens, Silkscreen at 8/12/16/20px only, notched corners, 8px grid, mascot palette.                                            |

## 1. Structure and migration

```
src/                          Hono server
  web/mount.ts                mounts the Astro handler as Hono's fallback, passes locals
  auth/                       OAuth, sessions, middleware (section 2)
  storage/ingest.ts           shared upload pipeline (section 3)
  routes/me.ts                /api/me/* (section 3)
web/                          Astro project root (astro.config.mjs)
  adapter/                    in-repo Astro adapter: fetch-native server entry
  src/layouts/Shell.astro     replaces pages.ts shell()
  src/components/BrandBar.astro  replaces brandBar()
  src/components/Expired.astro   replaces expiredShell(); rendered by /u and /g
  src/pages/u/[sid].astro     upload page
  src/pages/g/[gid].astro     single-use gallery
  src/pages/v/[id].astro      video watch page
  src/pages/login.astro
  src/pages/dashboard/index.astro   Files tab
  src/pages/dashboard/usage.astro   Usage tab
  src/islands/*.tsx           React islands
  src/lib/*.ts                pure, unit-tested client logic
  src/components/ui/dither/*  dither-kit source (shadcn-style copy, committed)
  src/styles/upload.css       moved from public/; still the single source of the look
public/brand/*                unchanged
```

### Mounting

- `@astrojs/node` is **not** used: its middleware mode takes Node `(req, res)`, which
  breaks Hono's `app.fetch(Request)`, and the whole test suite drives the app that way.
- Instead `web/adapter/` is a minimal Astro adapter (`serverEntrypoint` +
  `createExports(manifest)`) whose built entry, `web/dist/server/entry.mjs`, exports
  `render(request: Request, locals): Promise<Response>`, implemented with
  `new App(manifest).render(request, { locals })` from `astro/app`.
- `web/mount.ts` imports that entry and registers `app.all("*", …)` as the last Hono
  route, so every route Hono already owns keeps priority and tests keep calling
  `app.fetch`.
- Hono passes `locals = { redis, config, fetch, user }` into Astro. `user` is the signed-in
  user or `null` (section 2). Page frontmatter calls the existing `storage/*` functions
  directly with these locals. There is no HTTP round-trip from page to API.
- The built client assets are served by Hono from `web/dist/client` under `/_astro/*`,
  hashed filenames, `Cache-Control: public, max-age=31536000, immutable`.
- `/assets/*` URLs used by the legacy pages keep working from the existing `assetRoutes`.

### Migrating the legacy pages

- Markup is copied verbatim: same elements, classes, ids, data attributes and asset URLs.
- `upload.js`, `gallery.js` and `gallery-filters.js` stay vanilla JS. They keep being
  served from `/assets/*` so their behaviour and tests are unchanged.
- Server logic moves from the Hono handlers into page frontmatter, calling the same
  functions:
  - `/u/:sid` — `getSession`, kind check, render or the expired page (404).
  - `/g/:gid` — `claimSession`, kind check, `expireDue`, `listUserFiles`,
    `createActionToken`, render tiles or the expired page (404).
  - `/v/:id` — `getRecord`; image records `302` to `/f/:id/:name`; otherwise render the
    `og:video` / `twitter:player` tags and the `<video>` body server-side.
- Status codes and headers (`Cache-Control: no-store` etc.) stay exactly as today.
- `src/pages.ts` and the HTML string builders in `routes/gallery.ts`,
  `routes/upload.ts` and `routes/files.ts` are removed once the Astro pages replace them.
  `/u/:sid/file`, `/api/files/:id`, `/f/*` and the rest of the Hono routes are unchanged.

### CSP

- Legacy pages keep today's `UPLOAD_PAGE_CSP` exactly. They emit no inline script.
- Dashboard and login pages use Astro's built-in CSP support (`csp` config; experimental
  or stable depending on the installed Astro version), which emits a policy containing the
  hash of every inline script Astro generates (the island bootstrap). `script-src` stays
  `'self'` plus those hashes. Hono does not set a competing CSP header on these routes.
- Dashboard pages add `style-src 'unsafe-inline'` (Motion animates through inline styles)
  and `img-src https://cdn.discordapp.com` (avatars). Nothing else is loosened.

### Build and dev

- `pnpm build` runs `astro build` then `tsc`.
- `pnpm test` runs `astro build` first (`pretest`), since page tests go through the built
  entry. Vitest itself is unchanged.
- `pnpm dev` runs `tsx watch src/index.ts` alongside a watcher that re-runs `astro build`
  when `web/src` changes (a few seconds per rebuild, no HMR). This is the accepted cost of
  rendering through Hono in every mode instead of maintaining a second dev-only path.
- `__Host-` cookies need `Secure`; Chromium and Firefox accept that on
  `http://localhost`, so local sign-in works there. Safari does not.
- `Dockerfile` copies `web/dist` into the runtime image alongside `dist`.
- React, `@astrojs/react`, Tailwind v4 (preflight disabled, used only inside dither-kit
  and dashboard components), Motion and D3 are added. `upload.css` remains the base
  stylesheet everywhere.

### Reconciliation guard

`reconcile()` deletes directories on `/data` that have no `file:{id}` record. If Redis
returns zero file records while `/data` holds one or more file directories, it logs an
error and **skips all directory deletion** for that boot. Record cleanup (records whose
directory is gone) still runs. This prevents a wiped Redis from deleting every upload.

## 2. Discord sign-in

### Configuration

- New optional env var `DISCORD_CLIENT_SECRET`. When unset, the bot runs as today and
  `/login` explains that sign-in is not configured. `/dashboard*` redirects to `/login`.
- The OAuth redirect URI `{PUBLIC_URL}/auth/callback` must be registered in the
  Developer Portal (documented in the README).
- No signing secret is needed: session tokens are random and stored hashed.

### Routes (Hono)

**`GET /auth/login?next=/dashboard`**

1. `next` is accepted only when it is a path starting with a single `/` (not `//`, not a
   scheme); anything else becomes `/dashboard`.
2. Mint `state` = 16 random bytes, base64url. Store `oauth:state:{state}` → `next`, TTL
   600s. Set cookie `__Host-oauth_state={state}; HttpOnly; Secure; SameSite=Lax; Path=/;
Max-Age=600`.
3. `302` to `https://discord.com/oauth2/authorize?client_id={DISCORD_APP_ID}&response_type=code&scope=identify&redirect_uri={PUBLIC_URL}/auth/callback&state={state}`.

If the request already carries a valid session, it redirects straight to `next`.

**`GET /auth/callback?code&state`** (or `?error=access_denied`)

1. `error` present → `302 /login?error=cancelled`.
2. `state` must equal the `__Host-oauth_state` cookie **and** `GETDEL oauth:state:{state}`
   must return a value. Otherwise → `/login?error=expired` (400). The state cookie is
   cleared either way.
3. `POST https://discord.com/api/v10/oauth2/token` (form: `client_id`, `client_secret`,
   `grant_type=authorization_code`, `code`, `redirect_uri`). Then
   `GET https://discord.com/api/v10/users/@me` with the bearer token. Any non-2xx or
   network error → `/login?error=discord` (502), logged. Both calls go through
   `deps.fetch`.
4. Keep only `id`, `username`, `global_name`, `avatar`. The Discord access token is
   discarded.
5. Create a session (below), set the cookie, `302` to the stored `next`.

**`POST /auth/logout`** — deletes the current session and clears the cookie; `302 /login`.
With form field `everywhere=1`, deletes every session in `auth:user:{uid}`.

### Sessions

| Key                  | Value                                                           | TTL                |
| -------------------- | --------------------------------------------------------------- | ------------------ |
| `auth:{sha256(tok)}` | hash: `userId`, `username`, `globalName`, `avatar`, `createdAt` | 30 days, sliding   |
| `auth:user:{uid}`    | set of `sha256(tok)` hex digests for that user                  | 30 days, refreshed |

- `tok` = 32 random bytes, base64url, sent as
  `__Host-session={tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`.
- On each authenticated request, if the key's remaining TTL is under 29 days, reset it to
  30 days and re-issue the cookie. Otherwise nothing is written.
- Stale members of `auth:user:{uid}` (key already expired) are pruned during
  sign-out-everywhere.

### Middleware and guards

- A Hono middleware reads `__Host-session`, loads the hash, and sets `c.var.user`
  (`{ id, username, globalName, avatar }` or `null`). The same value is passed to Astro
  as `locals.user`.
- `/dashboard` and `/dashboard/*` with no user → `302 /login?next={path}`.
- `/api/me/*` with no user → `401 {"error":"Not signed in"}`.
- Every non-GET under `/api/me/*` and `/auth/*` must carry an `Origin` header equal to
  `PUBLIC_URL`'s origin, otherwise `403`.

### Login page

Astro page in the existing card style: brand bar ("Sign in" / "Your uploads, anywhere"),
one notched card, a blurple "Continue with Discord" button (a form `GET` to
`/auth/login`, preserving `next`). Error messages by `?error=`:

| `error`     | Message                                          |
| ----------- | ------------------------------------------------ |
| `cancelled` | Sign-in cancelled.                               |
| `expired`   | That sign-in link expired. Try again.            |
| `discord`   | Discord didn't answer. Try again in a moment.    |
| (config)    | Sign-in isn't set up on this server. (no button) |

A signed-in visitor is redirected to `next` or `/dashboard`.

### Command replies

The ephemeral replies to `/upload` and `/gallery` add a link button "Open dashboard" →
`{PUBLIC_URL}/dashboard`, only when `DISCORD_CLIENT_SECRET` is set.

## 3. Data, usage tracking and API

### New Redis keys

| Key                          | Shape                                           | TTL      |
| ---------------------------- | ----------------------------------------------- | -------- |
| `usage:{uid}:d:{YYYY-MM-DD}` | hash: `uploads`, `bytes`, `cmd:{name}` counters | 100 days |
| `usage:{uid}:cmds`           | hash: all-time count per command name           | none     |
| `usage:since`                | epoch ms when per-user command tracking started | none     |
| `usage:seeded:v1`            | `1` once the seeding migration has run          | none     |

Days are UTC. The TTL is refreshed on each write, so a key lives 100 days past its last
write; reads older than 90 days are never requested.

### Write points

- `recordCommandUse(redis, command, userId)` adds, in the same `MULTI`:
  `HINCRBY usage:{uid}:d:{today} cmd:{command} 1`, `EXPIRE … 8640000`,
  `HINCRBY usage:{uid}:cmds {command} 1`. `SETNX usage:since {now}` runs at boot.
- `recordUpload(redis, userId, bytes)` (new, `storage/usage.ts`) increments `uploads` and
  `bytes` for today. Called by the shared ingest after a successful store, for both the
  Discord link and the dashboard.
- Deletes and expiries do not decrement usage.

### Seeding

At boot, after reconciliation, if `SET usage:seeded:v1 1 NX` succeeds: for every
`file:*` record, `HINCRBY usage:{userId}:d:{date(createdAt)} uploads 1` and
`bytes {size}`, with the 100-day TTL; records older than 100 days are skipped. Runs once.

### Shared ingest

`storage/ingest.ts` takes over from `routes/upload.ts`: streaming multipart receipt via
busboy, the per-file size cap, magic-byte sniffing, the per-user quota check,
`saveRecord`, `recordUpload`, and `sweep`. Both `/u/:sid/file` and `POST /api/me/files`
call it. `/u/:sid/file` keeps its exact request/response contract and its existing tests
pass unchanged.

### Rate limits

`peekRateLimit(redis, scope, userId, limit)` in `storage/ratelimit.ts` reads the current
window's counter with `GET` and returns the same `RateLimitResult` shape without
incrementing. Dashboard uploads use `checkRateLimit` with the existing `upload` scope,
so both paths share one hourly budget.

### API

All routes require a session. Responses are JSON with `Cache-Control: no-store`.

| Route                        | Behaviour                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/me`                | `{ user, limits: { maxFileBytes, maxUserBytes, ttlOptions, uploadsPerHour, sessionsPerHour } }`                                                                                                                                                                                                                     |
| `GET /api/me/files`          | Runs `expireDue`, then `{ files: [{ id, name, mime, kind, size, width, height, createdAt, expiresAt, url, watchUrl }] }`, newest first                                                                                                                                                                              |
| `POST /api/me/files`         | Multipart. Fields `ttl` (a `TTL_OPTIONS` value), `width`, `height` must precede the `file` part. Rate limit, then ingest. `201 { file }`. Errors use the same statuses and messages as `/u/:sid/file` (413, 415, 429 with `retryAfterSeconds`, quota).                                                              |
| `DELETE /api/me/files/:id`   | Deletes if owned. Not found or not owned → `404`, as `/api/files/:id` does today                                                                                                                                                                                                                                    |
| `POST /api/me/files/delete`  | Body `{ ids: string[] }`, 1–100 ids, else `400`. Deletes the owned ones. `{ deleted: string[], missing: string[] }`                                                                                                                                                                                                 |
| `GET /api/me/usage?range=7d` | `range` ∈ `7d`,`30d`,`90d` (default `30d`). `{ storage: { used, quota, images: { count, bytes }, videos: { count, bytes } }, series: [{ date, uploads, bytes }], commands: { range: {…}, allTime: {…} }, rateLimits: { uploads, sessions }, trackingSince }`. `series` has one entry per day in range, zero-filled. |

## 4. Dashboard UX

### Shell

- The standard brand bar: mascot, `Dashboard` / `@username`, then at the end an
  `[Upload]` button and the user's avatar (Discord CDN; `DitherAvatar` seeded by user id
  when the user has none). The avatar opens a menu: "Sign out", "Sign out everywhere".
- Tabs under the bar: **Files** (`/dashboard`) and **Usage** (`/dashboard/usage`),
  switched with Astro's `<ClientRouter />` view transitions.
- The upload tray and drop overlay live in the layout with `transition:persist`, so an
  upload in progress survives a tab switch.
- Initial data is loaded in frontmatter and passed to islands as props. No loading
  spinner on first paint.

### Files tab

```
┌ STORAGE ▓▓▓▓▓▓▓░░░ 1.2 GB / 2 GB  img 0.4 · vid 0.8   28/30 uploads left  ▁▃▂▆ 7d ┐
│ [/ filter……]  [ALL|IMG|VID]  [Newest ▾]                         [Select]     │
│ ┌────┐┌────┐┌────┐┌────┐┌────┐                                              │
│ │tile││tile││tile││tile││tile│                                              │
│ └────┘└────┘└────┘└────┘└────┘                                              │
└──────────────────────────────────────────────────────────────────────────────┘
      ┌ 3 selected · 48 MB   [Copy links] [Delete] [Esc] ┐
```

- **Storage strip:** pixel meter of used vs quota with the image/video split, uploads
  left this hour, and a 7-day uploads `Sparkline`.
- **Toolbar:** filter (`/` focuses it), kind segmented control, sort (the existing
  `SORTS` from `gallery-filters.js`), and a Select toggle.
- **Grid:** the legacy gallery's tile markup and CSS, rendered by a React island. Tiles
  show size, date, and a live expiry countdown (`formatRemaining`).
- **Keyboard:** arrow keys move between tiles, `Enter` opens the lightbox, `x` toggles
  selection, `Esc` leaves select mode or closes the lightbox.
- **Select mode:** checkboxes on tiles, shift-click selects a range, `Ctrl/Cmd+A` selects
  every visible tile. A sticky bar shows count and total size, with Copy links (newline
  separated) and Delete.
- **Delete** (single or bulk) is two-click arm-then-confirm, disarming after 4s, with the
  armed state announced through `aria-live`, as the legacy gallery does.
- **Lightbox:** full-size image or `<video controls>`, `←`/`→` to move, `Esc` to close,
  focus trapped. A details panel shows name, size, dimensions, upload date, live expiry,
  and Copy / Open / Delete. The URL hash `#f={id}` reflects the open file so Back closes
  it and the lightbox reopens on reload.
- **Empty state:** mascot and "Drop a file anywhere, paste, or press Upload."

### Uploading

- Dragging files anywhere over the page shows a full-page notched overlay, "Drop to
  upload". `Ctrl/Cmd+V` with an image on the clipboard queues it. The `[Upload]` button
  opens a file picker (`multiple`).
- **Tray** (bottom-right, collapsible; bottom sheet under 640px wide):
  - TTL select at the top, default 30 days, last choice kept in `localStorage`.
  - One row per file: thumbnail, name, size, pixel progress bar, status: queued →
    uploading `n%` → done (Copy link) | failed (message + Retry). Every row not yet done
    has Cancel (aborts the XHR if running).
  - Files upload one at a time, in the order added.
- **Pre-send checks** per file: allowed type, size ≤ `maxFileBytes`, cumulative size
  within remaining quota, count within remaining hourly uploads. Files that fail are
  added to the tray already failed, with the reason, and never sent.
- Video width/height are measured in the browser before sending; that code moves from
  `upload.js` into a shared module used by both pages.
- A finished upload is inserted at the top of the grid from the `201` response with a
  short highlight, and the storage strip updates. No refetch.
- `beforeunload` asks for confirmation while any upload is queued or running.

### Usage tab

```
[7D|30D|90D]                                             tracked since 27 Sep
┌STORAGE──────┐┌FILES────────┐┌UPLOADS──────┐┌DATA IN─────┐
│1.2/2 GB ▓▓░ ││42  img30 v12││17  ▲ vs prev││640 MB      │
└─────────────┘└─────────────┘└─────────────┘└────────────┘
┌ ACTIVITY  [Uploads|Bytes] ─────────────────────────────── AreaChart, scrub ┐
└────────────────────────────────────────────────────────────────────────────┘
┌ COMMANDS  range | all-time ── BarChart ┐┌ STORAGE MIX ── PieChart img/vid ┐
└────────────────────────────────────────┘└─────────────────────────────────┘
┌ LIMITS  uploads 2/30 ▓░░  sessions 5/150 ░░░   resets in 41:12 ┐
```

- Range in the URL (`?range=30d`); changing it refetches `/api/me/usage`.
- Stat tiles: storage used/quota; file count with image/video split; uploads in range
  with change vs the previous equal period; bytes uploaded in range.
- Activity: dither-kit `AreaChart` of uploads or bytes per day, scrub tooltip.
- Commands: dither-kit `BarChart`, toggle range vs all-time. Note "tracked since
  {usage:since}".
- Storage mix: dither-kit `PieChart`, images vs videos by bytes.
- Limits: meters for uploads and sessions this hour with a live reset countdown.
- Chart colours map to `--indigo`, `--cyan`, `--gold` from `upload.css`.

### Cross-cutting

- Loading skeletons (range change, retries) use `DitherGradient`.
- Fetch errors render inline with Retry. A `401` shows the toast "Session ended, sign in
  again" and redirects to `/login?next={current path}`.
- Toasts bottom-left for copy, delete and upload results; announced via `aria-live`.
- `prefers-reduced-motion` disables chart entrance animation, sparkles and highlights.
- Under 640px: two-column grid, full-width tabs, tray as bottom sheet.

## 5. Errors, testing, rollout

### Error handling

| Condition                                      | Result                                                          |
| ---------------------------------------------- | --------------------------------------------------------------- |
| User cancels at Discord                        | `/login?error=cancelled`                                        |
| OAuth state missing, reused or mismatched      | `/login?error=expired`, 400                                     |
| Discord token or `/users/@me` fails            | `/login?error=discord`, 502, logged                             |
| `DISCORD_CLIENT_SECRET` unset                  | `/login` says sign-in isn't set up; bot unaffected              |
| No/expired session on `/dashboard*`            | `302 /login?next=…`                                             |
| No/expired session on `/api/me/*`              | `401` JSON → toast, redirect to login                           |
| Bad `Origin` on non-GET `/api/me/*`, `/auth/*` | `403`                                                           |
| Dashboard upload fails                         | Same status as `/u/:sid/file`; shown on the tray row with Retry |
| Bulk delete includes ids not owned             | Returned in `missing`; not an error                             |
| Redis empty but `/data` has files at boot      | Error logged; directory deletion skipped                        |

### Testing

- **Vitest, existing suite:** passes unchanged, including `integration.test.ts` against
  `/u/:sid`, `/g/:gid`, `/v/:id` and `/u/:sid/file`.
- **Vitest, new:**
  - `auth`: `next` sanitising, state single-use and cookie match, cookie flags, hashed
    storage, sliding refresh threshold, sign-out and sign-out-everywhere, full callback
    flow through a mocked `deps.fetch` (success, cancelled, Discord 500).
  - `usage`: daily and all-time writes, TTLs, seeding runs exactly once, `series`
    zero-fill, `peekRateLimit` never increments.
  - `/api/me/*`: 401 without session, 403 on bad Origin, 404 on another user's file, bulk
    delete ownership split, streamed upload through the shared ingest (size, type, quota,
    rate limit).
  - `reconcile`: guard skips deletion when Redis has no records.
  - Pure client modules in `web/src/lib/`: upload queue state machine, selection ranges,
    pre-send checks, formatters.
  - Astro pages via the Astro Container API: `/v/:id` meta tags, the expired page, token
    and data attributes on `/u` and `/g`, login error messages.
- **Playwright (`pnpm test:e2e`, local, needs Redis):**
  - Visual regression: screenshots of `/u/:sid`, `/g/:gid` (empty and with files),
    `/v/:id` and the expired page are captured from `main` before migration and committed.
    The Astro versions must match with zero pixel difference.
  - Dashboard flows with a session written directly to Redis: queue three files, cancel
    one, retry a failure; lightbox arrow-key navigation; bulk delete; tab switch during an
    upload keeps it running.

### Rollout

Three phases on this branch, each leaving tests, typecheck and formatting green:

1. Astro migration of the existing pages + reconciliation guard. Visual diff zero.
2. Auth, usage tracking and seeding, `storage/ingest.ts`, `/api/me/*`.
3. Dashboard UI, "Open dashboard" button in command replies, README / `.env.example` /
   Dockerfile updates (OAuth setup, redirect URI, checking Redis `appendonly yes`).

Before the PR: `pnpm dlx prettier --write .`, `pnpm dlx prettier --check .`,
`pnpm test`, `pnpm typecheck`.

## Out of scope

- Changing expiry of existing files.
- Posting dashboard uploads to Discord.
- Moving file records out of Redis.
- Admin views in the dashboard (the `/admin` command is unchanged).
- Backfilling per-user command history from before deploy.
