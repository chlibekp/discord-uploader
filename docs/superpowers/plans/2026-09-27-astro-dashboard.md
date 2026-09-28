# Astro Pages, Discord Sign-in and Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve every page through Astro with no visible change, add Discord OAuth sign-in, and add a signed-in dashboard (gallery, multi-file upload, dither-kit usage charts).

**Architecture:** Hono stays the server and owns every API, interaction, streaming and file route. A small in-repo Astro adapter builds a fetch-native `render(request, locals)` entry that Hono mounts as its last route, so `app.fetch(Request)` (and therefore the whole existing test suite) keeps working. Dashboard interactivity is React islands; charts are dither-kit (shadcn-style source copied into the repo, palette patched to the mascot colours).

**Tech Stack:** Hono 4, ioredis, Astro 7, `@astrojs/react` 7, React 19, Tailwind 4 (`@tailwindcss/vite`, no preflight), Motion, d3-scale/d3-shape, Vitest 2, Playwright 1.6x.

**Spec:** `docs/superpowers/specs/2026-09-27-astro-dashboard-design.md`

## Global Constraints

- Node `>=22` (local is 22.14). Package manager pnpm 11. **pnpm does not run `pre*`/`post*` scripts**: chain steps explicitly inside the script (`"test": "pnpm build:web && vitest run"`).
- Legacy pages (`/u/:sid`, `/g/:gid`, `/v/:id`, expired) must be pixel-identical to `main` @ 720e25a, keep their status codes, `Cache-Control` values, and the `UPLOAD_PAGE_CSP` header string exactly.
- Existing tests are not edited to make them pass. Only `test/helpers.ts` plumbing may change.
- Silkscreen is used only at 8, 12, 16 or 20px. Every spacing value is a multiple of 8px (4px allowed for notch/shadow details already in `upload.css`). Colours come only from the `upload.css` custom properties (`--void --panel --panel-hi --line --ink --dim --indigo --cyan --gold --danger`).
- `public/upload.css` stays the single base stylesheet for every page, served at `/assets/upload.css`. (Spec said "moved to `web/src/styles`"; it stays in `public/` because Hono already serves it and moving it buys nothing.)
- Web code imports server modules through the `@server/*` alias **without** a file extension (`import { getSession } from "@server/storage/sessions"`), so Vite resolves the `.ts` file.
- Server code never imports `src/assets.ts` from anything Astro bundles (it reads files relative to its own location at import time). CSP strings live in `src/web/csp.ts`.
- Session cookie: `__Host-session`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days. OAuth state cookie: `__Host-oauth_state`, 600s.
- Every commit message is Conventional Commits and ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before the PR: `pnpm dlx prettier --write .` then `pnpm dlx prettier --check .`, `pnpm test`, `pnpm typecheck`.

## Deviations from the spec (decided while planning)

1. **Page tests** go through the real built Astro entry via `app.fetch` rather than the Astro Container API. That's stronger coverage for less setup.
2. **Quota pre-check in the upload tray warns, not blocks.** The server never rejects an upload for being over quota. It evicts the uploader's own oldest files (`enforceUserQuota`). Only a single file larger than the whole quota (`maxUserBytes`) is rejected, and the tray blocks exactly that case.
3. **Login errors** are a `302` to `/login?error=…`, and the login page responds with the spec's status (400 for `expired`, 502 for `discord`).
4. `loadUser` runs only on `/auth/*`, `/api/me/*`, `/dashboard*` and `/login`. This keeps a Redis read off every `/f/*` image request.

## Review Focus

1. **Open redirect through `next`.** `//evil.com`, `/\evil.com`, `https://evil.com`, `/%2F%2Fevil.com` and an empty value must all resolve to `/dashboard`. Browsers treat a backslash like a slash. Test: Task 8.
2. **Stale or garbage session cookie.** A cookie whose Redis key has expired, or one that was never valid, must be treated as signed out, cleared, and must not throw. Test: Task 9.
3. **HTML-ish filenames.** A stored record named `a"><img src=x onerror=alert(1)>.png` must render escaped on `/g/:gid`, `/v/:id` and in dashboard SSR props. Test: Task 5 (legacy pages) and Task 16 (dashboard SSR).
4. **Server rejects what the pre-check allowed.** An upload the tray thought was fine gets a 429, 413 or 415 because a parallel Discord upload used the budget. The row must show the server's message and offer Retry. Test: Task 12 (API) and Task 20 (UI).
5. **Stale ids in a bulk delete.** Ids already deleted in another tab, or not owned, must return in `missing` and never error or touch others' files. The same applies to a UTC-midnight boundary in the usage series (today is always the last point). Test: Task 10 and Task 12.

## File Map

```
src/
  app.ts                    MODIFY  typed AuthEnv, auth/me routes, loadUser/sameOrigin, web fallback
  index.ts                  MODIFY  load web renderer, usage seeding
  config.ts                 MODIFY  discordClientSecret
  auth/types.ts             CREATE  AuthUser, AuthEnv
  auth/sessions.ts          CREATE  create/read(slide)/delete/deleteAll auth sessions
  auth/oauth.ts             CREATE  safeNext, state create/consume, authorizeUrl, exchangeCode
  auth/cookies.ts           CREATE  session cookie set/clear/read
  auth/middleware.ts        CREATE  loadUser, requireApiUser, requirePageUser, sameOrigin
  routes/auth.ts            CREATE  /auth/login, /auth/callback, /auth/logout
  routes/me.ts              CREATE  /api/me/*
  me/types.ts               CREATE  ApiFile, ApiLimits, ApiRate, ApiUsage, UsageRange (types only)
  me/data.ts                CREATE  toApiFile, listMyFiles, limitsFor, getMyUsage, parseRange
  storage/ingest.ts         CREATE  shared upload pipeline (from routes/upload.ts)
  storage/usage.ts          MODIFY  per-user daily/all-time counters, seeding, getUserUsage
  storage/ratelimit.ts      MODIFY  peekRateLimit
  storage/lru.ts            MODIFY  reconciliation guard
  routes/upload.ts          MODIFY  page handler removed, uses ingest
  routes/gallery.ts         MODIFY  page handler + HTML builders removed (DELETE /api/files/:id stays)
  routes/files.ts           MODIFY  /v/:id handler removed
  routes/interactions.ts    MODIFY  "Open dashboard" button
  routes/assets.ts          MODIFY  serve /assets/measure.js
  pages.ts                  DELETE
  assets.ts                 MODIFY  drop uploadHtml/galleryHtml, add measureJs, CSP moves out
  web/csp.ts                CREATE  UPLOAD_PAGE_CSP, DASHBOARD_CSP
  web/format.ts             CREATE  formatBytes, formatDate, expiryLabel (pure, shared with web)
  web/mount.ts              CREATE  loadWebRenderer, webRoutes (/_astro assets + fallback)
web/
  astro.config.mjs          CREATE
  tsconfig.json             CREATE
  adapter/index.mjs         CREATE  Astro integration that calls setAdapter
  adapter/server.mjs        CREATE  server entry: export render(request, locals)
  src/env.d.ts              CREATE  App.Locals typing
  src/layouts/Shell.astro   CREATE
  src/layouts/Dashboard.astro CREATE
  src/components/BrandBar.astro  CREATE
  src/components/Expired.astro   CREATE
  src/components/LegacyTile.astro CREATE
  src/pages/u/[sid].astro   CREATE
  src/pages/g/[gid].astro   CREATE
  src/pages/v/[id].astro    CREATE
  src/pages/login.astro     CREATE
  src/pages/dashboard/index.astro CREATE
  src/pages/dashboard/usage.astro CREATE
  src/styles/dashboard.css  CREATE
  src/lib/*.ts              CREATE  store, format, selection, queue, preflight, api, uploader (+ tests)
  src/islands/*.tsx         CREATE  FilesView, Lightbox, UploadTray, Toasts, UsageView, UserAvatar
  src/components/dither-kit/*  CREATE via CLI, palette.ts patched
public/
  measure.js                CREATE  readDimensions() ES module shared by upload.js and the tray
  gallery-filters.d.ts      CREATE  types for the JS module so TS islands can import it
  upload.js                 MODIFY  import readDimensions from ./measure.js
  upload.html, gallery.html DELETE  (replaced by Astro pages)
test/
  helpers.ts                MODIFY  web renderer, JSON-or-form fetch mock with overrides
  reconcile.test.ts         CREATE
  auth.test.ts              CREATE
  me.test.ts                CREATE
  usage-user.test.ts        CREATE
  pages.test.ts             CREATE
  e2e/server.ts             CREATE  in-process e2e server (ioredis-mock) + /__e2e routes
  e2e/fixtures.ts           CREATE  PNG generator, seeders
  e2e/legacy-pages.spec.ts  CREATE  visual regression
  e2e/dashboard.spec.ts     CREATE  dashboard flows
playwright.config.ts        CREATE
```

---

# Phase 1 — Astro migration (no visible change)

### Task 1: Visual-regression harness and baselines on the current pages

Captured **before** any migration, so later tasks prove zero pixel change.

**Files:**

- Create: `playwright.config.ts`, `test/e2e/server.ts`, `test/e2e/fixtures.ts`, `test/e2e/legacy-pages.spec.ts`
- Modify: `package.json` (scripts, devDeps), `.gitignore`

**Interfaces:**

- Consumes: `makeHarness(overrides)` from `test/helpers.ts`, `createSession`, `saveRecord`, `fileDir`.
- Produces: `pnpm e2e:server` (listens on `:4173`), `pnpm test:e2e`, the `/__e2e/*` routes `POST /__e2e/reset`, `POST /__e2e/session?kind=upload|gallery&user=ID` → `{ sid }`. Task 14 adds `POST /__e2e/login`.

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test@^1.63.0
pnpm exec playwright install chromium
```

- [ ] **Step 2: Write `test/e2e/fixtures.ts`**

```ts
import { deflateSync, crc32 } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppDeps } from "../../src/app.js";
import { saveRecord, fileDir } from "../../src/storage/store.js";
import type { FileRecord } from "../../src/types.js";

export const E2E_USER = "100000000000000001";
export const E2E_EMPTY_USER = "100000000000000002";
/** Fixed so dates on tiles never change between runs. */
export const FIXED_CREATED_AT = Date.UTC(2026, 0, 15, 12, 0, 0);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour RGB PNG, so fixtures need no binary files in the repo. */
export function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Bytes that sniff as MP4 (ftyp isom). The browser cannot play it; screenshots only need a stable frame. */
export function fakeMp4(): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(24, 0);
  b.write("ftypisom", 4, "ascii");
  return b;
}

async function put(
  deps: AppDeps,
  record: FileRecord,
  bytes: Buffer,
): Promise<void> {
  await mkdir(fileDir(deps.config, record.id), { recursive: true });
  await writeFile(
    path.join(fileDir(deps.config, record.id), record.name),
    bytes,
  );
  await saveRecord(deps.redis, { ...record, size: bytes.length });
}

export async function seedFixtures(deps: AppDeps): Promise<void> {
  const base = {
    userId: E2E_USER,
    channelId: "200000000000000001",
    createdAt: FIXED_CREATED_AT,
    expiresAt: 0,
  };
  await put(
    deps,
    {
      ...base,
      id: "e2eimagecyan00000000001",
      name: "cyan-square.png",
      mime: "image/png",
      kind: "image",
      size: 0,
      width: 320,
      height: 320,
      createdAt: FIXED_CREATED_AT - 2000,
    },
    solidPng(320, 320, [63, 193, 243]),
  );
  await put(
    deps,
    {
      ...base,
      id: "e2eimagegold00000000002",
      name: "gold-wide.png",
      mime: "image/png",
      kind: "image",
      size: 0,
      width: 640,
      height: 320,
      createdAt: FIXED_CREATED_AT - 1000,
    },
    solidPng(640, 320, [245, 197, 24]),
  );
  await put(
    deps,
    {
      ...base,
      id: "e2evideo000000000000003",
      name: "clip.mp4",
      mime: "video/mp4",
      kind: "video",
      size: 0,
      width: 1280,
      height: 720,
    },
    fakeMp4(),
  );
}
```

- [ ] **Step 3: Write `test/e2e/server.ts`**

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { rm, mkdir } from "node:fs/promises";
import { makeHarness } from "../helpers.js";
import { createSession } from "../../src/storage/sessions.js";
import { seedFixtures, E2E_USER } from "./fixtures.js";

const PORT = 4173;
const h = await makeHarness({
  publicUrl: `http://localhost:${PORT}`,
  maxFileBytes: 50 * 1024 * 1024,
  maxUserBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024 * 1024,
});

async function reset(): Promise<void> {
  await h.deps.redis.flushall();
  await rm(h.deps.config.dataDir, { recursive: true, force: true });
  await mkdir(h.deps.config.dataDir, { recursive: true });
  await seedFixtures(h.deps);
}
await reset();

const root = new Hono();
root.post("/__e2e/reset", async (c) => {
  await reset();
  return c.json({ ok: true });
});
root.post("/__e2e/session", async (c) => {
  const kind = c.req.query("kind") === "gallery" ? "gallery" : "upload";
  const session = await createSession(h.deps.redis, {
    kind,
    userId: c.req.query("user") ?? E2E_USER,
    channelId: "200000000000000001",
    guildId: "",
    interactionToken: "e2e-token",
    ttlMs: 0,
  });
  return c.json({ sid: session.sid });
});
root.route("/", h.app);

serve({ fetch: root.fetch, port: PORT }, () =>
  console.log(`e2e server on :${PORT}`),
);
```

- [ ] **Step 4: Write `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: "pnpm e2e:server",
    url: "http://localhost:4173/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
```

- [ ] **Step 5: Write `test/e2e/legacy-pages.spec.ts`**

```ts
import { test, expect, type Page } from "@playwright/test";
import { E2E_EMPTY_USER } from "./fixtures.js";

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
}

async function mint(
  page: Page,
  kind: "upload" | "gallery",
  user?: string,
): Promise<string> {
  const q = new URLSearchParams({ kind, ...(user ? { user } : {}) });
  const res = await page.request.post(`/__e2e/session?${q}`);
  return (await res.json()).sid as string;
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/__e2e/reset");
});

test("upload page", async ({ page }) => {
  await page.goto(`/u/${await mint(page, "upload")}`);
  await settle(page);
  await expect(page).toHaveScreenshot("upload.png", {
    fullPage: true,
    mask: [page.locator("#countdown")],
  });
});

test("gallery with files", async ({ page }) => {
  await page.goto(`/g/${await mint(page, "gallery")}`);
  await settle(page);
  await expect(page).toHaveScreenshot("gallery.png", { fullPage: true });
});

test("gallery empty", async ({ page }) => {
  await page.goto(`/g/${await mint(page, "gallery", E2E_EMPTY_USER)}`);
  await settle(page);
  await expect(page).toHaveScreenshot("gallery-empty.png", { fullPage: true });
});

test("watch page", async ({ page }) => {
  await page.goto("/v/e2evideo000000000000003");
  await settle(page);
  await expect(page).toHaveScreenshot("watch.png", { fullPage: true });
});

test("expired upload link", async ({ page }) => {
  const res = await page.goto("/u/does-not-exist");
  expect(res?.status()).toBe(404);
  await settle(page);
  await expect(page).toHaveScreenshot("expired-upload.png", { fullPage: true });
});

test("expired gallery link", async ({ page }) => {
  const res = await page.goto("/g/does-not-exist");
  expect(res?.status()).toBe(404);
  await settle(page);
  await expect(page).toHaveScreenshot("expired-gallery.png", {
    fullPage: true,
  });
});
```

- [ ] **Step 6: Add scripts and ignores**

In `package.json` `scripts` add:

```json
"e2e:server": "tsx test/e2e/server.ts",
"test:e2e": "playwright test"
```

Append to `.gitignore`:

```
test-results/
playwright-report/
```

- [ ] **Step 7: Capture baselines**

Run: `pnpm test:e2e --update-snapshots`
Expected: 6 passed, 6 PNGs written under `test/e2e/__screenshots__/legacy-pages.spec.ts/`. Open each PNG and check it looks like the real page: fonts loaded, mascot visible, three tiles in the gallery.

- [ ] **Step 8: Re-run without update to prove determinism**

Run: `pnpm test:e2e`
Expected: 6 passed. If any diff appears, find the non-deterministic element (such as a live countdown) and add it to `mask`. Never raise `maxDiffPixels`.

- [ ] **Step 9: Commit**

```bash
git add playwright.config.ts test/e2e package.json pnpm-lock.yaml .gitignore
git commit -m "test: visual-regression baselines for the legacy pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Reconciliation guard

**Files:**

- Modify: `src/storage/lru.ts` (`reconcile`)
- Test: `test/reconcile.test.ts`

**Interfaces:**

- Consumes: `reconcile(redis, config)`, `saveRecord`, `fileDir`.
- Produces: unchanged signature. New behaviour: when Redis has zero file records and the disk has at least one directory, no directory is deleted.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { reconcile } from "../src/storage/lru.js";
import { fileDir, saveRecord } from "../src/storage/store.js";

let h: Harness;
afterEach(() => h?.cleanup());

function orphan(id: string): string {
  const dir = fileDir(h.deps.config, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "x.png"), "x");
  return dir;
}

describe("reconcile guard", () => {
  it("keeps every directory when Redis holds no file records at all", async () => {
    h = await makeHarness();
    const a = orphan("orphanaaaaaaaaaaaaaaaa");
    const b = orphan("orphanbbbbbbbbbbbbbbbb");

    await reconcile(h.deps.redis, h.deps.config);

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("still removes an orphan when other records exist", async () => {
    h = await makeHarness();
    const kept = orphan("keptkeptkeptkeptkeptkk");
    await saveRecord(h.deps.redis, {
      id: "keptkeptkeptkeptkeptkk",
      name: "x.png",
      mime: "image/png",
      kind: "image",
      size: 1,
      width: 1,
      height: 1,
      createdAt: Date.now(),
      expiresAt: 0,
      userId: "u1",
      channelId: "c1",
    });
    const stray = orphan("straystraystraystrayss");

    await reconcile(h.deps.redis, h.deps.config);

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(stray)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch the first case fail**

Run: `pnpm vitest run test/reconcile.test.ts`
Expected: FAIL on "keeps every directory…" (the directories were deleted).

- [ ] **Step 3: Implement the guard in `reconcile`**

In `src/storage/lru.ts`, after `const known = await redis.zrange(LRU_KEY, 0, -1);` add:

```ts
// An empty Redis next to a populated volume almost always means Redis lost
// its data, not that every file is an orphan. Deleting here would turn a
// Redis outage into total data loss, so leave the files for an operator.
const redisLooksWiped = known.length === 0 && onDisk.size > 0;
if (redisLooksWiped) {
  console.error(
    `Redis has no file records but ${onDisk.size} directories exist in ${config.dataDir}; ` +
      "skipping orphan deletion. Restore Redis or remove the directories by hand.",
  );
}
```

and change the orphan branch in the `for (const id of onDisk)` loop to:

```ts
if (!stillKnown.has(id)) {
  if (redisLooksWiped) continue;
  console.warn(`Removing orphan directory ${id}: no record in Redis`);
  await deleteRecord(redis, config, id);
  continue;
}
```

- [ ] **Step 4: Run the new tests and the full suite**

Run: `pnpm vitest run test/reconcile.test.ts && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/lru.ts test/reconcile.test.ts
git commit -m "fix: never delete files at boot when Redis comes back empty

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Astro scaffold, fetch-native adapter, Hono mount, and the watch page

**Files:**

- Create: `web/astro.config.mjs`, `web/tsconfig.json`, `web/adapter/index.mjs`, `web/adapter/server.mjs`, `web/src/env.d.ts`, `web/src/layouts/Shell.astro`, `web/src/components/BrandBar.astro`, `web/src/pages/v/[id].astro`, `src/web/csp.ts`, `src/web/mount.ts`
- Modify: `src/app.ts`, `src/index.ts`, `src/assets.ts`, `src/routes/files.ts`, `src/routes/upload.ts`, `src/routes/gallery.ts` (CSP import only), `test/helpers.ts`, `package.json`, `Dockerfile`, `.gitignore`, `.dockerignore`

**Interfaces:**

- Produces:
  - `src/web/mount.ts`:
    - `interface WebLocals { deps: AppDeps; user: AuthUser | null }`. Until Task 9, `AuthUser` is declared here as `{ id: string; username: string; globalName: string; avatar: string }`. Task 8 moves it to `src/auth/types.ts`.
    - `type WebRenderer = (request: Request, locals: WebLocals) => Promise<Response | null>`
    - `loadWebRenderer(): Promise<WebRenderer>`
    - `webRoutes(deps: AppDeps)`, which serves `/_astro/:file` and the catch-all, reading `c.get("user")`.
  - `AppDeps.web?: WebRenderer`.
  - `src/web/csp.ts`: `UPLOAD_PAGE_CSP` (moved verbatim from `assets.ts`).
  - Astro `Astro.locals.deps`, `Astro.locals.user`.
  - Scripts: `build:web`, `build`, `test`, `typecheck`, `dev`.

- [ ] **Step 1: Install dependencies**

```bash
pnpm add astro@^7.3.5 @astrojs/react@^7.0.0 react@^19.3.0 react-dom@^19.3.0
pnpm add -D @astrojs/check @types/react @types/react-dom concurrently chokidar-cli
```

If pnpm reports packages whose build scripts were ignored (for example `sharp`), add each one to `allowBuilds` in `pnpm-workspace.yaml` as `false`. Re-run `pnpm install` and confirm it exits 0.

- [ ] **Step 2: Move the CSP constant to `src/web/csp.ts`**

```ts
/** Strict policy for the single-use upload/gallery pages. Unchanged from the Hono-rendered originals. */
export const UPLOAD_PAGE_CSP =
  "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";
```

Delete `UPLOAD_PAGE_CSP` from `src/assets.ts`. Change the imports in `src/routes/upload.ts` and `src/routes/gallery.ts` to `import { UPLOAD_PAGE_CSP } from "../web/csp.js";`, keeping `assets` imported from `../assets.js` where it's still used.

- [ ] **Step 3: Write the adapter**

`web/adapter/index.mjs`:

```js
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
```

`web/adapter/server.mjs`:

```js
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
```

**If the installed Astro doesn't export `astro/app/entrypoint`** (the build fails with "Package subpath './app/entrypoint' is not defined"), switch to explicit mode:

- Set `entrypointResolution: "explicit"` and `exports: ["render"]` in `setAdapter`.
- Make `server.mjs` export `createExports(manifest)` returning `{ render }`, where `app` is `new App(manifest)` imported from `astro/app`.

The `render` body stays identical either way.

- [ ] **Step 4: Write `web/astro.config.mjs`**

```js
import { defineConfig } from "astro/config";
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
  devToolbar: { enabled: false },
  vite: {
    resolve: {
      alias: { "@server": fileURLToPath(new URL("../src", import.meta.url)) },
    },
    ssr: { external: ["ioredis", "busboy"] },
  },
});
```

Also create an empty `web/public/.gitkeep`.

- [ ] **Step 5: Write `web/tsconfig.json` and `web/src/env.d.ts`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@server/*": ["../src/*"] },
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "allowJs": true
  },
  "include": [".astro/types.d.ts", "src/**/*", "../public/*.d.ts"],
  "exclude": ["dist"]
}
```

```ts
/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    deps: import("@server/app").AppDeps;
    user: import("@server/web/mount").WebLocals["user"];
  }
}
```

- [ ] **Step 6: Write `src/web/mount.ts`**

```ts
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AppDeps } from "../app.js";

/** Replaced by the import from ../auth/types.js in Task 8. */
export interface AuthUser {
  id: string;
  username: string;
  globalName: string;
  avatar: string;
}

export interface WebLocals {
  deps: AppDeps;
  user: AuthUser | null;
}

export type WebRenderer = (
  request: Request,
  locals: WebLocals,
) => Promise<Response | null>;

/** `web/dist` sits two levels above both `src/web/` and `dist/web/`. */
const webDist = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "dist",
);

export async function loadWebRenderer(): Promise<WebRenderer> {
  const entry = path.join(webDist, "server", "entry.mjs");
  if (!existsSync(entry)) {
    throw new Error(`Astro build missing at ${entry}. Run: pnpm build:web`);
  }
  const mod = (await import(pathToFileURL(entry).href)) as {
    render: WebRenderer;
  };
  return mod.render;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

/**
 * Hashed client assets plus the catch-all that hands everything Hono did not
 * match to Astro. Must be the last routes registered.
 */
export function webRoutes(
  deps: AppDeps,
): Hono<{ Variables: { user?: AuthUser | null } }> {
  // `user` is set by the auth middleware (Task 9) on the parent app; context
  // variables are shared with sub-apps, so it is visible here. Unset means signed out.
  const app = new Hono<{ Variables: { user?: AuthUser | null } }>();

  app.get("/_astro/:file", async (c) => {
    const file = c.req.param("file");
    // Build output names only: no separators, no dot-dot.
    if (!/^[\w.-]+$/.test(file) || file.includes("..")) return c.notFound();
    try {
      const body = await readFile(path.join(webDist, "client", "_astro", file));
      return c.body(body, 200, {
        "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": IMMUTABLE,
      });
    } catch {
      return c.notFound();
    }
  });

  app.all("*", async (c) => {
    if (!deps.web) return c.text("Not found", 404);
    const res = await deps.web(c.req.raw, {
      deps,
      user: c.get("user") ?? null,
    });
    return res ?? c.text("Not found", 404);
  });

  return app;
}
```

- [ ] **Step 7: Wire into `src/app.ts`**

Add `web?: WebRenderer` to `AppDeps` (import type from `./web/mount.js`), and register `webRoutes` **after** `app.get("/", …)`:

```ts
app.get("/", (c) => c.text("discord-uploader: run /upload in Discord."));
// Must stay the last route: it hands everything unmatched to Astro.
app.route("/", webRoutes(deps));
```

In `src/index.ts`, before `createApp`:

```ts
console.log("Loading web pages");
const web = await loadWebRenderer();
const app = createApp({ config, redis, fetch, web });
```

- [ ] **Step 8: Load the renderer in `test/helpers.ts`**

At module scope:

```ts
import { loadWebRenderer, type WebRenderer } from "../src/web/mount.js";

let webPromise: Promise<WebRenderer> | null = null;
/** Loaded once per worker; `pnpm test` builds web/dist first. */
export function sharedWebRenderer(): Promise<WebRenderer> {
  webPromise ??= loadWebRenderer();
  return webPromise;
}
```

In `makeHarness`, build deps as `const deps: AppDeps = { config, redis, fetch: fetchImpl, web: await sharedWebRenderer() };`.

- [ ] **Step 9: Write `Shell.astro` and `BrandBar.astro`**

`web/src/layouts/Shell.astro` (mirrors `pages.ts` `shell()` exactly):

```astro
---
interface Props {
  title: string;
  bodyAttrs?: Record<string, string>;
}
const { title, bodyAttrs = {} } = Astro.props;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>{title}</title>
    <link rel="icon" href="/assets/mascot-small.png" type="image/png" />
    <link rel="stylesheet" href="/assets/upload.css" />
    <slot name="head" />
  </head>
  <body {...bodyAttrs}>
    <slot />
  </body>
</html>
```

`web/src/components/BrandBar.astro`:

```astro
---
interface Props {
  name: string;
  sub: string;
}
const { name, sub } = Astro.props;
const hasEnd = Astro.slots.has("end");
---

<header class="bar">
  <img class="mark" src="/assets/mascot-small.png" alt="" width="48" height="48" />
  <div class="bar-title">
    <span class="bar-name">{name}</span>
    <span class="bar-sub">{sub}</span>
  </div>
  {hasEnd && (
    <div class="bar-end">
      <slot name="end" />
    </div>
  )}
</header>
```

- [ ] **Step 10: Write `web/src/pages/v/[id].astro`**

```astro
---
import Shell from "../../layouts/Shell.astro";
import BrandBar from "../../components/BrandBar.astro";
import { getRecord } from "@server/storage/store";
import { fileUrl } from "@server/discord/followup";

const { deps } = Astro.locals;
const record = await getRecord(deps.redis, Astro.params.id ?? "");
if (!record) {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
  });
}
const url = fileUrl(deps.config, record);
if (record.kind === "image") return Astro.redirect(url, 302);

Astro.response.headers.set("Cache-Control", "public, max-age=3600");
const title = record.name;
---

<Shell title={title}>
  <Fragment slot="head">
    <meta property="og:type" content="video.other" />
    <meta property="og:title" content={title} />
    <meta property="og:url" content={url} />
    <meta property="og:video" content={url} />
    <meta property="og:video:secure_url" content={url} />
    <meta property="og:video:type" content={record.mime} />
    <meta property="og:video:width" content={String(record.width)} />
    <meta property="og:video:height" content={String(record.height)} />
    <meta name="twitter:card" content="player" />
    <meta name="twitter:player:stream" content={url} />
    <meta name="twitter:player:stream:content_type" content={record.mime} />
    <meta name="twitter:player:width" content={String(record.width)} />
    <meta name="twitter:player:height" content={String(record.height)} />
  </Fragment>
  <BrandBar name={title} sub={`${record.width}×${record.height}`} />
  <main class="stage">
    <video controls playsinline preload="metadata" src={url}></video>
  </main>
</Shell>
```

- [ ] **Step 11: Delete the Hono `/v/:id` handler**

In `src/routes/files.ts`, delete the `app.get("/v/:id", …)` block and the `watchPage` and `escapeHtml` functions. Remove the now-unused imports (`brandBar`, `shell`, `fileUrl`, `FileRecord`).

- [ ] **Step 12: Scripts, ignores, Docker**

`package.json` scripts become:

```json
"dev": "concurrently -k -n web,server \"chokidar 'web/src/**/*' 'web/adapter/**/*' 'web/astro.config.mjs' -c 'pnpm build:web' --initial\" \"tsx watch --include web/dist/server/entry.mjs src/index.ts\"",
"build:web": "astro build --root web",
"build": "pnpm build:web && tsc -p tsconfig.json",
"start": "node dist/index.js",
"test": "pnpm build:web && vitest run",
"test:watch": "vitest",
"typecheck": "tsc -p tsconfig.json --noEmit && astro check --root web",
"e2e:server": "pnpm build:web && tsx test/e2e/server.ts",
"test:e2e": "playwright test"
```

`.gitignore` add `web/dist/` and `web/.astro/`. `.dockerignore` add `web/dist` and `web/.astro`.

In `Dockerfile`'s `build` stage, after `COPY src ./src` add `COPY web ./web` and `COPY public ./public`. In `runtime`, after `COPY --from=build /app/dist ./dist` add `COPY --from=build /app/web/dist ./web/dist`.

- [ ] **Step 13: Build and run all tests**

Run: `pnpm test`
Expected: the Astro build succeeds, and every existing test passes, including the four `GET /v/:id` tests in `test/integration.test.ts`.

- [ ] **Step 14: Visual check**

Run: `pnpm test:e2e`
Expected: 6 passed. The watch page matches its baseline.

- [ ] **Step 15: Typecheck and commit**

Run: `pnpm typecheck`. Expected: exit 0.

```bash
git add -A web src test/helpers.ts package.json pnpm-lock.yaml pnpm-workspace.yaml Dockerfile .gitignore .dockerignore
git commit -m "feat: render pages with Astro via a fetch-native adapter; move /v/:id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Upload page and expired component

**Files:**

- Create: `web/src/components/Expired.astro`, `web/src/pages/u/[sid].astro`, `public/measure.js`
- Modify: `public/upload.js`, `src/routes/assets.ts`, `src/assets.ts`, `src/routes/upload.ts`
- Delete: `public/upload.html`

**Interfaces:**

- Produces: `Expired.astro` props `{ explanation: string; command: "upload" | "gallery" }`. `public/measure.js` exports `readDimensions(file: File, url: string): Promise<{ width: number; height: number }>`, served at `/assets/measure.js`.

- [ ] **Step 1: Write `Expired.astro`** (mirrors `expiredShell`)

```astro
---
import Shell from "../layouts/Shell.astro";
import BrandBar from "./BrandBar.astro";
interface Props {
  explanation: string;
  command: "upload" | "gallery";
}
const { explanation, command } = Astro.props;
---

<Shell title="Link expired">
  <BrandBar name="Link expired" sub="Single use, 14 minutes" />
  <main class="centered">
    <div class="card panel">
      <div class="card-in">
        <header><h1>This link is done</h1></header>
        <p class="muted">{explanation}</p>
        <p class="muted">Run <code>/{command}</code> in Discord for a fresh one.</p>
      </div>
    </div>
  </main>
</Shell>
```

- [ ] **Step 2: Extract `readDimensions` into `public/measure.js`**

```js
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
```

In `public/upload.js`:

- Replace the leading `"use strict";` with `import { readDimensions } from "./measure.js";`. Modules are always strict.
- Delete the local `readDimensions` function together with its doc comment.

Everything else stays byte-for-byte.

In `src/assets.ts`:

- Add `measureJs: readText("measure.js"),`.
- Remove `uploadHtml`.

In `src/routes/assets.ts`, add after the `/assets/upload.js` route:

```ts
app.get("/assets/measure.js", (c) =>
  c.body(assets.measureJs, 200, {
    "Content-Type": SCRIPT,
    "Cache-Control": NO_CACHE,
  }),
);
```

- [ ] **Step 3: Write `web/src/pages/u/[sid].astro`**

```astro
---
import Shell from "../../layouts/Shell.astro";
import BrandBar from "../../components/BrandBar.astro";
import Expired from "../../components/Expired.astro";
import { getSession } from "@server/storage/sessions";
import { UPLOAD_PAGE_CSP } from "@server/web/csp";

const { deps } = Astro.locals;
const session = await getSession(deps.redis, Astro.params.sid ?? "");
const live = session !== null && session.kind === "upload";

Astro.response.headers.set("Content-Security-Policy", UPLOAD_PAGE_CSP);
if (live) Astro.response.headers.set("Cache-Control", "no-store");
else Astro.response.status = 404;
---

{
  !live || !session ? (
    <Expired
      explanation="This upload link has already been used or has run out of time."
      command="upload"
    />
  ) : (
    <Shell
      title="Upload"
      bodyAttrs={{
        "data-sid": session.sid,
        "data-expires-at": String(session.expiresAt),
        "data-max-bytes": String(deps.config.maxFileBytes),
      }}
    >
      <BrandBar name="Upload" sub="Images and videos">
        <Fragment slot="end">
          Expires in <span id="countdown" class="count">--:--</span>
        </Fragment>
      </BrandBar>
      <main class="centered">
        <div class="card panel">
          <div class="card-in">
            <label id="drop" class="drop" for="picker" tabindex="0">
              <span class="drop-title">Drop a file here</span>
              <span class="muted">or click to choose</span>
              <input
                id="picker"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm,video/quicktime"
                hidden
              />
            </label>
            <section id="preview" class="preview" hidden>
              <div id="preview-slot" />
              <p id="filename" class="muted" />
            </section>
            <div id="progress-wrap" class="progress" hidden>
              <div id="progress-bar" class="progress-bar" />
            </div>
            <p id="status" class="status" role="status" />
            <button id="send" class="button" type="button" disabled>Upload</button>
          </div>
        </div>
      </main>
      <script is:inline type="module" src="/assets/upload.js" />
    </Shell>
  )
}
```

- [ ] **Step 4: Remove the Hono page handler**

In `src/routes/upload.ts`:

- Delete `app.get("/u/:sid", …)` and the `expiredPage()` function.
- Drop the `UPLOAD_PAGE_CSP`, `assets` and `expiredShell` imports.

Delete `public/upload.html`.

- [ ] **Step 5: Tests and visual check**

Run: `pnpm test && pnpm test:e2e`
Expected: all vitest tests pass, including "serves the upload page for a live session", "404s for an unknown session" and "consumes the session…". All 6 e2e tests pass. The upload and expired-upload screenshots show zero diff.

- [ ] **Step 6: Manual smoke of the real upload flow**

Run: `pnpm e2e:server`, then mint a session with `curl -X POST 'localhost:4173/__e2e/session?kind=upload'` and open `http://localhost:4173/u/<sid>` in a browser.

- Drop a PNG and check the preview appears.
- Click Upload and check the status reads "Uploaded and posted to Discord…". The harness fetch mock returns 200.
- Check the browser console shows no errors, including no CSP violations.

- [ ] **Step 7: Commit**

```bash
git add -A web public src
git commit -m "feat: move the upload page and expired page to Astro

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Single-use gallery page

**Files:**

- Create: `src/web/format.ts`, `web/src/components/LegacyTile.astro`, `web/src/pages/g/[gid].astro`, `test/pages.test.ts`
- Modify: `src/routes/gallery.ts`, `src/assets.ts`
- Delete: `public/gallery.html`

**Interfaces:**

- Produces: `src/web/format.ts` exports `formatBytes(bytes: number): string`, `formatDate(ms: number): string` (`YYYY-MM-DD`, UTC), `expiryLabel(expiresAt: number, now?: number): string`, moved verbatim from `routes/gallery.ts`.

- [ ] **Step 1: Write the failing escaping test (Review Focus #3)**

`test/pages.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { createSession } from "../src/storage/sessions.js";
import { fileDir, saveRecord } from "../src/storage/store.js";
import type { FileRecord } from "../src/types.js";

let h: Harness;
afterEach(() => h?.cleanup());

const EVIL = `a"><img src=x onerror=alert(1)>.png`;

async function seed(record: Partial<FileRecord>): Promise<FileRecord> {
  const full: FileRecord = {
    id: "evilevilevilevilevilev",
    name: EVIL,
    mime: "image/png",
    kind: "image",
    size: 3,
    width: 1,
    height: 1,
    createdAt: Date.UTC(2026, 0, 1),
    expiresAt: 0,
    userId: "u1",
    channelId: "c1",
    ...record,
  };
  mkdirSync(fileDir(h.deps.config, full.id), { recursive: true });
  writeFileSync(path.join(fileDir(h.deps.config, full.id), full.name), "abc");
  await saveRecord(h.deps.redis, full);
  return full;
}

describe("page escaping", () => {
  it("escapes a hostile filename on the gallery page", async () => {
    h = await makeHarness();
    await seed({});
    const s = await createSession(h.deps.redis, {
      kind: "gallery",
      userId: "u1",
      channelId: "c1",
      guildId: "",
      interactionToken: "t",
      ttlMs: 0,
    });
    const res = await h.app.fetch(
      new Request(`https://uploader.test/g/${s.sid}`),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a hostile filename on the watch page", async () => {
    h = await makeHarness();
    await seed({
      kind: "video",
      mime: "video/mp4",
      name: `v"><script>x</script>.mp4`,
    });
    const res = await h.app.fetch(
      new Request("https://uploader.test/v/evilevilevilevilevilev"),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>x</script>");
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm build:web && pnpm vitest run test/pages.test.ts`
Expected: the watch-page case passes, because Astro already escapes. The gallery case passes too while the Hono builder still escapes. Keep it: it guards the migration in the next steps.

- [ ] **Step 3: Create `src/web/format.ts`**

Move the three helpers verbatim from `src/routes/gallery.ts`:

```ts
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Per-file lifetime, shown next to size and upload date on each tile. */
export function expiryLabel(expiresAt: number, now = Date.now()): string {
  if (!expiresAt) return "kept until full";
  const days = Math.ceil((expiresAt - now) / 86_400_000);
  if (days <= 0) return "expiring now";
  if (days === 1) return "deletes in 1 day";
  return `deletes in ${days} days`;
}
```

- [ ] **Step 4: Write `LegacyTile.astro`** (mirrors `tile()` exactly)

```astro
---
import type { Config } from "@server/config";
import type { FileRecord } from "@server/types";
import { fileUrl, watchUrl } from "@server/discord/followup";
import { formatBytes, formatDate, expiryLabel } from "@server/web/format";
interface Props {
  config: Config;
  file: FileRecord;
}
const { config, file } = Astro.props;
const direct = fileUrl(config, file);
// Videos link to the page that carries the player tags; images are their own shareable URL.
const share = file.kind === "video" ? watchUrl(config, file) : direct;
---

<figure
  class="tile panel"
  tabindex="0"
  role="gridcell"
  data-tile
  data-id={file.id}
  data-name={file.name}
  data-size={String(file.size)}
  data-created={String(file.createdAt)}
  data-expires={String(file.expiresAt)}
  data-href={share}
  aria-label={file.name}
>
  <div class="tile-in">
    <a class="shot" href={share} target="_blank" rel="noopener" tabindex="-1">
      {
        file.kind === "video" ? (
          <>
            <video preload="metadata" muted playsinline src={`${direct}#t=0.1`} />
            <span class="badge">VIDEO</span>
          </>
        ) : (
          <img loading="lazy" decoding="async" src={direct} alt={file.name} />
        )
      }
    </a>
    <div class="tile-body">
      <figcaption class="tile-name" title={file.name}>{file.name}</figcaption>
      <div class="tile-meta">
        <span>{formatBytes(file.size)}</span><span>{formatDate(file.createdAt)}</span><span
          class="tile-expiry"
          data-expiry>{expiryLabel(file.expiresAt)}</span
        >
      </div>
      <div class="tile-actions">
        <a class="button small" href={share} target="_blank" rel="noopener">Open</a>
        {
          file.kind === "video" ? (
            <>
              <button class="button small" type="button" data-copy={share}>Copy page</button>
              <button class="button small" type="button" data-copy={direct}>Copy direct</button>
            </>
          ) : (
            <button class="button small" type="button" data-copy={direct}>Copy link</button>
          )
        }
        <button class="button small danger" type="button" data-delete={file.id} data-name={file.name}>Delete</button>
      </div>
    </div>
  </div>
</figure>
```

- [ ] **Step 5: Write `web/src/pages/g/[gid].astro`**

```astro
---
import Shell from "../../layouts/Shell.astro";
import BrandBar from "../../components/BrandBar.astro";
import Expired from "../../components/Expired.astro";
import LegacyTile from "../../components/LegacyTile.astro";
import { claimSession, createActionToken } from "@server/storage/sessions";
import { expireDue, listUserFiles } from "@server/storage/store";
import { formatBytes } from "@server/web/format";
import { UPLOAD_PAGE_CSP } from "@server/web/csp";
import type { FileRecord } from "@server/types";

const { deps } = Astro.locals;
Astro.response.headers.set("Content-Security-Policy", UPLOAD_PAGE_CSP);

// Rendered in full on this one request, spending the session, so a reload
// correctly finds a dead link.
const claim = await claimSession(deps.redis, Astro.params.gid ?? "");
// A session opened by /upload must not be spendable here.
const live = claim.status === "ok" && claim.session.kind === "gallery";

let files: FileRecord[] = [];
let token = "";
if (live && claim.status === "ok") {
  await expireDue(deps.redis, deps.config);
  // Scoped to the invoker, so a leaked link still exposes only their own files.
  files = await listUserFiles(deps.redis, claim.session.userId);
  token = await createActionToken(deps.redis, claim.session.userId);
  Astro.response.headers.set("Cache-Control", "no-store");
} else {
  Astro.response.status = 404;
}
const bytes = files.reduce((total, f) => total + f.size, 0);
const summary = files.length > 0 ? `${formatBytes(bytes)}, newest first` : "Nothing stored yet";
const count = files.length > 0 ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "";
---

{
  !live ? (
    <Expired
      explanation="This gallery link has already been opened or has run out of time."
      command="gallery"
    />
  ) : (
    <Shell title="Your uploads" bodyAttrs={{ "data-token": token }}>
      <BrandBar name="Your uploads" sub={summary}>
        <span slot="end" class="count">{count}</span>
      </BrandBar>
      {files.length > 0 ? (
        <>
          <main class="gallery-main">
            <div class="toolbar">
              <label class="toolbar-label" for="filter">Filter</label>
              <input class="toolbar-input" type="search" id="filter" placeholder="Filter by filename" autocomplete="off" />
              <label class="toolbar-label" for="sort">Sort</label>
              <select class="toolbar-select" id="sort">
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="largest">Largest</option>
                <option value="smallest">Smallest</option>
                <option value="soonest">Soonest to expire</option>
              </select>
              <span class="toolbar-count" id="filterCount" />
            </div>
            <div class="sheet" id="sheet" role="grid" aria-label="Your uploads">
              {files.map((file) => <LegacyTile config={deps.config} file={file} />)}
            </div>
            <p class="sheet-empty" id="sheetEmpty" hidden>No files match that filter.</p>
          </main>
          <p class="sheet-note">Oldest files are cleared as storage fills. Keep your own copy of anything that matters.</p>
          <div class="sr-only" id="liveRegion" role="status" aria-live="assertive" aria-atomic="true" />
        </>
      ) : (
        <main class="empty">
          <img src="/assets/mascot.png" alt="" width="128" height="128" />
          <h2>No files yet</h2>
          <p class="muted">Run <code>/upload</code> in Discord and whatever you send lands here.</p>
        </main>
      )}
      <script is:inline type="module" src="/assets/gallery.js" />
    </Shell>
  )
}
```

Note: the original `gallery.html` put the count inside `<div class="bar-end"><span class="count">…</span></div>`. `BrandBar` wraps the `end` slot in `.bar-end`, so the markup is the same. The original emitted `.bar-end` even when the count was empty, and so does this.

- [ ] **Step 6: Remove the Hono page handler**

In `src/routes/gallery.ts`:

- Delete `app.get("/g/:gid", …)` and the functions `sheet`, `tile`, `emptyState`, `formatBytes`, `formatDate`, `expiryLabel`, `expiredPage` and `escapeHtml`.
- Keep `DELETE /api/files/:id`.
- Remove the unused imports.

In `src/assets.ts`, remove `galleryHtml`. Delete `public/gallery.html`.

- [ ] **Step 7: Tests and visual check**

Run: `pnpm test && pnpm test:e2e`
Expected: every vitest test passes, including all of `test/gallery.test.ts`, the "consumes the gallery session" test in integration, and the new escaping tests. The e2e gallery, gallery-empty and expired-gallery screenshots show zero diff.

If a screenshot differs because of whitespace between inline elements, which Astro may collapse differently: match the original's whitespace inside the `.tile-meta` spans. Those three spans are the only whitespace-sensitive spot, which is why Step 4 keeps them on one line.

- [ ] **Step 8: Commit**

```bash
git add -A web public src test/pages.test.ts
git commit -m "feat: move the single-use gallery to Astro

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Remove the string-template layer and enable Astro CSP

**Files:**

- Delete: `src/pages.ts`
- Modify: `web/astro.config.mjs`, `src/web/csp.ts`

**Interfaces:**

- Produces: `DASHBOARD_CSP` in `src/web/csp.ts`, which Tasks 13 and 14 use.

- [ ] **Step 1: Confirm `pages.ts` has no importers, then delete it**

Run: `grep -rn "pages.js" src test`
Expected: no output. Then run `git rm src/pages.ts`.

- [ ] **Step 2: Enable Astro's CSP**

In `web/astro.config.mjs`, add at the top level:

```js
  security: {
    csp: {
      algorithm: "SHA-256",
      scriptDirective: { resources: ["'self'"] },
      styleDirective: { resources: ["'self'", "'unsafe-inline'"] },
    },
  },
```

If `astro build` rejects `security.csp` as unknown, move the same object under `experimental: { csp: { … } }`.

- [ ] **Step 3: Add `DASHBOARD_CSP`**

In `src/web/csp.ts`:

```ts
/**
 * Header policy for the login and dashboard pages. Astro adds a <meta> policy
 * carrying the hashes of its inline island scripts; browsers enforce both, so
 * the effective script policy is 'self' plus those hashes. Styles allow
 * 'unsafe-inline' because Motion and React write style attributes.
 */
export const DASHBOARD_CSP =
  "default-src 'self'; img-src 'self' blob: data: https://cdn.discordapp.com; media-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; " +
  "form-action 'self' https://discord.com; base-uri 'none'; frame-ancestors 'none'";
```

- [ ] **Step 4: Verify the built CSP meta**

Run: `pnpm build:web && pnpm e2e:server`. In another shell:

```bash
curl -s -X POST 'localhost:4173/__e2e/session?kind=upload' | tee /dev/stderr
curl -s localhost:4173/u/<sid> | grep -o '<meta http-equiv="content-security-policy"[^>]*>'
```

Expected: a meta tag whose `style-src` has **no** `sha256-` entries (because `inlineStylesheets: "never"`) and whose `script-src` includes `'self'`. If style hashes appear, find the inline `<style>` in the output and remove its source.

- [ ] **Step 5: Full check**

Run: `pnpm test && pnpm test:e2e && pnpm typecheck`
Expected: all green, zero screenshot diffs.

- [ ] **Step 6: Commit**

```bash
git add -A src web
git commit -m "refactor: drop the HTML string templates; enable Astro CSP hashing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Phase 2 — Auth, usage tracking, `/api/me`

### Task 7: Config and test-harness plumbing

**Files:**

- Modify: `src/config.ts`, `test/helpers.ts`, `.env.example`

**Interfaces:**

- Produces:
  - `Config.discordClientSecret: string`. An empty string means sign-in is disabled.
  - `Harness.respond: FetchRoute[]`, where `type FetchRoute = (url: string, init?: RequestInit) => Response | undefined`. The first route that returns a Response wins; otherwise the mock returns `200 {}` as before.
  - `calls[].body` is parsed JSON, or an object from a form body, or `null`.

- [ ] **Step 1: Write the failing config test**

Append to `test/config.test.ts` (new test only; existing tests are untouched):

```ts
describe("DISCORD_CLIENT_SECRET", () => {
  const base = {
    DISCORD_APP_ID: "1",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_BOT_TOKEN: "t",
    PUBLIC_URL: "https://x.test",
    REDIS_URL: "redis://r",
  };
  it("is optional and defaults to empty", () => {
    expect(loadConfig(base).discordClientSecret).toBe("");
  });
  it("is read and trimmed when set", () => {
    expect(
      loadConfig({ ...base, DISCORD_CLIENT_SECRET: " s3cret " })
        .discordClientSecret,
    ).toBe("s3cret");
  });
});
```

(Import `describe`, `expect`, `it` and `loadConfig` if the file doesn't already.)

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL. `discordClientSecret` is undefined.

- [ ] **Step 3: Implement**

In `Config` add:

```ts
/** OAuth2 client secret for dashboard sign-in. Empty disables sign-in; the bot is unaffected. */
discordClientSecret: string;
```

In `loadConfig`'s return object add `discordClientSecret: env.DISCORD_CLIENT_SECRET?.trim() || "",`.

In `.env.example`, after `DISCORD_BOT_TOKEN=`, add:

```
# OAuth2 client secret (Developer Portal -> OAuth2). Enables dashboard sign-in.
# Also add {PUBLIC_URL}/auth/callback as a redirect URI there. Empty disables sign-in.
DISCORD_CLIENT_SECRET=
```

- [ ] **Step 4: Upgrade the harness fetch mock**

In `test/helpers.ts`:

```ts
export type FetchRoute = (
  url: string,
  init?: RequestInit,
) => Response | undefined;

function parseBody(body: RequestInit["body"]): any {
  if (body == null) return null;
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  const text = String(body);
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}
```

- Add `respond: FetchRoute[]` to `Harness`.
- Add `discordClientSecret: "test-secret",` to `testConfig`'s defaults.
- Replace the body of `fetchImpl` with:

```ts
const respond: FetchRoute[] = [];
const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), body: parseBody(init?.body) });
  for (const route of respond) {
    const hit = route(String(url), init);
    if (hit) return hit;
  }
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;
```

and return `respond` from `makeHarness`.

- [ ] **Step 5: Run everything**

Run: `pnpm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/helpers.ts test/config.test.ts .env.example
git commit -m "feat: add optional DISCORD_CLIENT_SECRET; let tests script fetch responses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Auth sessions and OAuth helpers

**Files:**

- Create: `src/auth/types.ts`, `src/auth/sessions.ts`, `src/auth/oauth.ts`
- Modify: `src/web/mount.ts` (import `AuthUser` from `../auth/types.js`, delete the local interface)
- Test: `test/auth.test.ts`

**Interfaces:**

- Produces:
  - `src/auth/types.ts`:
    - `interface AuthUser { id: string; username: string; globalName: string; avatar: string }`
    - `type AuthEnv = { Variables: { user: AuthUser | null } }`
  - `src/auth/sessions.ts`:
    - `AUTH_SESSION_TTL_SECONDS = 2_592_000`, `REFRESH_BELOW_SECONDS = 2_505_600`
    - `digest(token: string): string`
    - `createAuthSession(redis, user: AuthUser, now?): Promise<string>`, which returns the raw token
    - `readAuthSession(redis, token): Promise<{ user: AuthUser; refreshed: boolean } | null>`
    - `deleteAuthSession(redis, token): Promise<void>`
    - `deleteAllAuthSessions(redis, userId): Promise<number>`
  - `src/auth/oauth.ts`:
    - `STATE_TTL_SECONDS = 600`
    - `safeNext(raw: string | undefined): string`
    - `createOAuthState(redis, next): Promise<string>`
    - `consumeOAuthState(redis, state): Promise<string | null>`
    - `redirectUri(config): string`
    - `authorizeUrl(config, state): string`
    - `class OAuthError extends Error`
    - `exchangeCode(config, fetchImpl, code): Promise<AuthUser>`

- [ ] **Step 1: Write the failing tests**

`test/auth.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";
import {
  AUTH_SESSION_TTL_SECONDS,
  createAuthSession,
  deleteAllAuthSessions,
  deleteAuthSession,
  digest,
  readAuthSession,
} from "../src/auth/sessions.js";
import {
  authorizeUrl,
  consumeOAuthState,
  createOAuthState,
  exchangeCode,
  OAuthError,
  safeNext,
} from "../src/auth/oauth.js";

let h: Harness;
afterEach(() => h?.cleanup());

const alice = {
  id: "111",
  username: "alice",
  globalName: "Alice",
  avatar: "abc",
};

describe("safeNext", () => {
  it.each([
    [undefined, "/dashboard"],
    ["", "/dashboard"],
    ["/dashboard/usage?range=7d", "/dashboard/usage?range=7d"],
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["https://evil.com", "/dashboard"],
    ["/%2F%2Fevil.com", "/dashboard"],
    ["dashboard", "/dashboard"],
    ["/ok#frag", "/ok#frag"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

describe("auth sessions", () => {
  it("stores only a digest of the token", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    expect(await h.deps.redis.exists(`auth:${token}`)).toBe(0);
    expect(await h.deps.redis.exists(`auth:${digest(token)}`)).toBe(1);
    expect(await h.deps.redis.ttl(`auth:${digest(token)}`)).toBeGreaterThan(
      AUTH_SESSION_TTL_SECONDS - 5,
    );
  });

  it("reads back the user without refreshing a fresh session", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    expect(await readAuthSession(h.deps.redis, token)).toEqual({
      user: alice,
      refreshed: false,
    });
  });

  it("slides the expiry once less than 29 days remain", async () => {
    h = await makeHarness();
    const token = await createAuthSession(h.deps.redis, alice);
    await h.deps.redis.expire(`auth:${digest(token)}`, 86_400);
    const found = await readAuthSession(h.deps.redis, token);
    expect(found?.refreshed).toBe(true);
    expect(await h.deps.redis.ttl(`auth:${digest(token)}`)).toBeGreaterThan(
      AUTH_SESSION_TTL_SECONDS - 5,
    );
  });

  it("returns null for unknown, expired or empty tokens", async () => {
    h = await makeHarness();
    expect(await readAuthSession(h.deps.redis, "nope")).toBeNull();
    expect(await readAuthSession(h.deps.redis, "")).toBeNull();
  });

  it("deletes one session, or every session for a user", async () => {
    h = await makeHarness();
    const a = await createAuthSession(h.deps.redis, alice);
    const b = await createAuthSession(h.deps.redis, alice);
    await deleteAuthSession(h.deps.redis, a);
    expect(await readAuthSession(h.deps.redis, a)).toBeNull();
    expect(await readAuthSession(h.deps.redis, b)).not.toBeNull();
    const c = await createAuthSession(h.deps.redis, alice);
    expect(await deleteAllAuthSessions(h.deps.redis, alice.id)).toBe(2);
    expect(await readAuthSession(h.deps.redis, b)).toBeNull();
    expect(await readAuthSession(h.deps.redis, c)).toBeNull();
  });
});

describe("oauth state", () => {
  it("is single use and remembers next", async () => {
    h = await makeHarness();
    const state = await createOAuthState(h.deps.redis, "/dashboard/usage");
    expect(await consumeOAuthState(h.deps.redis, state)).toBe(
      "/dashboard/usage",
    );
    expect(await consumeOAuthState(h.deps.redis, state)).toBeNull();
  });

  it("builds the authorize URL with identify scope and our callback", async () => {
    h = await makeHarness();
    const url = new URL(authorizeUrl(h.deps.config, "st"));
    expect(url.origin + url.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(h.deps.config.discordAppId);
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://uploader.test/auth/callback",
    );
  });
});

describe("exchangeCode", () => {
  it("trades the code and returns only identity fields", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "at", token_type: "Bearer" })
        : undefined,
    );
    h.respond.push((url) =>
      url.endsWith("/users/@me")
        ? Response.json({
            id: "111",
            username: "alice",
            global_name: "Alice",
            avatar: "abc",
            email: "x@y",
          })
        : undefined,
    );
    const user = await exchangeCode(h.deps.config, h.deps.fetch, "the-code");
    expect(user).toEqual(alice);
    const tokenCall = h.calls.find((c) => c.url.endsWith("/oauth2/token"))!;
    expect(tokenCall.body).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: h.deps.config.discordAppId,
      client_secret: "test-secret",
      redirect_uri: "https://uploader.test/auth/callback",
    });
  });

  it("throws OAuthError when Discord fails", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? new Response("no", { status: 500 })
        : undefined,
    );
    await expect(
      exchangeCode(h.deps.config, h.deps.fetch, "x"),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/auth.test.ts`
Expected: FAIL. The modules don't exist yet.

- [ ] **Step 3: Implement `src/auth/types.ts`**

```ts
/** Identity kept from Discord's /users/@me. Nothing else about the user is stored. */
export interface AuthUser {
  id: string;
  username: string;
  globalName: string;
  /** Avatar hash, or "" when the user has none. */
  avatar: string;
}

export type AuthEnv = { Variables: { user: AuthUser | null } };
```

- [ ] **Step 4: Implement `src/auth/sessions.ts`**

```ts
import type { Redis } from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import type { AuthUser } from "./types.js";

export const AUTH_SESSION_TTL_SECONDS = 30 * 86_400;
/** Only rewrite the expiry once a day has been used, so reads stay read-only. */
export const REFRESH_BELOW_SECONDS = 29 * 86_400;

/**
 * Sessions are keyed by a digest of the cookie value, so a Redis dump or a
 * `KEYS auth:*` never yields a usable cookie.
 */
export function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const key = (d: string) => `auth:${d}`;
const userKey = (userId: string) => `auth:user:${userId}`;

export async function createAuthSession(
  redis: Redis,
  user: AuthUser,
  now = Date.now(),
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const d = digest(token);
  await redis
    .multi()
    .hset(key(d), {
      userId: user.id,
      username: user.username,
      globalName: user.globalName,
      avatar: user.avatar,
      createdAt: String(now),
    })
    .expire(key(d), AUTH_SESSION_TTL_SECONDS)
    .sadd(userKey(user.id), d)
    .expire(userKey(user.id), AUTH_SESSION_TTL_SECONDS)
    .exec();
  return token;
}

export async function readAuthSession(
  redis: Redis,
  token: string,
): Promise<{ user: AuthUser; refreshed: boolean } | null> {
  if (!token) return null;
  const d = digest(token);
  const raw = await redis.hgetall(key(d));
  if (!raw || !raw.userId) return null;

  const user: AuthUser = {
    id: raw.userId,
    username: raw.username ?? "",
    globalName: raw.globalName ?? "",
    avatar: raw.avatar ?? "",
  };

  const ttl = await redis.ttl(key(d));
  if (ttl >= 0 && ttl < REFRESH_BELOW_SECONDS) {
    await redis
      .multi()
      .expire(key(d), AUTH_SESSION_TTL_SECONDS)
      .expire(userKey(user.id), AUTH_SESSION_TTL_SECONDS)
      .exec();
    return { user, refreshed: true };
  }
  return { user, refreshed: false };
}

export async function deleteAuthSession(
  redis: Redis,
  token: string,
): Promise<void> {
  if (!token) return;
  const d = digest(token);
  const userId = await redis.hget(key(d), "userId");
  const tx = redis.multi().del(key(d));
  if (userId) tx.srem(userKey(userId), d);
  await tx.exec();
}

/** "Sign out everywhere". Returns how many live sessions were ended. */
export async function deleteAllAuthSessions(
  redis: Redis,
  userId: string,
): Promise<number> {
  const digests = await redis.smembers(userKey(userId));
  let ended = 0;
  for (const d of digests) ended += await redis.del(key(d));
  await redis.del(userKey(userId));
  return ended;
}
```

- [ ] **Step 5: Implement `src/auth/oauth.ts`**

```ts
import type { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { AuthUser } from "./types.js";

export const STATE_TTL_SECONDS = 600;
const DEFAULT_NEXT = "/dashboard";
const API = "https://discord.com/api/v10";

export class OAuthError extends Error {}

/**
 * Only same-origin paths survive. Browsers treat "\" like "/", so "/\evil.com"
 * is as dangerous as "//evil.com"; percent-encoded slashes are decoded first.
 */
export function safeNext(raw: string | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return DEFAULT_NEXT;
  }
  if (!decoded.startsWith("/")) return DEFAULT_NEXT;
  if (decoded.startsWith("//") || decoded.includes("\\")) return DEFAULT_NEXT;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(decoded)) return DEFAULT_NEXT;
  return raw;
}

const stateKey = (state: string) => `oauth:state:${state}`;

export async function createOAuthState(
  redis: Redis,
  next: string,
): Promise<string> {
  const state = randomBytes(16).toString("base64url");
  await redis.set(stateKey(state), next, "EX", STATE_TTL_SECONDS);
  return state;
}

/** Atomic read-and-delete, so each state works exactly once. */
export async function consumeOAuthState(
  redis: Redis,
  state: string,
): Promise<string | null> {
  if (!state) return null;
  const [[, value]] = (await redis
    .multi()
    .get(stateKey(state))
    .del(stateKey(state))
    .exec()) as [[Error | null, string | null], [Error | null, number]];
  return value ?? null;
}

export function redirectUri(config: Config): string {
  return `${config.publicUrl}/auth/callback`;
}

export function authorizeUrl(config: Config, state: string): string {
  const q = new URLSearchParams({
    client_id: config.discordAppId,
    response_type: "code",
    scope: "identify",
    redirect_uri: redirectUri(config),
    state,
    prompt: "none",
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

/**
 * Trade the code for a token, read the identity, and drop the token: the
 * dashboard never calls Discord on the user's behalf.
 */
export async function exchangeCode(
  config: Config,
  fetchImpl: typeof fetch,
  code: string,
): Promise<AuthUser> {
  let tokenRes: Response;
  try {
    tokenRes = await fetchImpl(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.discordAppId,
        client_secret: config.discordClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(config),
      }),
    });
  } catch (err) {
    throw new OAuthError(`Token request failed: ${(err as Error).message}`);
  }
  if (!tokenRes.ok)
    throw new OAuthError(`Token exchange returned ${tokenRes.status}`);
  const token = (await tokenRes.json()) as {
    access_token?: string;
    token_type?: string;
  };
  if (!token.access_token)
    throw new OAuthError("Token response had no access_token");

  let meRes: Response;
  try {
    meRes = await fetchImpl(`${API}/users/@me`, {
      headers: {
        Authorization: `${token.token_type ?? "Bearer"} ${token.access_token}`,
      },
    });
  } catch (err) {
    throw new OAuthError(`/users/@me failed: ${(err as Error).message}`);
  }
  if (!meRes.ok) throw new OAuthError(`/users/@me returned ${meRes.status}`);
  const me = (await meRes.json()) as {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
  };
  if (!me.id) throw new OAuthError("/users/@me had no id");
  return {
    id: me.id,
    username: me.username ?? "",
    globalName: me.global_name ?? "",
    avatar: me.avatar ?? "",
  };
}
```

- [ ] **Step 6: Point `mount.ts` at the shared type**

In `src/web/mount.ts`, delete the local `AuthUser` interface and add `import type { AuthUser } from "../auth/types.js";`, plus `export type { AuthUser };` so `web/src/env.d.ts` keeps resolving.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run test/auth.test.ts && pnpm typecheck`
Expected: all PASS, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/auth src/web/mount.ts test/auth.test.ts
git commit -m "feat: add hashed auth sessions and Discord OAuth helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Auth middleware and routes

**Files:**

- Create: `src/auth/cookies.ts`, `src/auth/middleware.ts`, `src/routes/auth.ts`
- Modify: `src/app.ts`
- Test: `test/auth.test.ts` (append)

**Interfaces:**

- Consumes: everything from Task 8.
- Produces:
  - `SESSION_COOKIE = "session"` and `STATE_COOKIE = "oauth_state"`, both used with Hono's `prefix: "host"`, so the real names are `__Host-session` and `__Host-oauth_state`.
  - `setSessionCookie(c, token)`, `clearSessionCookie(c)`, `readSessionCookie(c): string`.
  - `loadUser(deps)`, `requireApiUser`, `requirePageUser`, `sameOrigin(config)`.
  - `authRoutes(deps)`.
  - `createApp` now returns `Hono<AuthEnv>`.

- [ ] **Step 1: Write the failing route tests**

Append to `test/auth.test.ts`:

```ts
import { createAuthSession as mkSession } from "../src/auth/sessions.js";

function cookieFrom(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie();
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0]?.slice(name.length + 1);
}

const ORIGIN = { Origin: "https://uploader.test" };

describe("GET /auth/login", () => {
  it("redirects to Discord with a state that matches a __Host- cookie", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/login?next=/dashboard/usage"),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    const state = loc.searchParams.get("state")!;
    expect(cookieFrom(res, "__Host-oauth_state")).toBe(state);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/__Host-oauth_state=.*HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(await h.deps.redis.get(`oauth:state:${state}`)).toBe(
      "/dashboard/usage",
    );
  });

  it("goes to /login when sign-in is not configured", async () => {
    h = await makeHarness({ discordClientSecret: "" });
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/login"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("GET /auth/callback", () => {
  function discordOk(h: Harness) {
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "at" })
        : undefined,
    );
    h.respond.push((url) =>
      url.endsWith("/users/@me")
        ? Response.json({
            id: "111",
            username: "alice",
            global_name: "Alice",
            avatar: null,
          })
        : undefined,
    );
  }

  async function begin(h: Harness, next = "/dashboard") {
    const res = await h.app.fetch(
      new Request(
        `https://uploader.test/auth/login?next=${encodeURIComponent(next)}`,
      ),
    );
    const state = new URL(res.headers.get("location")!).searchParams.get(
      "state",
    )!;
    return state;
  }

  it("signs in and redirects to next", async () => {
    h = await makeHarness();
    discordOk(h);
    const state = await begin(h, "/dashboard/usage");
    const res = await h.app.fetch(
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: `__Host-oauth_state=${state}` },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/usage");
    const token = cookieFrom(res, "__Host-session")!;
    expect(token).toBeTruthy();
    expect(res.headers.getSetCookie().join("\n")).toMatch(
      /__Host-session=.*HttpOnly.*|HttpOnly.*__Host-session/s,
    );
  });

  it("rejects a state that does not match the cookie", async () => {
    h = await makeHarness();
    discordOk(h);
    const state = await begin(h);
    const res = await h.app.fetch(
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: "__Host-oauth_state=other" },
      }),
    );
    expect(res.headers.get("location")).toBe("/login?error=expired");
  });

  it("rejects a reused state", async () => {
    h = await makeHarness();
    discordOk(h);
    const state = await begin(h);
    const req = () =>
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: `__Host-oauth_state=${state}` },
      });
    await h.app.fetch(req());
    const second = await h.app.fetch(req());
    expect(second.headers.get("location")).toBe("/login?error=expired");
  });

  it("maps a cancelled consent to error=cancelled", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/callback?error=access_denied"),
    );
    expect(res.headers.get("location")).toBe("/login?error=cancelled");
  });

  it("maps a Discord failure to error=discord", async () => {
    h = await makeHarness();
    h.respond.push((url) =>
      url.endsWith("/oauth2/token")
        ? new Response("x", { status: 500 })
        : undefined,
    );
    const state = await begin(h);
    const res = await h.app.fetch(
      new Request(`https://uploader.test/auth/callback?code=c&state=${state}`, {
        headers: { Cookie: `__Host-oauth_state=${state}` },
      }),
    );
    expect(res.headers.get("location")).toBe("/login?error=discord");
  });
});

describe("session cookie handling", () => {
  it("treats a stale cookie as signed out and clears it", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/api/me", {
        headers: { Cookie: "__Host-session=stale" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join("\n")).toMatch(
      /__Host-session=;.*Max-Age=0/,
    );
  });

  it("redirects /dashboard to login with next when signed out", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request("https://uploader.test/dashboard/usage?range=7d"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent("/dashboard/usage?range=7d")}`,
    );
  });

  it("refuses a cross-origin POST", async () => {
    h = await makeHarness();
    const token = await mkSession(h.deps.redis, alice);
    const res = await h.app.fetch(
      new Request("https://uploader.test/auth/logout", {
        method: "POST",
        headers: {
          Cookie: `__Host-session=${token}`,
          Origin: "https://evil.test",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(await readAuthSession(h.deps.redis, token)).not.toBeNull();
  });

  it("logs out one session, or all with everywhere=1", async () => {
    h = await makeHarness();
    const a = await mkSession(h.deps.redis, alice);
    const b = await mkSession(h.deps.redis, alice);
    const out = await h.app.fetch(
      new Request("https://uploader.test/auth/logout", {
        method: "POST",
        headers: { Cookie: `__Host-session=${a}`, ...ORIGIN },
      }),
    );
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/login?signedout=1");
    expect(await readAuthSession(h.deps.redis, a)).toBeNull();
    expect(await readAuthSession(h.deps.redis, b)).not.toBeNull();

    const body = new URLSearchParams({ everywhere: "1" });
    await h.app.fetch(
      new Request("https://uploader.test/auth/logout", {
        method: "POST",
        body,
        headers: {
          Cookie: `__Host-session=${b}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...ORIGIN,
        },
      }),
    );
    expect(await readAuthSession(h.deps.redis, b)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/auth.test.ts`
Expected: the route tests FAIL (404 or 401 mismatches).

- [ ] **Step 3: Implement `src/auth/cookies.ts`**

```ts
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AUTH_SESSION_TTL_SECONDS } from "./sessions.js";
import { STATE_TTL_SECONDS } from "./oauth.js";

export const SESSION_COOKIE = "session";
export const STATE_COOKIE = "oauth_state";

const BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  prefix: "host",
} as const;

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    ...BASE,
    maxAge: AUTH_SESSION_TTL_SECONDS,
  });
}
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, BASE);
}
export function readSessionCookie(c: Context): string {
  return getCookie(c, SESSION_COOKIE, "host") ?? "";
}
export function setStateCookie(c: Context, state: string): void {
  setCookie(c, STATE_COOKIE, state, { ...BASE, maxAge: STATE_TTL_SECONDS });
}
export function takeStateCookie(c: Context): string {
  const value = getCookie(c, STATE_COOKIE, "host") ?? "";
  deleteCookie(c, STATE_COOKIE, BASE);
  return value;
}
```

- [ ] **Step 4: Implement `src/auth/middleware.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import type { AppDeps } from "../app.js";
import type { Config } from "../config.js";
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from "./cookies.js";
import { readAuthSession } from "./sessions.js";
import type { AuthEnv } from "./types.js";

/** Resolves the session cookie to a user. Never throws: a Redis error means "signed out". */
export function loadUser(deps: AppDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    c.set("user", null);
    const token = readSessionCookie(c);
    if (token) {
      try {
        const found = await readAuthSession(deps.redis, token);
        if (found) {
          c.set("user", found.user);
          if (found.refreshed) setSessionCookie(c, token);
        } else {
          clearSessionCookie(c);
        }
      } catch (err) {
        console.error("Failed to read auth session:", err);
      }
    }
    await next();
  };
}

export const requireApiUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Not signed in" }, 401);
  await next();
};

export const requirePageUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get("user")) return next();
  const url = new URL(c.req.url);
  return c.redirect(
    `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
    302,
  );
};

/** Belt and braces on top of SameSite=Lax for every state-changing request. */
export function sameOrigin(config: Config): MiddlewareHandler {
  const expected = new URL(config.publicUrl).origin;
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    if (c.req.header("origin") !== expected) {
      return c.json({ error: "Cross-origin request refused" }, 403);
    }
    await next();
  };
}
```

- [ ] **Step 5: Implement `src/routes/auth.ts`**

```ts
import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import {
  readSessionCookie,
  clearSessionCookie,
  setSessionCookie,
  setStateCookie,
  takeStateCookie,
} from "../auth/cookies.js";
import {
  authorizeUrl,
  consumeOAuthState,
  createOAuthState,
  exchangeCode,
  safeNext,
} from "../auth/oauth.js";
import {
  createAuthSession,
  deleteAllAuthSessions,
  deleteAuthSession,
} from "../auth/sessions.js";
import type { AuthEnv } from "../auth/types.js";

export function authRoutes(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/auth/login", async (c) => {
    if (!deps.config.discordClientSecret) return c.redirect("/login", 302);
    const next = safeNext(c.req.query("next"));
    if (c.get("user")) return c.redirect(next, 302);
    const state = await createOAuthState(deps.redis, next);
    setStateCookie(c, state);
    return c.redirect(authorizeUrl(deps.config, state), 302);
  });

  app.get("/auth/callback", async (c) => {
    const cookieState = takeStateCookie(c);
    if (c.req.query("error")) return c.redirect("/login?error=cancelled", 302);

    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    if (!state || !code || state !== cookieState)
      return c.redirect("/login?error=expired", 302);
    const next = await consumeOAuthState(deps.redis, state);
    if (next === null) return c.redirect("/login?error=expired", 302);

    let user;
    try {
      user = await exchangeCode(deps.config, deps.fetch, code);
    } catch (err) {
      console.error("Discord sign-in failed:", err);
      return c.redirect("/login?error=discord", 302);
    }

    const token = await createAuthSession(deps.redis, user);
    setSessionCookie(c, token);
    console.log(`Signed in ${user.id}`);
    return c.redirect(next, 302);
  });

  app.post("/auth/logout", async (c) => {
    const user = c.get("user");
    const form = await c.req
      .parseBody()
      .catch(() => ({}) as Record<string, unknown>);
    if (form.everywhere === "1" && user) {
      await deleteAllAuthSessions(deps.redis, user.id);
    } else {
      await deleteAuthSession(deps.redis, readSessionCookie(c));
    }
    clearSessionCookie(c);
    return c.redirect("/login?signedout=1", 302);
  });

  return app;
}
```

- [ ] **Step 6: Wire into `src/app.ts`**

```ts
export function createApp(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Only these paths look at the session cookie, so image and file requests
  // never cost a Redis read.
  for (const path of ["/auth/*", "/api/me", "/api/me/*", "/dashboard", "/dashboard/*", "/login"]) {
    app.use(path, loadUser(deps));
  }
  app.use("/auth/*", sameOrigin(deps.config));
  app.use("/api/me/*", sameOrigin(deps.config));
  app.use("/dashboard", requirePageUser);
  app.use("/dashboard/*", requirePageUser);

  app.route("/", assetRoutes());
  app.route("/", healthRoutes(deps));
  app.route("/", authRoutes(deps));
  // … existing routes unchanged …
```

(`/api/me` is added in Task 12. Until then the stale-cookie test's `/api/me` falls through to the web 404, so add a temporary `app.get("/api/me", requireApiUser, (c) => c.json({ user: c.get("user") }))` here. Task 12 replaces it with `meRoutes`.)

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/auth src/routes/auth.ts src/app.ts test/auth.test.ts
git commit -m "feat: Discord sign-in with login, callback and logout routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Per-user usage tracking, seeding, and rate-limit peek

**Files:**

- Modify: `src/storage/usage.ts`, `src/storage/ratelimit.ts`, `src/index.ts`
- Test: `test/usage-user.test.ts`

**Interfaces:**

- Produces (all in `src/storage/usage.ts` unless noted):
  - Constants and helpers:
    - `USER_DAY_KEY(uid, day)`, `USER_CMDS_KEY(uid)`
    - `USAGE_SINCE_KEY = "usage:since"`, `USAGE_SEEDED_KEY = "usage:seeded:v1"`, `DAY_TTL_SECONDS = 8_640_000`
    - `utcDay(ms: number): string`, which returns `YYYY-MM-DD`
  - Writers:
    - `recordCommandUse(redis, command, userId?, now = Date.now())`: same signature, plus per-user writes.
    - `recordUpload(redis, userId, bytes, now = Date.now()): Promise<void>`
    - `markUsageSince(redis, now = Date.now()): Promise<void>`
    - `seedUsageFromFiles(redis, now = Date.now()): Promise<number | null>`, which returns `null` when seeding already ran.
  - Reader:
    - `interface DailyPoint { date: string; uploads: number; bytes: number }`
    - `interface UserUsage { series: DailyPoint[]; previous: { uploads: number; bytes: number }; commandsInRange: Record<string, number>; commandsAllTime: Record<string, number>; trackingSince: number }`
    - `getUserUsage(redis, userId, days: number, now = Date.now()): Promise<UserUsage>`
  - `src/storage/ratelimit.ts`: `peekRateLimit(redis, scope, userId, limit, now = Date.now()): Promise<RateLimitResult>`

- [ ] **Step 1: Write the failing tests**

`test/usage-user.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";
import {
  DAY_TTL_SECONDS,
  getUserUsage,
  markUsageSince,
  recordCommandUse,
  recordUpload,
  seedUsageFromFiles,
  USER_DAY_KEY,
  utcDay,
} from "../src/storage/usage.js";
import { checkRateLimit, peekRateLimit } from "../src/storage/ratelimit.js";
import { saveRecord } from "../src/storage/store.js";

let h: Harness;
afterEach(() => h?.cleanup());

const NOW = Date.UTC(2026, 8, 27, 23, 59, 30); // 30s before UTC midnight
const DAY = 86_400_000;

describe("per-user usage", () => {
  it("writes daily and all-time command counts with a TTL", async () => {
    h = await makeHarness();
    await recordCommandUse(h.deps.redis, "upload", "u1", NOW);
    await recordCommandUse(h.deps.redis, "upload", "u1", NOW);
    await recordCommandUse(h.deps.redis, "gallery", "u1", NOW);
    const key = USER_DAY_KEY("u1", "2026-09-27");
    expect(await h.deps.redis.hgetall(key)).toEqual({
      "cmd:upload": "2",
      "cmd:gallery": "1",
    });
    expect(await h.deps.redis.ttl(key)).toBeGreaterThan(DAY_TTL_SECONDS - 5);
    expect(await h.deps.redis.hgetall("usage:u1:cmds")).toEqual({
      upload: "2",
      gallery: "1",
    });
  });

  it("zero-fills the series and ends on today even across midnight", async () => {
    h = await makeHarness();
    await recordUpload(h.deps.redis, "u1", 100, NOW - DAY);
    await recordUpload(h.deps.redis, "u1", 50, NOW);
    await recordUpload(h.deps.redis, "u1", 7, NOW + 60_000); // tomorrow, UTC
    const usage = await getUserUsage(h.deps.redis, "u1", 7, NOW);
    expect(usage.series).toHaveLength(7);
    expect(usage.series.at(-1)).toEqual({
      date: "2026-09-27",
      uploads: 1,
      bytes: 50,
    });
    expect(usage.series.at(-2)).toEqual({
      date: "2026-09-26",
      uploads: 1,
      bytes: 100,
    });
    expect(usage.series[0]).toEqual({
      date: "2026-09-21",
      uploads: 0,
      bytes: 0,
    });

    const tomorrow = await getUserUsage(h.deps.redis, "u1", 7, NOW + 60_000);
    expect(tomorrow.series.at(-1)).toEqual({
      date: "2026-09-28",
      uploads: 1,
      bytes: 7,
    });
  });

  it("sums the previous equal period and range command counts", async () => {
    h = await makeHarness();
    await recordUpload(h.deps.redis, "u1", 10, NOW - 8 * DAY);
    await recordUpload(h.deps.redis, "u1", 20, NOW - 9 * DAY);
    await recordCommandUse(h.deps.redis, "stats", "u1", NOW - 2 * DAY);
    await recordCommandUse(h.deps.redis, "stats", "u1", NOW - 20 * DAY);
    const usage = await getUserUsage(h.deps.redis, "u1", 7, NOW);
    expect(usage.previous).toEqual({ uploads: 2, bytes: 30 });
    expect(usage.commandsInRange).toEqual({ stats: 1 });
    expect(usage.commandsAllTime).toEqual({ stats: 2 });
  });

  it("seeds from existing files exactly once, skipping records older than 100 days", async () => {
    h = await makeHarness();
    const rec = (id: string, createdAt: number, size: number) =>
      saveRecord(h.deps.redis, {
        id,
        name: "a.png",
        mime: "image/png",
        kind: "image",
        size,
        width: 1,
        height: 1,
        createdAt,
        expiresAt: 0,
        userId: "u1",
        channelId: "c",
      });
    await rec("a", NOW - DAY, 5);
    await rec("b", NOW - DAY, 6);
    await rec("c", NOW - 200 * DAY, 9);

    expect(await seedUsageFromFiles(h.deps.redis, NOW)).toBe(2);
    expect(await seedUsageFromFiles(h.deps.redis, NOW)).toBeNull();
    expect(
      await h.deps.redis.hgetall(USER_DAY_KEY("u1", utcDay(NOW - DAY))),
    ).toEqual({ uploads: "2", bytes: "11" });
  });

  it("records trackingSince once", async () => {
    h = await makeHarness();
    await markUsageSince(h.deps.redis, 1000);
    await markUsageSince(h.deps.redis, 2000);
    expect((await getUserUsage(h.deps.redis, "u1", 7, NOW)).trackingSince).toBe(
      1000,
    );
  });
});

describe("peekRateLimit", () => {
  it("reports usage without spending any", async () => {
    h = await makeHarness();
    await checkRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    const a = await peekRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    const b = await peekRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    expect(a).toEqual(b);
    expect(a.remaining).toBe(2);
    expect(a.allowed).toBe(true);
  });

  it("clamps remaining at 0 after rejected attempts", async () => {
    h = await makeHarness();
    for (let i = 0; i < 5; i++)
      await checkRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    const p = await peekRateLimit(h.deps.redis, "upload", "u1", 3, NOW);
    expect(p.remaining).toBe(0);
    expect(p.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/usage-user.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement in `src/storage/usage.ts`**

Add below the existing constants:

```ts
import { LRU_KEY, getRecord } from "./store.js";

/** One hash per user per UTC day: uploads, bytes, and cmd:{name} counters. */
export const USER_DAY_KEY = (userId: string, day: string) =>
  `usage:${userId}:d:${day}`;
/** All-time per-command counts for one user. */
export const USER_CMDS_KEY = (userId: string) => `usage:${userId}:cmds`;
export const USAGE_SINCE_KEY = "usage:since";
export const USAGE_SEEDED_KEY = "usage:seeded:v1";
/** Longer than the widest range (90 days) so a range read never finds a hole. */
export const DAY_TTL_SECONDS = 100 * 86_400;
const DAY_MS = 86_400_000;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
```

Replace `recordCommandUse` with:

```ts
export async function recordCommandUse(
  redis: Redis,
  command: string,
  userId?: string,
  now = Date.now(),
): Promise<void> {
  const tx = redis
    .multi()
    .incr(COMMAND_TOTAL_KEY)
    .hincrby(COMMAND_BY_NAME_KEY, command, 1);
  if (userId) {
    const day = USER_DAY_KEY(userId, utcDay(now));
    tx.sadd(ACTIVE_USERS_KEY, userId)
      .hincrby(day, `cmd:${command}`, 1)
      .expire(day, DAY_TTL_SECONDS)
      .hincrby(USER_CMDS_KEY(userId), command, 1);
  }
  await tx.exec();
}
```

Append:

```ts
export async function recordUpload(
  redis: Redis,
  userId: string,
  bytes: number,
  now = Date.now(),
): Promise<void> {
  const day = USER_DAY_KEY(userId, utcDay(now));
  await redis
    .multi()
    .hincrby(day, "uploads", 1)
    .hincrby(day, "bytes", bytes)
    .expire(day, DAY_TTL_SECONDS)
    .exec();
}

export async function markUsageSince(
  redis: Redis,
  now = Date.now(),
): Promise<void> {
  await redis.setnx(USAGE_SINCE_KEY, String(now));
}

/**
 * One-time backfill of uploads/bytes from the files still stored, so the
 * activity chart is not empty on the day this ships. Command history cannot be
 * recovered and is not attempted.
 */
export async function seedUsageFromFiles(
  redis: Redis,
  now = Date.now(),
): Promise<number | null> {
  const won = await redis.set(USAGE_SEEDED_KEY, "1", "NX");
  if (won !== "OK") return null;
  let seeded = 0;
  for (const id of await redis.zrange(LRU_KEY, 0, -1)) {
    const record = await getRecord(redis, id);
    if (!record?.userId || now - record.createdAt > DAY_TTL_SECONDS * 1000)
      continue;
    await recordUpload(redis, record.userId, record.size, record.createdAt);
    seeded += 1;
  }
  return seeded;
}

export interface DailyPoint {
  date: string;
  uploads: number;
  bytes: number;
}

export interface UserUsage {
  series: DailyPoint[];
  previous: { uploads: number; bytes: number };
  commandsInRange: Record<string, number>;
  commandsAllTime: Record<string, number>;
  trackingSince: number;
}

const byCountDesc = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));

export async function getUserUsage(
  redis: Redis,
  userId: string,
  days: number,
  now = Date.now(),
): Promise<UserUsage> {
  // Oldest first: [today - (2*days - 1) … today]. The first half is the previous period.
  const dates = Array.from({ length: days * 2 }, (_, i) =>
    utcDay(now - (days * 2 - 1 - i) * DAY_MS),
  );
  const pipe = redis.pipeline();
  for (const d of dates) pipe.hgetall(USER_DAY_KEY(userId, d));
  pipe.hgetall(USER_CMDS_KEY(userId));
  pipe.get(USAGE_SINCE_KEY);
  const results = (await pipe.exec()) ?? [];

  const rows = dates.map((date, i) => ({
    date,
    raw: (results[i]?.[1] ?? {}) as Record<string, string>,
  }));
  const previous = { uploads: 0, bytes: 0 };
  const series: DailyPoint[] = [];
  const commandsInRange: Record<string, number> = {};

  rows.forEach(({ date, raw }, i) => {
    const point = {
      date,
      uploads: Number(raw.uploads ?? 0),
      bytes: Number(raw.bytes ?? 0),
    };
    if (i < days) {
      previous.uploads += point.uploads;
      previous.bytes += point.bytes;
      return;
    }
    series.push(point);
    for (const [field, value] of Object.entries(raw)) {
      if (!field.startsWith("cmd:")) continue;
      const name = field.slice(4);
      commandsInRange[name] = (commandsInRange[name] ?? 0) + Number(value);
    }
  });

  const allTimeRaw = (results[dates.length]?.[1] ?? {}) as Record<
    string,
    string
  >;
  const commandsAllTime = Object.fromEntries(
    Object.entries(allTimeRaw).map(([k, v]) => [k, Number(v)]),
  );
  const since = Number((results[dates.length + 1]?.[1] as string | null) ?? 0);

  return {
    series,
    previous,
    commandsInRange: byCountDesc(commandsInRange),
    commandsAllTime: byCountDesc(commandsAllTime),
    trackingSince: since || now,
  };
}
```

- [ ] **Step 4: Implement `peekRateLimit` in `src/storage/ratelimit.ts`**

```ts
/** Same answer as checkRateLimit would give, without spending a request. */
export async function peekRateLimit(
  redis: Redis,
  scope: string,
  userId: string,
  limit: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const window = Math.floor(now / WINDOW_MS);
  const resetAt = (window + 1) * WINDOW_MS;
  if (limit <= 0) return { allowed: true, remaining: Infinity, limit, resetAt };
  const count = Number((await redis.get(key(scope, userId, window))) ?? 0);
  const remaining = Math.max(0, limit - count);
  return { allowed: remaining > 0, remaining, limit, resetAt };
}
```

- [ ] **Step 5: Seed at boot in `src/index.ts`**

After `await reconcile(redis, config);`:

```ts
await markUsageSince(redis);
const seeded = await seedUsageFromFiles(redis);
if (seeded !== null)
  console.log(`Seeded per-user usage from ${seeded} stored files`);
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/usage-user.test.ts test/usage.test.ts && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/usage.ts src/storage/ratelimit.ts src/index.ts test/usage-user.test.ts
git commit -m "feat: track per-user daily usage and peek rate-limit headroom

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Shared ingest pipeline

A behaviour-neutral extraction. The existing upload tests are the proof.

**Files:**

- Create: `src/storage/ingest.ts`
- Modify: `src/routes/upload.ts`

**Interfaces:**

- Produces (`src/storage/ingest.ts`):
  - `class UploadError extends Error { constructor(readonly status: number, message: string) }`
  - `interface IngestOwner { userId: string; channelId: string; ttlMs: (fields: Record<string, string>) => number }`
  - `declaredTooLarge(c: Context, config: Config): boolean`
  - `ingestUpload(c: Context, deps: AppDeps, owner: IngestOwner): Promise<FileRecord>`. It throws `UploadError` and always removes the partial directory on failure. On success it has already run `expireDue`, `enforceUserQuota`, `saveRecord`, `recordUpload` (best effort) and `sweep`.

- [ ] **Step 1: Create `src/storage/ingest.ts`**

Move these from `src/routes/upload.ts` verbatim: `UploadError`, `enforceUserQuota`, `ReceivedUpload`, `receiveUpload` and `dimension`. Their imports come with them: busboy, fs, stream, `requestNodeStream`, sniff, and the store functions. Then add:

```ts
import type { Context } from "hono";
import { rm } from "node:fs/promises";
import type { AppDeps } from "../app.js";
import type { Config } from "../config.js";
import { sweep } from "./lru.js";
import { newId } from "./sessions.js";
import { expireDue, fileDir, saveRecord } from "./store.js";
import { recordUpload } from "./usage.js";
import type { FileRecord } from "../types.js";

export interface IngestOwner {
  userId: string;
  channelId: string;
  /** Decides the lifetime once the multipart fields (which precede the file) are known. */
  ttlMs: (fields: Record<string, string>) => number;
}

/** Cheap early refusal before reading a byte; the streamed counter is still authoritative. */
export function declaredTooLarge(c: Context, config: Config): boolean {
  const declared = Number(c.req.header("content-length") ?? 0);
  return declared > config.maxFileBytes + 64 * 1024;
}

export async function ingestUpload(
  c: Context,
  deps: AppDeps,
  owner: IngestOwner,
): Promise<FileRecord> {
  const id = newId();
  const dir = fileDir(deps.config, id);

  let received: ReceivedUpload;
  try {
    received = await receiveUpload(c, deps, dir);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  // A file larger than the whole per-user quota can never fit, and evicting
  // the uploader's other files would not change that.
  if (received.size > deps.config.maxUserBytes) {
    await rm(dir, { recursive: true, force: true });
    throw new UploadError(413, "File exceeds your personal storage quota");
  }

  const now = Date.now();
  const ttlMs = owner.ttlMs(received.fields);
  const record: FileRecord = {
    id,
    name: received.name,
    mime: received.type.mime,
    kind: received.type.kind,
    size: received.size,
    width: received.width,
    height: received.height,
    createdAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    userId: owner.userId,
    channelId: owner.channelId,
  };

  // Drop anything already expired, then make room within the uploader's own
  // quota by removing their least-recent files first. Other users are never touched.
  await expireDue(deps.redis, deps.config, now);
  await enforceUserQuota(deps, owner.userId, record.size);
  await saveRecord(deps.redis, record);
  try {
    await recordUpload(deps.redis, owner.userId, record.size, now);
  } catch (err) {
    console.error(`Failed to record upload usage for ${owner.userId}:`, err);
  }
  await sweep(deps.redis, deps.config);
  return record;
}
```

In `receiveUpload`:

- Add `fields: Record<string, string>` to `ReceivedUpload`.
- Set `fields` in the `result = { … }` literal, so `ttl` reaches `owner.ttlMs`.

- [ ] **Step 2: Make `/u/:sid/file` use it**

In `src/routes/upload.ts`, the handler becomes:

```ts
app.post("/u/:sid/file", async (c) => {
  const sid = c.req.param("sid");
  if (declaredTooLarge(c, deps.config)) {
    return c.json({ error: "File exceeds the size limit" }, 413);
  }

  // … the peek + rate-limit block and the claim block stay exactly as they are …

  const session = claim.session;
  let record: FileRecord;
  try {
    record = await ingestUpload(c, deps, {
      userId: session.userId,
      channelId: session.channelId,
      ttlMs: () => session.ttlMs,
    });
  } catch (err) {
    if (err instanceof UploadError)
      return c.json({ error: err.message }, err.status as 400);
    console.error("Upload failed:", err);
    return c.json({ error: "Upload failed" }, 500);
  }

  const posted = await maybePost(deps, session, record);
  await deleteSession(deps.redis, sid);
  return c.json({
    posted,
    url:
      record.kind === "video"
        ? watchUrl(deps.config, record)
        : fileUrl(deps.config, record),
    fileUrl: fileUrl(deps.config, record),
    kind: record.kind,
  });
});
```

Remove the moved functions and every import `upload.ts` no longer uses.

- [ ] **Step 3: Prove it's behaviour-neutral**

Run: `pnpm test`
Expected: every test passes, unchanged. That includes the whole `upload flow` describe block, `ratelimit.test.ts`, `gallery.test.ts`, and eviction during upload.

- [ ] **Step 4: Check that Discord uploads now count**

Append to `test/usage-user.test.ts`. It reuses the upload helpers pattern from `test/integration.test.ts`; copy its `uploadRequest` and `png` helpers into the new describe:

```ts
describe("uploads are counted", () => {
  it("counts a /u/:sid/file upload in today's bucket", async () => {
    h = await makeHarness();
    const s = await (
      await import("../src/storage/sessions.js")
    ).createSession(h.deps.redis, {
      kind: "upload",
      userId: "u9",
      channelId: "c",
      guildId: "",
      interactionToken: "t",
      ttlMs: 0,
    });
    const png = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...new Array(64).fill(0),
    ]);
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "a.png");
    const res = await h.app.fetch(
      new Request(`https://uploader.test/u/${s.sid}/file`, {
        method: "POST",
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    const today = await h.deps.redis.hgetall(
      USER_DAY_KEY("u9", utcDay(Date.now())),
    );
    expect(today.uploads).toBe("1");
    expect(Number(today.bytes)).toBe(png.length);
  });
});
```

Run: `pnpm vitest run test/usage-user.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/ingest.ts src/routes/upload.ts test/usage-user.test.ts
git commit -m "refactor: extract the upload pipeline into storage/ingest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: `/api/me/*`

**Files:**

- Create: `src/me/types.ts`, `src/me/data.ts`, `src/routes/me.ts`
- Modify: `src/app.ts` (replace the temporary `/api/me` route)
- Test: `test/me.test.ts`

**Interfaces:**

- Produces:
  - `src/me/types.ts`:
    - `type UsageRange = "7d" | "30d" | "90d"`
    - `interface ApiFile { id: string; name: string; mime: string; kind: "image" | "video"; size: number; width: number; height: number; createdAt: number; expiresAt: number; url: string; watchUrl: string | null }`
    - `interface ApiLimits { maxFileBytes: number; maxUserBytes: number; ttlOptions: { value: string; label: string; ms: number }[]; defaultTtl: string; uploadsPerHour: number; sessionsPerHour: number }`
    - `interface ApiRate { used: number; limit: number; remaining: number | null; resetAt: number }`. `remaining: null` means unlimited.
    - `interface ApiStorage { used: number; quota: number; images: { count: number; bytes: number }; videos: { count: number; bytes: number } }`
    - `interface ApiUsage { range: UsageRange; storage: ApiStorage; series: { date: string; uploads: number; bytes: number }[]; totals: { uploads: number; bytes: number; prevUploads: number; prevBytes: number }; commands: { range: Record<string, number>; allTime: Record<string, number> }; rateLimits: { uploads: ApiRate; sessions: ApiRate }; trackingSince: number }`
    - `interface ApiMe { user: AuthUser; limits: ApiLimits }`
  - `src/me/data.ts`:
    - `RANGE_DAYS: Record<UsageRange, number>`
    - `parseRange(raw: string | undefined): UsageRange`
    - `toApiFile(config, record): ApiFile`
    - `limitsFor(config): ApiLimits`
    - `listMyFiles(deps, userId): Promise<ApiFile[]>`
    - `getMyUsage(deps, userId, range, now?): Promise<ApiUsage>`
  - `meRoutes(deps): Hono<AuthEnv>`

- [ ] **Step 1: Write the failing tests**

`test/me.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { createAuthSession } from "../src/auth/sessions.js";
import { fileDir, saveRecord } from "../src/storage/store.js";
import { checkRateLimit } from "../src/storage/ratelimit.js";
import type { FileRecord } from "../src/types.js";

let h: Harness;
afterEach(() => h?.cleanup());

const ORIGIN = "https://uploader.test";
const PNG = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(64).fill(0),
]);

async function signIn(id = "111"): Promise<string> {
  return createAuthSession(h.deps.redis, {
    id,
    username: "u" + id,
    globalName: "",
    avatar: "",
  });
}

function req(pathname: string, token: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `__Host-session=${token}`);
  if (init.method && init.method !== "GET") headers.set("Origin", ORIGIN);
  return new Request(`${ORIGIN}${pathname}`, { ...init, headers });
}

async function seedFile(
  id: string,
  userId: string,
  extra: Partial<FileRecord> = {},
): Promise<FileRecord> {
  const r: FileRecord = {
    id,
    name: `${id}.png`,
    mime: "image/png",
    kind: "image",
    size: 10,
    width: 1,
    height: 1,
    createdAt: Date.now(),
    expiresAt: 0,
    userId,
    channelId: "c",
    ...extra,
  };
  mkdirSync(fileDir(h.deps.config, id), { recursive: true });
  writeFileSync(path.join(fileDir(h.deps.config, id), r.name), "0123456789");
  await saveRecord(h.deps.redis, r);
  return r;
}

describe("/api/me", () => {
  it("401s without a session", async () => {
    h = await makeHarness();
    for (const p of ["/api/me", "/api/me/files", "/api/me/usage"]) {
      expect((await h.app.fetch(new Request(`${ORIGIN}${p}`))).status).toBe(
        401,
      );
    }
  });

  it("returns the profile and limits", async () => {
    h = await makeHarness();
    const t = await signIn();
    const body = await (await h.app.fetch(req("/api/me", t))).json();
    expect(body.user.id).toBe("111");
    expect(body.limits.maxUserBytes).toBe(h.deps.config.maxUserBytes);
    expect(
      body.limits.ttlOptions.map((o: { value: string }) => o.value),
    ).toEqual(["1h", "24h", "7d", "30d", "forever"]);
    expect(body.limits.defaultTtl).toBe("30d");
  });

  it("lists only my files, newest first, with share URLs", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("mineold", "111", { createdAt: 1 });
    await seedFile("minenew", "111", {
      createdAt: 2,
      kind: "video",
      mime: "video/mp4",
      name: "minenew.mp4",
    });
    await seedFile("theirs", "222");
    const { files } = await (await h.app.fetch(req("/api/me/files", t))).json();
    expect(files.map((f: { id: string }) => f.id)).toEqual([
      "minenew",
      "mineold",
    ]);
    expect(files[0].watchUrl).toBe(`${ORIGIN}/v/minenew`);
    expect(files[1].watchUrl).toBeNull();
    expect(files[1].url).toBe(`${ORIGIN}/f/mineold/mineold.png`);
  });

  it("uploads through the shared pipeline with a chosen ttl and returns 201", async () => {
    h = await makeHarness();
    const t = await signIn();
    const form = new FormData();
    form.append("ttl", "7d");
    form.append("width", "1");
    form.append("height", "1");
    form.append("file", new Blob([PNG], { type: "image/png" }), "shot.png");
    const before = Date.now();
    const res = await h.app.fetch(
      req("/api/me/files", t, { method: "POST", body: form }),
    );
    expect(res.status).toBe(201);
    const { file } = await res.json();
    expect(file.name).toBe("shot.png");
    expect(file.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(h.calls.filter((c) => c.url.includes("/webhooks/"))).toHaveLength(0);
  });

  it("returns the server's 429 message when the hourly budget is gone", async () => {
    h = await makeHarness({ rateLimitUploadsPerHour: 1 });
    const t = await signIn();
    await checkRateLimit(h.deps.redis, "upload", "111", 1);
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
    const res = await h.app.fetch(
      req("/api/me/files", t, { method: "POST", body: form }),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too quickly/);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("returns 415 for a non-media file", async () => {
    h = await makeHarness();
    const t = await signIn();
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from("hello world, not an image".repeat(4))], {
        type: "image/png",
      }),
      "a.png",
    );
    const res = await h.app.fetch(
      req("/api/me/files", t, { method: "POST", body: form }),
    );
    expect(res.status).toBe(415);
  });

  it("deletes my file and 404s someone else's", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("mine", "111");
    await seedFile("theirs", "222");
    expect(
      (await h.app.fetch(req("/api/me/files/mine", t, { method: "DELETE" })))
        .status,
    ).toBe(204);
    expect(
      (await h.app.fetch(req("/api/me/files/theirs", t, { method: "DELETE" })))
        .status,
    ).toBe(404);
    expect(existsSync(fileDir(h.deps.config, "theirs"))).toBe(true);
  });

  it("bulk deletes owned ids and reports the rest as missing", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("a", "111");
    await seedFile("b", "111");
    await seedFile("x", "222");
    const res = await h.app.fetch(
      req("/api/me/files/delete", t, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["a", "b", "x", "gone"] }),
      }),
    );
    expect(await res.json()).toEqual({
      deleted: ["a", "b"],
      missing: ["x", "gone"],
    });
    expect(existsSync(fileDir(h.deps.config, "x"))).toBe(true);
  });

  it("validates bulk delete input", async () => {
    h = await makeHarness();
    const t = await signIn();
    const bad = async (body: unknown) =>
      (
        await h.app.fetch(
          req("/api/me/files/delete", t, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
      ).status;
    expect(await bad({ ids: [] })).toBe(400);
    expect(
      await bad({ ids: Array.from({ length: 101 }, (_, i) => `i${i}`) }),
    ).toBe(400);
    expect(await bad({ ids: [1, 2] })).toBe(400);
    expect(await bad({})).toBe(400);
  });

  it("refuses cross-origin writes", async () => {
    h = await makeHarness();
    const t = await signIn();
    await seedFile("mine", "111");
    const res = await h.app.fetch(
      new Request(`${ORIGIN}/api/me/files/mine`, {
        method: "DELETE",
        headers: { Cookie: `__Host-session=${t}`, Origin: "https://evil.test" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("reports usage with storage split, zero-filled series and rate limits", async () => {
    h = await makeHarness({
      rateLimitUploadsPerHour: 30,
      rateLimitSessionsPerHour: 0,
    });
    const t = await signIn();
    await seedFile("i1", "111", { size: 10 });
    await seedFile("v1", "111", {
      size: 10,
      kind: "video",
      mime: "video/mp4",
      name: "v1.mp4",
    });
    const body = await (
      await h.app.fetch(req("/api/me/usage?range=7d", t))
    ).json();
    expect(body.range).toBe("7d");
    expect(body.series).toHaveLength(7);
    expect(body.storage.images).toEqual({ count: 1, bytes: 10 });
    expect(body.storage.videos).toEqual({ count: 1, bytes: 10 });
    expect(body.storage.used).toBe(20);
    expect(body.rateLimits.uploads).toMatchObject({
      used: 0,
      limit: 30,
      remaining: 30,
    });
    expect(body.rateLimits.sessions.remaining).toBeNull();
  });

  it("defaults an unknown range to 30d", async () => {
    h = await makeHarness();
    const t = await signIn();
    const body = await (
      await h.app.fetch(req("/api/me/usage?range=999d", t))
    ).json();
    expect(body.range).toBe("30d");
    expect(body.series).toHaveLength(30);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/me.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/me/types.ts`**

Write exactly the interfaces listed under **Interfaces** above, importing `type { AuthUser } from "../auth/types.js"`. The file must contain type-only exports, because browser code imports it.

- [ ] **Step 4: Write `src/me/data.ts`**

```ts
import type { AppDeps } from "../app.js";
import type { Config } from "../config.js";
import { fileUrl, watchUrl } from "../discord/followup.js";
import { peekRateLimit } from "../storage/ratelimit.js";
import { expireDue, listUserFiles, userBytes } from "../storage/store.js";
import { getUserUsage } from "../storage/usage.js";
import { DEFAULT_TTL_MS, TTL_OPTIONS } from "../ttl.js";
import type { FileRecord } from "../types.js";
import type {
  ApiFile,
  ApiLimits,
  ApiRate,
  ApiUsage,
  UsageRange,
} from "./types.js";
import type { RateLimitResult } from "../storage/ratelimit.js";

export const RANGE_DAYS: Record<UsageRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
/** Dashboards list everything; the single-use gallery keeps its 200 cap. */
const ALL_FILES = 100_000;

export function parseRange(raw: string | undefined): UsageRange {
  return raw === "7d" || raw === "30d" || raw === "90d" ? raw : "30d";
}

export function toApiFile(config: Config, r: FileRecord): ApiFile {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    kind: r.kind,
    size: r.size,
    width: r.width,
    height: r.height,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    url: fileUrl(config, r),
    watchUrl: r.kind === "video" ? watchUrl(config, r) : null,
  };
}

export function limitsFor(config: Config): ApiLimits {
  return {
    maxFileBytes: config.maxFileBytes,
    maxUserBytes: config.maxUserBytes,
    ttlOptions: TTL_OPTIONS.map((o) => ({
      value: o.value,
      label: o.name,
      ms: o.ms,
    })),
    defaultTtl:
      TTL_OPTIONS.find((o) => o.ms === DEFAULT_TTL_MS)?.value ?? "30d",
    uploadsPerHour: config.rateLimitUploadsPerHour,
    sessionsPerHour: config.rateLimitSessionsPerHour,
  };
}

export async function listMyFiles(
  deps: AppDeps,
  userId: string,
): Promise<ApiFile[]> {
  await expireDue(deps.redis, deps.config);
  const records = await listUserFiles(deps.redis, userId, ALL_FILES);
  return records.map((r) => toApiFile(deps.config, r));
}

function toApiRate(r: RateLimitResult): ApiRate {
  if (r.limit <= 0)
    return { used: 0, limit: 0, remaining: null, resetAt: r.resetAt };
  return {
    used: r.limit - r.remaining,
    limit: r.limit,
    remaining: r.remaining,
    resetAt: r.resetAt,
  };
}

export async function getMyUsage(
  deps: AppDeps,
  userId: string,
  range: UsageRange,
  now = Date.now(),
): Promise<ApiUsage> {
  await expireDue(deps.redis, deps.config, now);
  const [records, used, usage, uploads, sessions] = await Promise.all([
    listUserFiles(deps.redis, userId, ALL_FILES),
    userBytes(deps.redis, userId),
    getUserUsage(deps.redis, userId, RANGE_DAYS[range], now),
    peekRateLimit(
      deps.redis,
      "upload",
      userId,
      deps.config.rateLimitUploadsPerHour,
      now,
    ),
    peekRateLimit(
      deps.redis,
      "session",
      userId,
      deps.config.rateLimitSessionsPerHour,
      now,
    ),
  ]);

  const images = { count: 0, bytes: 0 };
  const videos = { count: 0, bytes: 0 };
  for (const r of records) {
    const bucket = r.kind === "video" ? videos : images;
    bucket.count += 1;
    bucket.bytes += r.size;
  }

  return {
    range,
    storage: { used, quota: deps.config.maxUserBytes, images, videos },
    series: usage.series,
    totals: {
      uploads: usage.series.reduce((n, p) => n + p.uploads, 0),
      bytes: usage.series.reduce((n, p) => n + p.bytes, 0),
      prevUploads: usage.previous.uploads,
      prevBytes: usage.previous.bytes,
    },
    commands: { range: usage.commandsInRange, allTime: usage.commandsAllTime },
    rateLimits: { uploads: toApiRate(uploads), sessions: toApiRate(sessions) },
    trackingSince: usage.trackingSince,
  };
}
```

- [ ] **Step 5: Write `src/routes/me.ts`**

```ts
import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { requireApiUser } from "../auth/middleware.js";
import type { AuthEnv, AuthUser } from "../auth/types.js";
import {
  getMyUsage,
  limitsFor,
  listMyFiles,
  parseRange,
  toApiFile,
} from "../me/data.js";
import {
  declaredTooLarge,
  ingestUpload,
  UploadError,
} from "../storage/ingest.js";
import { checkRateLimit, minutesUntil } from "../storage/ratelimit.js";
import { deleteRecord, getRecord } from "../storage/store.js";
import { ttlValueToMs } from "../ttl.js";

const MAX_BULK = 100;

export function meRoutes(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/api/me", requireApiUser);
  app.use("/api/me/*", requireApiUser);
  app.use("/api/me", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("/api/me/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  const me = (c: { get(k: "user"): AuthUser | null }) => c.get("user")!;

  app.get("/api/me", (c) =>
    c.json({ user: me(c), limits: limitsFor(deps.config) }),
  );

  app.get("/api/me/files", async (c) =>
    c.json({ files: await listMyFiles(deps, me(c).id) }),
  );

  app.post("/api/me/files", async (c) => {
    const user = me(c);
    if (declaredTooLarge(c, deps.config))
      return c.json({ error: "File exceeds the size limit" }, 413);

    // Same hourly bucket as uploads through a Discord link.
    const limit = await checkRateLimit(
      deps.redis,
      "upload",
      user.id,
      deps.config.rateLimitUploadsPerHour,
    );
    if (!limit.allowed) {
      return c.json(
        {
          error: `You're uploading too quickly. Try again in ${minutesUntil(limit.resetAt)} minute(s).`,
          retryAfterSeconds: Math.ceil((limit.resetAt - Date.now()) / 1000),
        },
        429,
      );
    }

    try {
      const record = await ingestUpload(c, deps, {
        userId: user.id,
        channelId: "",
        ttlMs: (fields) => ttlValueToMs(fields.ttl),
      });
      return c.json({ file: toApiFile(deps.config, record) }, 201);
    } catch (err) {
      if (err instanceof UploadError)
        return c.json({ error: err.message }, err.status as 400);
      console.error("Dashboard upload failed:", err);
      return c.json({ error: "Upload failed" }, 500);
    }
  });

  app.delete("/api/me/files/:id", async (c) => {
    const id = c.req.param("id");
    const record = await getRecord(deps.redis, id);
    // Someone else's file answers exactly like a missing one.
    if (!record || record.userId !== me(c).id)
      return c.json({ error: "File not found" }, 404);
    await deleteRecord(deps.redis, deps.config, id);
    return c.body(null, 204);
  });

  app.post("/api/me/files/delete", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      ids?: unknown;
    } | null;
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_BULK ||
      !ids.every((i) => typeof i === "string")
    ) {
      return c.json({ error: `Send 1–${MAX_BULK} file ids` }, 400);
    }
    const userId = me(c).id;
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of new Set(ids as string[])) {
      const record = await getRecord(deps.redis, id);
      if (!record || record.userId !== userId) {
        missing.push(id);
        continue;
      }
      await deleteRecord(deps.redis, deps.config, id);
      deleted.push(id);
    }
    return c.json({ deleted, missing });
  });

  app.get("/api/me/usage", async (c) =>
    c.json(await getMyUsage(deps, me(c).id, parseRange(c.req.query("range")))),
  );

  return app;
}
```

- [ ] **Step 6: Wire it in**

In `src/app.ts`:

- Delete the temporary `/api/me` route.
- Add `app.route("/", meRoutes(deps));` after `authRoutes`.

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/me src/routes/me.ts src/app.ts test/me.test.ts
git commit -m "feat: add the /api/me dashboard API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Login page and "Open dashboard" button

**Files:**

- Create: `web/src/pages/login.astro`, `web/src/lib/server/headers.ts`
- Modify: `src/routes/interactions.ts`, `test/pages.test.ts`, `test/integration.test.ts` (new test only)

**Interfaces:**

- Produces: `dashboardHeaders(headers: Headers): void` sets `DASHBOARD_CSP` and `Cache-Control: no-store`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pages.test.ts`:

```ts
import { createAuthSession } from "../src/auth/sessions.js";

describe("/login", () => {
  it.each([
    ["cancelled", 200, "Sign-in cancelled."],
    ["expired", 400, "That sign-in link expired. Try again."],
    ["discord", 502, "Discord didn't answer. Try again in a moment."],
  ])("error=%s renders status %i", async (error, status, message) => {
    h = await makeHarness();
    const res = await h.app.fetch(
      new Request(`https://uploader.test/login?error=${error}`),
    );
    expect(res.status).toBe(status);
    // Astro escapes the apostrophe in "didn't" as &#39;.
    const pattern = new RegExp(
      message.replace(/[.?]/g, "\\$&").replace("'", "(&#39;|')"),
    );
    expect(await res.text()).toMatch(pattern);
  });

  it("says sign-in is not set up when there is no client secret", async () => {
    h = await makeHarness({ discordClientSecret: "" });
    const html = await (
      await h.app.fetch(new Request("https://uploader.test/login"))
    ).text();
    expect(html).toContain("Sign-in isn");
    expect(html).not.toContain('action="/auth/login"');
  });

  it("keeps next on the Discord button, sanitised", async () => {
    h = await makeHarness();
    const html = await (
      await h.app.fetch(
        new Request("https://uploader.test/login?next=//evil.com"),
      )
    ).text();
    expect(html).toContain('name="next" value="/dashboard"');
  });

  it("sends a signed-in visitor on to the dashboard", async () => {
    h = await makeHarness();
    const t = await createAuthSession(h.deps.redis, {
      id: "1",
      username: "a",
      globalName: "",
      avatar: "",
    });
    const res = await h.app.fetch(
      new Request("https://uploader.test/login", {
        headers: { Cookie: `__Host-session=${t}` },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("sets the dashboard CSP header", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(new Request("https://uploader.test/login"));
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});
```

Append to `test/integration.test.ts` inside `describe("POST /interactions")`. Mirror how the existing "replies ephemerally with a link button" test builds its payload; use the same helper it uses:

```ts
it("adds an Open dashboard button when sign-in is configured", async () => {
  const res = await h.app.fetch(interactionRequest(uploadCommand()));
  const buttons = (await res.json()).data.components[0].components;
  expect(buttons[1]).toMatchObject({
    type: 2,
    style: 5,
    label: "Open dashboard",
    url: "https://uploader.test/dashboard",
  });
});
```

(`uploadCommand()` is the helper that file already uses for `/upload` interactions. `h` there is the harness set up in its `beforeEach`, and `makeHarness` now sets `discordClientSecret: "test-secret"`.)

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm build:web && pnpm vitest run test/pages.test.ts test/integration.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Write `web/src/lib/server/headers.ts`**

```ts
import { DASHBOARD_CSP } from "@server/web/csp";

export function dashboardHeaders(headers: Headers): void {
  headers.set("Content-Security-Policy", DASHBOARD_CSP);
  headers.set("Cache-Control", "no-store");
}
```

- [ ] **Step 4: Write `web/src/pages/login.astro`**

```astro
---
import Shell from "../layouts/Shell.astro";
import BrandBar from "../components/BrandBar.astro";
import { safeNext } from "@server/auth/oauth";
import { dashboardHeaders } from "../lib/server/headers";

const { deps, user } = Astro.locals;
const next = safeNext(Astro.url.searchParams.get("next") ?? undefined);
if (user) return Astro.redirect(next, 302);

dashboardHeaders(Astro.response.headers);
const configured = Boolean(deps.config.discordClientSecret);
const ERRORS: Record<string, { status: number; message: string }> = {
  cancelled: { status: 200, message: "Sign-in cancelled." },
  expired: { status: 400, message: "That sign-in link expired. Try again." },
  discord: { status: 502, message: "Discord didn't answer. Try again in a moment." },
};
const error = ERRORS[Astro.url.searchParams.get("error") ?? ""];
if (error) Astro.response.status = error.status;
const signedOut = Astro.url.searchParams.get("signedout") === "1";
---

<Shell title="Sign in">
  <BrandBar name="Sign in" sub="Your uploads, anywhere" />
  <main class="centered">
    <div class="card panel">
      <div class="card-in">
        <header>
          <h1>Open your dashboard</h1>
          <p class="muted">Browse, upload and manage everything you've sent, with your usage at a glance.</p>
        </header>
        {signedOut && <p class="status success" role="status">Signed out.</p>}
        {error && <p class="status error" role="alert">{error.message}</p>}
        {
          configured ? (
            <form method="get" action="/auth/login">
              <input type="hidden" name="next" value={next} />
              <button class="button discord" type="submit">Continue with Discord</button>
            </form>
          ) : (
            <p class="status error" role="alert">Sign-in isn't set up on this server.</p>
          )
        }
        <p class="muted">We only read your Discord id, name and avatar.</p>
      </div>
    </div>
  </main>
</Shell>
```

Add to `public/upload.css`, in the Buttons section. This is a new rule with no effect on existing pages:

```css
/* Discord's blurple, for the one button that leaves for discord.com. */
.button.discord {
  width: 100%;
  background: #5865f2;
}
.button.discord:hover:not(:disabled) {
  background: #6d79f5;
}
```

- [ ] **Step 5: Add the button in `src/routes/interactions.ts`**

In the final `embedReply(…)` for upload/gallery sessions, change the components row's `components` array to:

```ts
              components: [
                {
                  type: 2,
                  style: 5,
                  label: gallery ? "Open gallery" : "Open upload page",
                  url,
                },
                // Only offered when sign-in works, so the link never dead-ends.
                ...(deps.config.discordClientSecret
                  ? [{ type: 2, style: 5, label: "Open dashboard", url: `${deps.config.publicUrl}/dashboard` }]
                  : []),
              ],
```

- [ ] **Step 6: Run everything, including visuals**

Run: `pnpm test && pnpm test:e2e && pnpm typecheck`
Expected: all green. The legacy screenshots are unchanged, since the new CSS rule is unused on those pages.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/login.astro web/src/lib/server public/upload.css src/routes/interactions.ts test
git commit -m "feat: login page and an Open dashboard button on command replies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Phase 3 — Dashboard UI

### Task 14: Dashboard shell, Tailwind, dither-kit, toasts

**Files:**

- Create:
  - `scripts/vendor-dither-kit.mjs`, `web/src/components/dither-kit/*` (generated)
  - `web/src/styles/dashboard.css`, `web/src/layouts/Dashboard.astro`
  - `web/src/lib/store.ts`, `web/src/lib/toast.ts`
  - `web/src/islands/Toasts.tsx`, `web/src/islands/UserAvatar.tsx`
  - `web/src/pages/dashboard/index.astro` and `web/src/pages/dashboard/usage.astro` (placeholder bodies, filled in Tasks 16 and 19)
  - `.prettierignore`
- Modify: `web/astro.config.mjs`, `package.json`
- Test: `test/pages.test.ts` (append)

**Interfaces:**

- Produces:
  - `web/src/lib/store.ts`:
    - `interface Store<T> { get(): T; set(next: T | ((prev: T) => T)): void; subscribe(fn: () => void): () => void }`
    - `createStore<T>(initial: T): Store<T>`
    - `useStore<T>(store: Store<T>): T`
  - `web/src/lib/toast.ts`:
    - `interface Toast { id: number; message: string; kind: "info" | "success" | "error" }`
    - `toastStore: Store<Toast[]>`, `announceStore: Store<string>`
    - `toast(message, kind?, ms?)`, `announce(message)`
  - `Dashboard.astro` props: `{ title: string; tab: "files" | "usage" }`. It renders the brand bar, tabs, account menu, and the `upload-tray` and `toasts` persistent slots. Task 18 adds `<UploadTray>`.
  - A `[data-upload-trigger]` button in the bar (wired in Task 18).
  - dither-kit colours `"indigo" | "cyan" | "gold"` added to `DitherColor`.

- [ ] **Step 1: Write the failing page tests**

Append to `test/pages.test.ts`:

```ts
describe("/dashboard shell", () => {
  async function signedIn(
    user = { id: "7", username: "neo", globalName: "Neo", avatar: "" },
  ) {
    return createAuthSession(h.deps.redis, user);
  }

  it("renders tabs, the account menu and the dashboard CSP", async () => {
    h = await makeHarness();
    const t = await signedIn();
    const res = await h.app.fetch(
      new Request("https://uploader.test/dashboard", {
        headers: { Cookie: `__Host-session=${t}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "https://cdn.discordapp.com",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("@neo");
    expect(html).toMatch(/<a href="\/dashboard"[^>]*aria-current="page"/);
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain("data-upload-trigger");
  });

  it("uses the Discord CDN avatar when the user has one", async () => {
    h = await makeHarness();
    const t = await signedIn({
      id: "7",
      username: "neo",
      globalName: "",
      avatar: "a1b2",
    });
    const html = await (
      await h.app.fetch(
        new Request("https://uploader.test/dashboard/usage", {
          headers: { Cookie: `__Host-session=${t}` },
        }),
      )
    ).text();
    expect(html).toContain(
      "https://cdn.discordapp.com/avatars/7/a1b2.png?size=64",
    );
    expect(html).toMatch(
      /<a href="\/dashboard\/usage"[^>]*aria-current="page"/,
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm build:web && pnpm vitest run test/pages.test.ts`
Expected: FAIL. `/dashboard` returns Hono's 404 text.

- [ ] **Step 3: Install UI dependencies**

```bash
pnpm add motion d3-scale d3-shape clsx tailwind-merge
pnpm add -D tailwindcss@^4.3.3 @tailwindcss/vite@^4.3.3 @types/d3-scale @types/d3-shape
```

- [ ] **Step 4: Vendor dither-kit reproducibly**

`scripts/vendor-dither-kit.mjs`:

```js
// Copies dither-kit's shadcn registry items into web/src/components/dither-kit.
// Re-run to update; then re-apply the palette patch (see palette.ts header).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve("web/src/components/dither-kit");
const seen = new Set();
const npm = new Set();

async function pull(url) {
  if (seen.has(url)) return;
  seen.add(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const item = await res.json();
  for (const dep of item.dependencies ?? []) npm.add(dep);
  for (const dep of item.registryDependencies ?? []) await pull(dep);
  for (const file of item.files ?? []) {
    const target = path.join(OUT, path.basename(file.path));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

await pull("https://tripwire.sh/r/dither-kit.json");
console.log(`Wrote ${seen.size} registry items to ${OUT}`);
console.log(`npm deps: ${[...npm].sort().join(" ")}`);
```

Run: `node scripts/vendor-dither-kit.mjs`
Expected:

- The script prints the npm deps. Every one of them must already be installed from Step 3; install any that aren't.
- `web/src/components/dither-kit/index.ts` exists.

Run `grep -rn '@/' web/src/components/dither-kit`. Expected: no output, since the kit uses relative imports only.

- [ ] **Step 5: Patch the palette to the mascot colours**

In `web/src/components/dither-kit/palette.ts`:

- Add `| "indigo" | "cyan" | "gold"` to the `DitherColor` union.
- Add these entries to `PALETTE`:

```ts
  // Local additions (discord-uploader): the mascot palette from public/upload.css.
  indigo: { fill: [91, 84, 214], line: [160, 154, 255], star: [210, 206, 255] },
  cyan: { fill: [63, 193, 243], line: [150, 225, 255], star: [205, 240, 255] },
  gold: { fill: [245, 197, 24], line: [255, 222, 120], star: [255, 238, 180] },
```

Add as the first line of the file: `// PATCHED: indigo/cyan/gold added for discord-uploader. Re-apply after re-vendoring.`

- [ ] **Step 6: Keep vendored code out of Prettier**

Create `.prettierignore`:

```
web/src/components/dither-kit/
web/dist/
web/.astro/
test/e2e/__screenshots__/
pnpm-lock.yaml
```

- [ ] **Step 7: Tailwind in Astro**

In `web/astro.config.mjs`, add `import tailwindcss from "@tailwindcss/vite";` and `plugins: [tailwindcss()]` inside `vite`.

- [ ] **Step 8: Write `web/src/styles/dashboard.css`**

```css
/*
 * Tailwind without preflight: only theme tokens and utilities, in layers, so
 * the unlayered upload.css keeps authority over the page. Tailwind exists only
 * for dither-kit's classes; dashboard chrome below uses plain CSS on the same
 * tokens as every other page.
 */
@layer theme, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@source "../components/dither-kit";
@source "../islands";

/* shadcn token names dither-kit expects, mapped onto the mascot palette. */
@theme inline {
  --color-background: var(--void);
  --color-foreground: var(--ink);
  --color-border: var(--line);
  --color-popover: var(--panel-hi);
  --color-popover-foreground: var(--ink);
  --color-muted-foreground: var(--dim);
  /* Axis labels are 10px; Silkscreen is only crisp at 8/12/16/20. */
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ---------- Bar extras ---------- */

.bar-end .upload-trigger {
  background: var(--indigo);
  color: #fff;
}
.bar-end .upload-trigger:hover {
  background: #6b64e6;
}

.menu {
  position: relative;
}
.menu > summary {
  list-style: none;
  cursor: pointer;
}
.menu > summary::-webkit-details-marker {
  display: none;
}
.avatar {
  display: block;
  width: 32px;
  height: 32px;
  image-rendering: pixelated;
  clip-path: var(--notch-sm);
}
.menu-pop {
  position: absolute;
  right: 0;
  top: calc(100% + var(--step));
  z-index: 30;
  min-width: 224px;
  filter: drop-shadow(4px 4px 0 #00000066);
}
.menu-in {
  display: grid;
  gap: 4px;
  padding: var(--step);
}
.menu-who {
  padding: var(--step);
  color: var(--ink);
  font-size: 13px;
  border-bottom: 2px solid var(--line);
  margin-bottom: 4px;
}
.menu-item {
  appearance: none;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  padding: var(--step);
  cursor: pointer;
}
.menu-item:hover,
.menu-item:focus-visible {
  background: var(--panel-hi);
}

/* ---------- Tabs ---------- */

.dash-tabs {
  position: sticky;
  top: var(--bar-h);
  z-index: 9;
  display: flex;
  gap: var(--step);
  padding: var(--step) calc(var(--step) * 2) 0;
  background: var(--void);
  border-bottom: 2px solid var(--line);
}
.dash-tabs a {
  font-family: "Silkscreen", ui-monospace, monospace;
  -webkit-font-smoothing: none;
  font-size: 12px;
  color: var(--dim);
  text-decoration: none;
  padding: var(--step) calc(var(--step) * 2);
  border: 2px solid transparent;
  border-bottom: 0;
  margin-bottom: -2px;
}
.dash-tabs a:hover {
  color: var(--ink);
}
.dash-tabs a[aria-current="page"] {
  color: var(--cyan);
  background: var(--panel);
  border-color: var(--line);
  border-bottom: 2px solid var(--panel);
}

/* ---------- Storage strip ---------- */

.strip {
  margin: calc(var(--step) * 2) calc(var(--step) * 2) 0;
}
.strip-in {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--step) calc(var(--step) * 2);
  padding: calc(var(--step) * 1.5) calc(var(--step) * 2);
}
.strip-label {
  font-size: 12px;
  color: var(--dim);
}
.strip-num {
  font-family: "Silkscreen", ui-monospace, monospace;
  -webkit-font-smoothing: none;
  font-size: 12px;
  color: var(--ink);
}
.strip-spark {
  position: relative;
  width: 96px;
  height: 24px;
  margin-left: auto;
}

/* Pixel meter: same stepped fill as the upload progress bar. */
.meter {
  flex: 1 1 160px;
  min-width: 120px;
  height: 16px;
  background: #0a0b14;
  border: 2px solid var(--line);
  padding: 2px;
}
.meter-fill {
  height: 100%;
  background: repeating-linear-gradient(
    90deg,
    var(--cyan) 0 8px,
    #2ea9d9 8px 16px
  );
}
.meter.warn .meter-fill {
  background: repeating-linear-gradient(
    90deg,
    var(--gold) 0 8px,
    #d8ad10 8px 16px
  );
}

/* ---------- Segmented control ---------- */

.seg {
  display: inline-flex;
  border: 2px solid var(--line);
  background: #0a0b14;
}
.seg button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dim);
  font-family: "Silkscreen", ui-monospace, monospace;
  -webkit-font-smoothing: none;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
}
.seg button[aria-checked="true"],
.seg button[aria-pressed="true"] {
  background: var(--indigo);
  color: #fff;
}
.seg button:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: -2px;
}

/* ---------- Selection ---------- */

.tile.selected {
  background: var(--gold);
}
.tile-check {
  position: absolute;
  right: var(--step);
  top: var(--step);
  width: 24px;
  height: 24px;
  background: #0a0b14cc;
  border: 2px solid var(--ink);
}
.tile-check.on {
  background: var(--gold);
  border-color: var(--gold);
  box-shadow: inset 0 0 0 4px #0a0b14;
}
.tile.fresh {
  animation: fresh 1.2s steps(4) 1;
}
@keyframes fresh {
  from {
    background: var(--gold);
  }
  to {
    background: var(--line);
  }
}

.select-bar {
  position: fixed;
  left: 50%;
  bottom: calc(var(--step) * 3);
  transform: translateX(-50%);
  z-index: 20;
  width: min(640px, calc(100% - var(--step) * 4));
  filter: drop-shadow(6px 6px 0 #00000080);
}
.select-bar-in {
  display: flex;
  align-items: center;
  gap: var(--step);
  padding: var(--step) calc(var(--step) * 2);
}
.select-bar-count {
  font-family: "Silkscreen", ui-monospace, monospace;
  -webkit-font-smoothing: none;
  font-size: 12px;
  color: var(--gold);
  margin-right: auto;
}

/* ---------- Lightbox ---------- */

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  grid-template-columns: 1fr 320px;
  background: #07080fe6;
}
.lightbox:focus {
  outline: none;
}
.lb-stage {
  display: grid;
  place-items: center;
  padding: calc(var(--step) * 4);
  min-width: 0;
  min-height: 0;
}
.lb-stage img,
.lb-stage video {
  max-width: 100%;
  max-height: calc(100vh - var(--step) * 8);
  object-fit: contain;
  border: 2px solid var(--line);
  background: #0a0b14;
}
.lb-side {
  margin: calc(var(--step) * 2);
  align-self: start;
}
.lb-side-in {
  display: grid;
  gap: calc(var(--step) * 2);
  padding: calc(var(--step) * 2);
}
.lb-name {
  margin: 0;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.lb-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px calc(var(--step) * 2);
  margin: 0;
  font-size: 13px;
}
.lb-facts dt {
  color: var(--dim);
}
.lb-facts dd {
  margin: 0;
}
.lb-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.lb-close,
.lb-prev,
.lb-next {
  position: absolute;
}
.lb-close {
  top: calc(var(--step) * 2);
  left: calc(var(--step) * 2);
}
.lb-prev {
  left: calc(var(--step) * 2);
  top: 50%;
}
.lb-next {
  right: calc(320px + var(--step) * 2);
  top: 50%;
}

/* ---------- Drop overlay ---------- */

.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: #0e0f1acc;
  pointer-events: none;
}
.drop-overlay-in {
  width: min(560px, calc(100% - var(--step) * 4));
}
.drop-overlay-in > div {
  display: grid;
  place-items: center;
  padding: calc(var(--step) * 10) calc(var(--step) * 3);
  border: 2px dashed var(--cyan);
  font-size: 16px;
  color: var(--cyan);
}

/* ---------- Upload tray ---------- */

.tray {
  position: fixed;
  right: calc(var(--step) * 2);
  bottom: calc(var(--step) * 2);
  z-index: 25;
  width: min(400px, calc(100% - var(--step) * 4));
  filter: drop-shadow(6px 6px 0 #00000080);
}
.tray-in {
  display: grid;
}
.tray-head {
  display: flex;
  align-items: center;
  gap: var(--step);
  padding: var(--step) calc(var(--step) * 1.5);
  border-bottom: 2px solid var(--line);
}
.tray-toggle {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  display: flex;
  gap: var(--step);
  align-items: center;
  cursor: pointer;
  padding: 4px 0;
  margin-right: auto;
}
.tray-ttl {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tray-ttl .toolbar-select {
  padding: 4px 6px;
  font-size: 12px;
}
.tray-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow: auto;
}
.tray-hint {
  padding: calc(var(--step) * 1.5);
}
.tray-row {
  display: grid;
  grid-template-columns: 40px 1fr auto;
  gap: var(--step);
  align-items: center;
  padding: var(--step) calc(var(--step) * 1.5);
  border-bottom: 1px solid var(--line);
}
.tray-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  background: #0a0b14;
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  font-size: 8px;
  color: var(--cyan);
}
.tray-main {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.tray-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tray-main .progress {
  height: 12px;
}
.tray-acts {
  display: flex;
  gap: 4px;
}
.tray-row.cancelled .tray-name {
  color: var(--dim);
  text-decoration: line-through;
}

/* ---------- Toasts ---------- */

.toasts {
  position: fixed;
  left: calc(var(--step) * 2);
  bottom: calc(var(--step) * 2);
  z-index: 60;
  display: grid;
  gap: var(--step);
  width: min(360px, calc(100% - var(--step) * 4));
}
.toast {
  filter: drop-shadow(4px 4px 0 #00000080);
}
.toast-in {
  padding: calc(var(--step) * 1.5) calc(var(--step) * 2);
  font-size: 13px;
}
.toast.success {
  background: var(--gold);
}
.toast.error {
  background: var(--danger);
}

/* ---------- Usage ---------- */

.usage {
  display: grid;
  gap: calc(var(--step) * 2);
  padding: calc(var(--step) * 2);
}
.usage-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--step);
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: calc(var(--step) * 2);
}
.stat-in {
  display: grid;
  gap: var(--step);
  padding: calc(var(--step) * 2);
}
.stat-label {
  font-size: 12px;
  color: var(--dim);
}
.stat-value {
  font-family: "Silkscreen", ui-monospace, monospace;
  -webkit-font-smoothing: none;
  font-size: 20px;
  line-height: 1.2;
}
.delta-up {
  color: var(--cyan);
}
.delta-down {
  color: var(--gold);
}
.chart-row {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: calc(var(--step) * 2);
}
.chart-in {
  display: grid;
  gap: calc(var(--step) * 2);
  padding: calc(var(--step) * 2);
}
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--step);
}
.chart-head h2 {
  margin: 0;
  font-size: 12px;
}
.chart-box {
  position: relative;
  height: 240px;
}
.chart-empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--dim);
  font-size: 13px;
}
.skeleton {
  position: absolute;
  inset: 0;
}
.limits-in {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--step) calc(var(--step) * 2);
  padding: calc(var(--step) * 2);
  font-size: 13px;
}

@media (max-width: 800px) {
  .chart-row {
    grid-template-columns: 1fr;
  }
  .lightbox {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
    overflow: auto;
  }
  .lb-next {
    right: calc(var(--step) * 2);
  }
}

@media (max-width: 640px) {
  .dash-tabs a {
    flex: 1;
    text-align: center;
  }
  .tray {
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
  }
  .select-bar {
    bottom: calc(var(--step) * 1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tile.fresh {
    animation: none;
  }
}
```

- [ ] **Step 9: Write `web/src/lib/store.ts` and `web/src/lib/toast.ts`**

```ts
// store.ts
import { useSyncExternalStore } from "react";

/** Tiny external store: module-level, so every island on a page shares it. */
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      state =
        typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
```

```ts
// toast.ts
import { createStore } from "./store";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
}

export const toastStore = createStore<Toast[]>([]);
/** Screen-reader-only announcements (armed delete, results). */
export const announceStore = createStore("");

let nextId = 1;

export function toast(
  message: string,
  kind: Toast["kind"] = "info",
  ms = 4000,
): void {
  const id = nextId++;
  toastStore.set((list) => [...list.slice(-3), { id, message, kind }]);
  setTimeout(
    () => toastStore.set((list) => list.filter((t) => t.id !== id)),
    ms,
  );
}

export function announce(message: string): void {
  // Clearing first makes a repeated message announce again.
  announceStore.set("");
  queueMicrotask(() => announceStore.set(message));
}
```

- [ ] **Step 10: Write `web/src/islands/Toasts.tsx` and `web/src/islands/UserAvatar.tsx`**

```tsx
// Toasts.tsx
import { announceStore, toastStore } from "../lib/toast";
import { useStore } from "../lib/store";

export default function Toasts() {
  const toasts = useStore(toastStore);
  const said = useStore(announceStore);
  return (
    <>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast panel ${t.kind}`}>
            <div className="toast-in">{t.message}</div>
          </div>
        ))}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {said}
      </div>
    </>
  );
}
```

```tsx
// UserAvatar.tsx
import { DitherAvatar } from "../components/dither-kit";

/** Fallback for Discord users with no avatar: deterministic per user id. */
export default function UserAvatar({ seed }: { seed: string }) {
  return <DitherAvatar name={seed} size={32} className="avatar" />;
}
```

- [ ] **Step 11: Write `web/src/layouts/Dashboard.astro`**

```astro
---
import { ClientRouter } from "astro:transitions";
import Shell from "./Shell.astro";
import BrandBar from "../components/BrandBar.astro";
import Toasts from "../islands/Toasts";
import UserAvatar from "../islands/UserAvatar";
import "../styles/dashboard.css";

interface Props {
  title: string;
  tab: "files" | "usage";
}
const { title, tab } = Astro.props;
const user = Astro.locals.user!;
const avatarUrl = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
---

<Shell title={title}>
  <ClientRouter slot="head" />
  <BrandBar name="Dashboard" sub={`@${user.username}`}>
    <Fragment slot="end">
      <button class="button small upload-trigger" type="button" data-upload-trigger>Upload</button>
      <details class="menu">
        <summary aria-label="Account menu">
          {avatarUrl ? <img class="avatar" src={avatarUrl} alt="" width="32" height="32" /> : <UserAvatar client:load seed={user.id} />}
        </summary>
        <div class="menu-pop panel">
          <div class="menu-in">
            <p class="menu-who">{user.globalName || user.username}</p>
            <form method="post" action="/auth/logout" data-astro-reload>
              <button class="menu-item" type="submit">Sign out</button>
            </form>
            <form method="post" action="/auth/logout" data-astro-reload>
              <input type="hidden" name="everywhere" value="1" />
              <button class="menu-item" type="submit">Sign out everywhere</button>
            </form>
          </div>
        </div>
      </details>
    </Fragment>
  </BrandBar>
  <nav class="dash-tabs" aria-label="Dashboard">
    <a href="/dashboard" aria-current={tab === "files" ? "page" : undefined}>Files</a>
    <a href="/dashboard/usage" aria-current={tab === "usage" ? "page" : undefined}>Usage</a>
  </nav>
  <slot />
  <slot name="tray" />
  <Toasts client:load transition:persist="toasts" />
</Shell>
```

- [ ] **Step 12: Placeholder pages**

`web/src/pages/dashboard/index.astro`:

```astro
---
import Dashboard from "../../layouts/Dashboard.astro";
import { dashboardHeaders } from "../../lib/server/headers";
if (!Astro.locals.user) return Astro.redirect("/login?next=%2Fdashboard", 302);
dashboardHeaders(Astro.response.headers);
---

<Dashboard title="Dashboard" tab="files"><main class="empty"><h2>Files</h2></main></Dashboard>
```

`web/src/pages/dashboard/usage.astro` is the same, with `tab="usage"`, title `"Usage"`, and the redirect `next=%2Fdashboard%2Fusage`.

- [ ] **Step 13: E2E sign-in helper**

In `test/e2e/server.ts`, add the route below. Later tasks' manual checks and Task 20's specs use it.

```ts
import { createAuthSession } from "../../src/auth/sessions.js";

root.post("/__e2e/login", async (c) => {
  const id = c.req.query("user") ?? E2E_USER;
  const token = await createAuthSession(h.deps.redis, {
    id,
    username: "e2e",
    globalName: "E2E",
    avatar: "",
  });
  return c.json({ token });
});
```

To sign in by hand for a manual check:

1. Run `pnpm e2e:server`.
2. Run `curl -s -X POST localhost:4173/__e2e/login` and copy the token.
3. In Chrome at `http://localhost:4173`, open DevTools → Application → Cookies and add `__Host-session=<token>` with Secure ticked and Path `/`.

- [ ] **Step 14: Run tests, typecheck, and visuals**

Run: `pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: all green. Legacy screenshots are unchanged, because `dashboard.css` loads only on dashboard pages.

- [ ] **Step 15: Commit**

```bash
git add -A scripts web .prettierignore package.json pnpm-lock.yaml test/pages.test.ts test/e2e/server.ts
git commit -m "feat: dashboard shell with tabs, account menu, toasts and dither-kit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Client logic modules (pure, unit-tested)

**Files:**

- Create:
  - `web/src/lib/format.ts`, `web/src/lib/selection.ts`, `web/src/lib/queue.ts`, `web/src/lib/preflight.ts`
  - `web/src/lib/api.ts`, `web/src/lib/uploader.ts`, `web/src/lib/state.ts`
  - `public/gallery-filters.d.ts`, `public/measure.d.ts`
- Modify: `vitest.config.ts`
- Test: `web/src/lib/format.test.ts`, `web/src/lib/selection.test.ts`, `web/src/lib/queue.test.ts`, `web/src/lib/preflight.test.ts`

**Interfaces:**

- Produces:
  - `format.ts`:
    - re-exports `formatBytes` and `formatDate`
    - `formatDay(date: string): string` (`"2026-09-27"` → `"27 Sep"`)
    - `formatClock(ms: number): string` (`"41:12"`)
    - `formatDelta(cur: number, prev: number, fmt?: (n: number) => string): { text: string; dir: "up" | "down" | "flat" }`
  - `selection.ts`:
    - `toggleId(sel: ReadonlySet<string>, id: string): Set<string>`
    - `rangeSelect(order: readonly string[], anchor: string | null, id: string, sel: ReadonlySet<string>): Set<string>`
  - `queue.ts`:
    - `QueueStatus`, `QueueItem { key, name, size, type, status, progress, error, retryable, result }`, `QueueAction`
    - `queueReducer`, `nextToStart`, `isBusy`
  - `preflight.ts`:
    - `ACCEPTED_TYPES: ReadonlySet<string>`, `ACCEPT_ATTR: string`
    - `preflight(files, limits: { maxFileBytes: number; maxUserBytes: number; uploadsRemaining: number | null }, quotaFree: number): { errors: (string | null)[]; willEvict: boolean }`
  - `api.ts`:
    - `class ApiError { status }`
    - `handleUnauthorized()`, `request<T>()`, `getJson<T>()`, `deleteFile(id)`, `deleteFiles(ids)`
  - `uploader.ts`: `uploadFile(file, fields: { ttl: string; width: number; height: number }, onProgress): { promise: Promise<ApiFile>; abort(): void }`
  - `state.ts`:
    - `filesStore: Store<ApiFile[]>`, `summaryStore: Store<ApiUsage | null>`, `nowStore`
    - `useNow(): number`, `addFile(file)`, `removeFiles(ids)`, `refreshSummary(): Promise<void>`

- [ ] **Step 1: Let Vitest find web tests and the `@server` alias**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@server": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "web/src/lib/**/*.test.ts"],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 2: Write the failing tests**

`web/src/lib/selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rangeSelect, toggleId } from "./selection";

const order = ["a", "b", "c", "d", "e"];

describe("selection", () => {
  it("toggles one id without mutating the input", () => {
    const start = new Set(["a"]);
    expect([...toggleId(start, "b")].sort()).toEqual(["a", "b"]);
    expect([...toggleId(start, "a")]).toEqual([]);
    expect([...start]).toEqual(["a"]);
  });
  it("adds the inclusive range between anchor and target in either direction", () => {
    expect([...rangeSelect(order, "b", "d", new Set())].sort()).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect([...rangeSelect(order, "d", "b", new Set(["a"]))].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
  it("falls back to a toggle when the anchor is missing or filtered out", () => {
    expect([...rangeSelect(order, null, "c", new Set())]).toEqual(["c"]);
    expect([...rangeSelect(order, "zzz", "c", new Set())]).toEqual(["c"]);
  });
});
```

`web/src/lib/queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isBusy, nextToStart, queueReducer, type QueueItem } from "./queue";

const add = (state: QueueItem[], key: string, error: string | null = null) =>
  queueReducer(state, {
    type: "add",
    items: [{ key, name: `${key}.png`, size: 1, type: "image/png", error }],
  });

describe("upload queue", () => {
  it("adds items as queued, or failed-not-retryable when pre-checks failed", () => {
    let s = add([], "a");
    s = add(s, "b", "Only images and videos are accepted");
    expect(s.map((i) => [i.status, i.retryable])).toEqual([
      ["queued", true],
      ["failed", false],
    ]);
  });
  it("starts one at a time in order", () => {
    let s = add(add([], "a"), "b");
    expect(nextToStart(s)?.key).toBe("a");
    s = queueReducer(s, { type: "start", key: "a" });
    expect(nextToStart(s)).toBeUndefined();
    s = queueReducer(s, {
      type: "done",
      key: "a",
      result: { id: "x" } as never,
    });
    expect(nextToStart(s)?.key).toBe("b");
  });
  it("clamps progress and ignores it unless uploading", () => {
    let s = add([], "a");
    s = queueReducer(s, { type: "progress", key: "a", progress: 0.5 });
    expect(s[0]!.progress).toBe(0);
    s = queueReducer(s, { type: "start", key: "a" });
    s = queueReducer(s, { type: "progress", key: "a", progress: 7 });
    expect(s[0]!.progress).toBe(1);
  });
  it("keeps a cancelled item cancelled when its abort surfaces as a failure", () => {
    let s = queueReducer(add([], "a"), { type: "start", key: "a" });
    s = queueReducer(s, { type: "cancel", key: "a" });
    s = queueReducer(s, { type: "fail", key: "a", error: "Cancelled" });
    expect(s[0]!.status).toBe("cancelled");
  });
  it("retries failed and cancelled items but not pre-check failures", () => {
    let s = add(add([], "a"), "bad", "nope");
    s = queueReducer(s, { type: "start", key: "a" });
    s = queueReducer(s, { type: "fail", key: "a", error: "429" });
    s = queueReducer(s, { type: "retry", key: "a" });
    s = queueReducer(s, { type: "retry", key: "bad" });
    expect(s.map((i) => i.status)).toEqual(["queued", "failed"]);
  });
  it("reports busy and clears finished rows", () => {
    let s = add(add([], "a"), "b");
    expect(isBusy(s)).toBe(true);
    s = queueReducer(s, { type: "start", key: "a" });
    s = queueReducer(s, { type: "done", key: "a", result: {} as never });
    s = queueReducer(s, { type: "clearFinished" });
    expect(s.map((i) => i.key)).toEqual(["b"]);
  });
});
```

`web/src/lib/preflight.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { preflight } from "./preflight";

const MB = 1024 * 1024;
const limits = {
  maxFileBytes: 10 * MB,
  maxUserBytes: 20 * MB,
  uploadsRemaining: 2 as number | null,
};
const f = (name: string, size: number, type = "image/png") => ({
  name,
  size,
  type,
});

describe("preflight", () => {
  it("rejects wrong types and oversize files with a reason", () => {
    const r = preflight(
      [f("a.txt", 1, "text/plain"), f("b.png", 11 * MB)],
      limits,
      100 * MB,
    );
    expect(r.errors[0]).toBe("Only images and videos are accepted");
    expect(r.errors[1]).toBe("Over the 10 MB file limit");
  });
  it("rejects a file larger than the whole quota", () => {
    const r = preflight(
      [f("a.png", 21 * MB)],
      { ...limits, maxFileBytes: 50 * MB },
      100 * MB,
    );
    expect(r.errors[0]).toBe("Bigger than your whole 20 MB quota");
  });
  it("stops at the hourly budget, counting only files that passed", () => {
    const r = preflight(
      [
        f("x.txt", 1, "text/plain"),
        f("a.png", 1),
        f("b.png", 1),
        f("c.png", 1),
      ],
      limits,
      100 * MB,
    );
    expect(r.errors).toEqual([
      "Only images and videos are accepted",
      null,
      null,
      "Over your hourly upload limit",
    ]);
  });
  it("treats a null budget as unlimited", () => {
    const r = preflight(
      [f("a.png", 1), f("b.png", 1), f("c.png", 1)],
      { ...limits, uploadsRemaining: null },
      100 * MB,
    );
    expect(r.errors).toEqual([null, null, null]);
  });
  it("warns, not blocks, when the batch needs older files evicted", () => {
    const r = preflight(
      [f("a.png", 6 * MB), f("b.png", 6 * MB)],
      limits,
      10 * MB,
    );
    expect(r.errors).toEqual([null, null]);
    expect(r.willEvict).toBe(true);
  });
});
```

`web/src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatClock, formatDay, formatDelta } from "./format";

describe("format", () => {
  it("formats a UTC day label", () =>
    expect(formatDay("2026-09-27")).toBe("27 Sep"));
  it("formats a clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(2_472_000)).toBe("41:12");
    expect(formatClock(-5)).toBe("0:00");
  });
  it("describes change vs the previous period", () => {
    expect(formatDelta(5, 3)).toEqual({ text: "▲ 2 vs prev", dir: "up" });
    expect(formatDelta(1, 3)).toEqual({ text: "▼ 2 vs prev", dir: "down" });
    expect(formatDelta(3, 3)).toEqual({ text: "same as prev", dir: "flat" });
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run web/src/lib`
Expected: FAIL. The modules are missing.

- [ ] **Step 4: Implement the pure modules**

```ts
// format.ts
export { formatBytes, formatDate } from "@server/web/format";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-09-27" → "27 Sep". Parsed as UTC so the label matches the server's bucket. */
export function formatDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatDelta(
  cur: number,
  prev: number,
  fmt: (n: number) => string = String,
): { text: string; dir: "up" | "down" | "flat" } {
  if (cur === prev) return { text: "same as prev", dir: "flat" };
  const up = cur > prev;
  return {
    text: `${up ? "▲" : "▼"} ${fmt(Math.abs(cur - prev))} vs prev`,
    dir: up ? "up" : "down",
  };
}
```

```ts
// selection.ts
export function toggleId(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Shift-click: add everything between the last-clicked tile and this one. */
export function rangeSelect(
  order: readonly string[],
  anchor: string | null,
  id: string,
  sel: ReadonlySet<string>,
): Set<string> {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a === -1 || b === -1) return toggleId(sel, id);
  const next = new Set(sel);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]!);
  return next;
}
```

```ts
// queue.ts
import type { ApiFile } from "@server/me/types";

export type QueueStatus =
  "queued" | "uploading" | "done" | "failed" | "cancelled";

export interface QueueItem {
  key: string;
  name: string;
  size: number;
  type: string;
  status: QueueStatus;
  progress: number;
  error: string | null;
  /** False for pre-check failures: sending them again cannot succeed. */
  retryable: boolean;
  result: ApiFile | null;
}

export type QueueAction =
  | {
      type: "add";
      items: {
        key: string;
        name: string;
        size: number;
        type: string;
        error: string | null;
      }[];
    }
  | { type: "start"; key: string }
  | { type: "progress"; key: string; progress: number }
  | { type: "done"; key: string; result: ApiFile }
  | { type: "fail"; key: string; error: string }
  | { type: "cancel"; key: string }
  | { type: "retry"; key: string }
  | { type: "clearFinished" };

const live = (s: QueueStatus) => s === "queued" || s === "uploading";

export function queueReducer(
  state: QueueItem[],
  action: QueueAction,
): QueueItem[] {
  const map = (
    key: string,
    when: (i: QueueItem) => boolean,
    patch: Partial<QueueItem>,
  ) => state.map((i) => (i.key === key && when(i) ? { ...i, ...patch } : i));
  switch (action.type) {
    case "add":
      return [
        ...state,
        ...action.items.map((i) => ({
          ...i,
          status: (i.error ? "failed" : "queued") as QueueStatus,
          progress: 0,
          retryable: !i.error,
          result: null,
        })),
      ];
    case "start":
      return map(action.key, (i) => i.status === "queued", {
        status: "uploading",
        progress: 0,
        error: null,
      });
    case "progress":
      return map(action.key, (i) => i.status === "uploading", {
        progress: Math.min(1, Math.max(0, action.progress)),
      });
    case "done":
      return map(action.key, (i) => i.status === "uploading", {
        status: "done",
        progress: 1,
        result: action.result,
      });
    case "fail":
      return map(action.key, (i) => i.status !== "cancelled", {
        status: "failed",
        error: action.error,
      });
    case "cancel":
      return map(action.key, (i) => live(i.status), { status: "cancelled" });
    case "retry":
      return map(
        action.key,
        (i) =>
          i.retryable && (i.status === "failed" || i.status === "cancelled"),
        {
          status: "queued",
          progress: 0,
          error: null,
        },
      );
    case "clearFinished":
      return state.filter((i) => live(i.status));
  }
}

export function nextToStart(state: QueueItem[]): QueueItem | undefined {
  if (state.some((i) => i.status === "uploading")) return undefined;
  return state.find((i) => i.status === "queued");
}

export function isBusy(state: QueueItem[]): boolean {
  return state.some((i) => live(i.status));
}
```

```ts
// preflight.ts
import { formatBytes } from "./format";

export const ACCEPTED_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
export const ACCEPT_ATTR = [...ACCEPTED_TYPES].join(",");

export interface PreflightLimits {
  maxFileBytes: number;
  maxUserBytes: number;
  /** null = no hourly limit. */
  uploadsRemaining: number | null;
}

/**
 * Catch what the server would refuse before sending a byte. Quota is not one
 * of those: the server evicts the uploader's own oldest files to make room, so
 * that only earns a warning.
 */
export function preflight(
  files: readonly { name: string; size: number; type: string }[],
  limits: PreflightLimits,
  quotaFree: number,
): { errors: (string | null)[]; willEvict: boolean } {
  let accepted = 0;
  let bytes = 0;
  const errors = files.map((f) => {
    if (!ACCEPTED_TYPES.has(f.type))
      return "Only images and videos are accepted";
    if (f.size > limits.maxFileBytes)
      return `Over the ${formatBytes(limits.maxFileBytes)} file limit`;
    if (f.size > limits.maxUserBytes)
      return `Bigger than your whole ${formatBytes(limits.maxUserBytes)} quota`;
    if (limits.uploadsRemaining !== null && accepted >= limits.uploadsRemaining)
      return "Over your hourly upload limit";
    accepted += 1;
    bytes += f.size;
    return null;
  });
  return { errors, willEvict: bytes > quotaFree };
}
```

- [ ] **Step 5: Run the unit tests**

Run: `pnpm vitest run web/src/lib`
Expected: PASS.

- [ ] **Step 6: Declarations for the shared public modules**

`public/gallery-filters.d.ts`:

```ts
export interface FilterableRecord {
  name: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}
export function matchesFilter(name: string, query: string): boolean;
export function filterRecords<T extends { name: string }>(
  records: T[],
  query: string,
): T[];
export const SORT_MODES: string[];
export function sortRecords<T extends FilterableRecord>(
  records: T[],
  mode: string,
): T[];
export function formatRemaining(expiresAt: number, now?: number): string;
```

`public/measure.d.ts`:

```ts
export function readDimensions(
  file: File,
  url: string,
): Promise<{ width: number; height: number }>;
```

- [ ] **Step 7: Implement the browser modules**

```ts
// api.ts
import type { ApiFile } from "@server/me/types";
import { toast } from "./toast";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let redirecting = false;
export function handleUnauthorized(): void {
  if (redirecting) return;
  redirecting = true;
  toast("Session ended, sign in again", "error");
  const next = encodeURIComponent(location.pathname + location.search);
  setTimeout(() => location.assign(`/login?next=${next}`), 1200);
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "Network error. Check your connection.");
  }
  if (res.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, "Session ended");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok)
    throw new ApiError(
      res.status,
      body.error ?? `Request failed (${res.status})`,
    );
  return body as T;
}

export const getJson = <T>(path: string) => request<T>(path);

export const deleteFile = (id: string) =>
  request<void>(`/api/me/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const deleteFiles = (ids: string[]) =>
  request<{ deleted: string[]; missing: string[] }>("/api/me/files/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });

export type { ApiFile };
```

```ts
// uploader.ts
import type { ApiFile } from "@server/me/types";
import { ApiError, handleUnauthorized } from "./api";

export interface UploadHandle {
  promise: Promise<ApiFile>;
  abort(): void;
}

/** XHR rather than fetch: fetch still has no upload progress events. */
export function uploadFile(
  file: File,
  fields: { ttl: string; width: number; height: number },
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<ApiFile>((resolve, reject) => {
    xhr.open("POST", "/api/me/files");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      let body: { file?: ApiFile; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* status decides below */
      }
      if (xhr.status === 201 && body.file) return resolve(body.file);
      if (xhr.status === 401) handleUnauthorized();
      reject(
        new ApiError(xhr.status, body.error ?? `Upload failed (${xhr.status})`),
      );
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError(0, "Network error during upload")),
    );
    xhr.addEventListener("abort", () => reject(new ApiError(-1, "Cancelled")));

    const form = new FormData();
    // Fields precede the file so the server knows ttl and dimensions before the bytes.
    form.append("ttl", fields.ttl);
    form.append("width", String(fields.width || 0));
    form.append("height", String(fields.height || 0));
    form.append("file", file, file.name || "pasted-image.png");
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
```

```ts
// state.ts
import type { ApiFile, ApiUsage } from "@server/me/types";
import { getJson } from "./api";
import { createStore, useStore } from "./store";

/** The Files tab's list. Uploads insert here, so the grid updates without a refetch. */
export const filesStore = createStore<ApiFile[]>([]);
/** 7-day usage summary: storage strip, tray pre-checks. */
export const summaryStore = createStore<ApiUsage | null>(null);

export function addFile(file: ApiFile): void {
  filesStore.set((list) => [file, ...list.filter((f) => f.id !== file.id)]);
}

export function removeFiles(ids: readonly string[]): void {
  const gone = new Set(ids);
  filesStore.set((list) => list.filter((f) => !gone.has(f.id)));
}

let inflight: Promise<void> | null = null;
export function refreshSummary(): Promise<void> {
  inflight ??= getJson<ApiUsage>("/api/me/usage?range=7d")
    .then((u) => summaryStore.set(u))
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** One shared 1s clock, so countdowns do not each run their own interval. */
export const nowStore = createStore(Date.now());
let ticking = false;
export function useNow(): number {
  if (!ticking && typeof window !== "undefined") {
    ticking = true;
    setInterval(() => nowStore.set(Date.now()), 1000);
  }
  return useStore(nowStore);
}
```

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm typecheck && pnpm vitest run web/src/lib`
Expected: exit 0, PASS.

```bash
git add web/src/lib public/*.d.ts vitest.config.ts
git commit -m "feat: dashboard client logic (queue, selection, pre-checks, API client)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Files tab (strip, toolbar, grid, selection, delete)

**Files:**

- Create:
  - `web/src/islands/FilesView.tsx`, `web/src/islands/FileTile.tsx`, `web/src/islands/StorageStrip.tsx`
  - `web/src/islands/ArmButton.tsx`, `web/src/islands/CopyButton.tsx`, `web/src/islands/Expiry.tsx`
- Modify: `web/src/pages/dashboard/index.astro`
- Test: `test/pages.test.ts` (append)

**Interfaces:**

- Consumes: `filesStore`, `summaryStore`, `useNow`, `refreshSummary`, `removeFiles` (state), `deleteFile`/`deleteFiles` (api), `rangeSelect`/`toggleId`, `toast`/`announce`, `filterRecords`/`sortRecords`/`formatRemaining` (`public/gallery-filters.js`), and `Sparkline` (dither-kit).
- Produces:
  - `<FilesView initialFiles={ApiFile[]} initialSummary={ApiUsage} />`
  - `<ArmButton describe onConfirm label? armedLabel? />`
  - `<CopyButton text label />`
  - `<Expiry at />`
  - `FilesView` also mounts `Lightbox` from Task 17. Until then, `openId` is kept in state and ignored.

- [ ] **Step 1: Write the failing SSR test (Review Focus #3)**

Append to `test/pages.test.ts`:

```ts
describe("/dashboard files", () => {
  it("server-renders my tiles and escapes hostile names in markup and props", async () => {
    h = await makeHarness();
    await seed({ userId: "7" });
    const t = await createAuthSession(h.deps.redis, {
      id: "7",
      username: "neo",
      globalName: "",
      avatar: "",
    });
    const html = await (
      await h.app.fetch(
        new Request("https://uploader.test/dashboard", {
          headers: { Cookie: `__Host-session=${t}` },
        }),
      )
    ).text();
    expect(html).toContain('data-id="evilevilevilevilevilev"');
    expect(html).not.toContain("<img src=x onerror");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm build:web && pnpm vitest run test/pages.test.ts`
Expected: FAIL. The placeholder page has no tiles.

- [ ] **Step 3: Small shared islands**

```tsx
// ArmButton.tsx
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { announce } from "../lib/toast";

const ARM_EVENT = "dash:arm";

/**
 * Deleting is irreversible, so the first click only arms. It disarms after 4s,
 * or as soon as another ArmButton arms, matching the legacy gallery.
 */
export default function ArmButton({
  describe,
  onConfirm,
  label = "Delete",
  armedLabel = "Delete?",
}: {
  describe: string;
  onConfirm: () => Promise<void> | void;
  label?: string;
  armedLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const me = useRef(Symbol());

  useEffect(() => {
    const onArm = (e: Event) => {
      if ((e as CustomEvent).detail !== me.current) setArmed(false);
    };
    window.addEventListener(ARM_EVENT, onArm);
    return () => {
      window.removeEventListener(ARM_EVENT, onArm);
      clearTimeout(timer.current);
    };
  }, []);

  async function click(e: MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    if (!armed) {
      window.dispatchEvent(new CustomEvent(ARM_EVENT, { detail: me.current }));
      setArmed(true);
      announce(
        `Press ${label.toLowerCase()} again to remove ${describe}. This cannot be undone.`,
      );
      timer.current = window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`button small danger${armed ? " armed" : ""}`}
      onClick={click}
      disabled={busy}
    >
      {busy ? "…" : armed ? armedLabel : label}
    </button>
  );
}
```

```tsx
// CopyButton.tsx
import { useState, type MouseEvent } from "react";
import { toast } from "../lib/toast";

export default function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  async function click(e: MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is refused outside a secure context or without focus.
      toast(`Copy failed. Link: ${text}`, "error", 8000);
    }
  }
  return (
    <button
      type="button"
      className={`button small${copied ? " copied" : ""}`}
      onClick={click}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
```

```tsx
// Expiry.tsx
import { formatRemaining } from "../../../public/gallery-filters.js";
import { useNow } from "../lib/state";

export default function Expiry({ at }: { at: number }) {
  const now = useNow();
  return <>{formatRemaining(at, now)}</>;
}
```

- [ ] **Step 4: `StorageStrip.tsx`**

```tsx
import { Sparkline } from "../components/dither-kit";
import { formatBytes } from "../lib/format";
import { summaryStore } from "../lib/state";
import { useStore } from "../lib/store";

export default function StorageStrip() {
  const s = useStore(summaryStore);
  if (!s) return null;
  const { used, quota, images, videos } = s.storage;
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const up = s.rateLimits.uploads;
  return (
    <section className="strip panel" aria-label="Storage">
      <div className="strip-in">
        <span className="pixel strip-label">Storage</span>
        <div
          className={`meter${pct >= 90 ? " warn" : ""}`}
          role="meter"
          aria-label="Storage used"
          aria-valuemin={0}
          aria-valuemax={quota}
          aria-valuenow={used}
          aria-valuetext={`${formatBytes(used)} of ${formatBytes(quota)}`}
        >
          {/* Sub-1% use still shows one step, as /stats does. */}
          <div
            className="meter-fill"
            style={{ width: `${used > 0 ? Math.max(pct, 2) : 0}%` }}
          />
        </div>
        <span className="strip-num">
          {formatBytes(used)} / {formatBytes(quota)}
        </span>
        <span className="muted">
          img {formatBytes(images.bytes)} · vid {formatBytes(videos.bytes)}
        </span>
        <span className="muted">
          {up.remaining === null
            ? "No hourly upload limit"
            : `${up.remaining}/${up.limit} uploads left this hour`}
        </span>
        <div className="strip-spark" aria-hidden="true">
          <Sparkline data={s.series.map((p) => p.uploads)} color="cyan" />
        </div>
        <span className="muted">7d</span>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: `FileTile.tsx`**

```tsx
import { memo, type KeyboardEvent, type MouseEvent } from "react";
import type { ApiFile } from "@server/me/types";
import { formatBytes, formatDate } from "../lib/format";
import ArmButton from "./ArmButton";
import CopyButton from "./CopyButton";
import Expiry from "./Expiry";

interface Props {
  file: ApiFile;
  selecting: boolean;
  selected: boolean;
  fresh: boolean;
  onActivate(e: MouseEvent | KeyboardEvent): void;
  onOpen(): void;
  onDelete(): Promise<void>;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
}

/** Same markup and classes as the legacy gallery tile, so it inherits its look. */
function FileTile({
  file,
  selecting,
  selected,
  fresh,
  onActivate,
  onOpen,
  onDelete,
  onKeyDown,
}: Props) {
  const share = file.watchUrl ?? file.url;
  const video = file.kind === "video";
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <figure
      className={`tile panel${selected ? " selected" : ""}${fresh ? " fresh" : ""}`}
      tabIndex={0}
      role="gridcell"
      aria-label={file.name}
      aria-selected={selecting ? selected : undefined}
      data-tile
      data-id={file.id}
      onKeyDown={onKeyDown}
      onClick={onActivate}
    >
      <div className="tile-in">
        <a
          className="shot"
          href={share}
          tabIndex={-1}
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          {video ? (
            <>
              <video
                preload="metadata"
                muted
                playsInline
                src={`${file.url}#t=0.1`}
              />
              <span className="badge">VIDEO</span>
            </>
          ) : (
            <img
              loading="lazy"
              decoding="async"
              src={file.url}
              alt={file.name}
            />
          )}
          {selecting && (
            <span
              className={`tile-check${selected ? " on" : ""}`}
              aria-hidden="true"
            />
          )}
        </a>
        <div className="tile-body">
          <figcaption className="tile-name" title={file.name}>
            {file.name}
          </figcaption>
          <div className="tile-meta">
            <span>{formatBytes(file.size)}</span>
            <span>{formatDate(file.createdAt)}</span>
            <span className="tile-expiry">
              <Expiry at={file.expiresAt} />
            </span>
          </div>
          {!selecting && (
            <div className="tile-actions">
              <button
                type="button"
                className="button small"
                onClick={stop(onOpen)}
              >
                View
              </button>
              <CopyButton
                text={share}
                label={video ? "Copy page" : "Copy link"}
              />
              <ArmButton describe={file.name} onConfirm={onDelete} />
            </div>
          )}
        </div>
      </div>
    </figure>
  );
}

export default memo(FileTile);
```

- [ ] **Step 6: `FilesView.tsx`**

```tsx
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ApiFile, ApiUsage } from "@server/me/types";
import { filterRecords, sortRecords } from "../../../public/gallery-filters.js";
import { deleteFile, deleteFiles } from "../lib/api";
import { formatBytes } from "../lib/format";
import { rangeSelect, toggleId } from "../lib/selection";
import {
  filesStore,
  refreshSummary,
  removeFiles,
  summaryStore,
} from "../lib/state";
import { useStore } from "../lib/store";
import { announce, toast } from "../lib/toast";
import ArmButton from "./ArmButton";
import FileTile from "./FileTile";
import Lightbox from "./Lightbox";
import StorageStrip from "./StorageStrip";

type Kind = "all" | "image" | "video";
const SORTS = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
  ["largest", "Largest"],
  ["smallest", "Smallest"],
  ["soonest", "Soonest to expire"],
] as const;

export default function FilesView({
  initialFiles,
  initialSummary,
}: {
  initialFiles: ApiFile[];
  initialSummary: ApiUsage;
}) {
  const [mounted, setMounted] = useState(false);
  const stored = useStore(filesStore);
  const files = mounted ? stored : initialFiles;

  useEffect(() => {
    // Navigation re-renders the page on the server, so its list is the freshest.
    filesStore.set(initialFiles);
    summaryStore.set(initialSummary);
    setMounted(true);
  }, [initialFiles, initialSummary]);

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState("newest");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const filterRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const known = useRef(new Set(initialFiles.map((f) => f.id)));

  // Highlight files that arrive after mount (finished uploads).
  useEffect(() => {
    if (!mounted) return;
    const arrived = files
      .filter((f) => !known.current.has(f.id))
      .map((f) => f.id);
    for (const f of files) known.current.add(f.id);
    if (arrived.length === 0) return;
    setFresh((s) => new Set([...s, ...arrived]));
    const t = setTimeout(
      () =>
        setFresh((s) => new Set([...s].filter((id) => !arrived.includes(id)))),
      1300,
    );
    return () => clearTimeout(t);
  }, [files, mounted]);

  const visible = useMemo(() => {
    const byKind =
      kind === "all" ? files : files.filter((f) => f.kind === kind);
    return sortRecords(filterRecords(byKind, query), sort);
  }, [files, kind, query, sort]);
  const order = useMemo(() => visible.map((f) => f.id), [visible]);

  // ----- lightbox <-> URL hash: Back closes it, reload reopens it -----
  const pushed = useRef(false);
  useEffect(() => {
    const read = () => {
      const m = location.hash.match(/^#f=(.+)$/);
      setOpenId(m ? decodeURIComponent(m[1]!) : null);
      if (!m) pushed.current = false;
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const open = useCallback((id: string) => {
    pushed.current = true;
    location.hash = `f=${encodeURIComponent(id)}`;
  }, []);
  const navigate = useCallback((id: string) => {
    history.replaceState(history.state, "", `#f=${encodeURIComponent(id)}`);
    setOpenId(id);
  }, []);
  const close = useCallback(() => {
    if (pushed.current) history.back();
    else {
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
      setOpenId(null);
    }
  }, []);

  // ----- delete -----
  const removeOne = useCallback(async (file: ApiFile) => {
    try {
      await deleteFile(file.id);
      removeFiles([file.id]);
      toast(`Deleted ${file.name}`, "success");
      announce(`Deleted ${file.name}.`);
    } catch (err) {
      // 404 means it is already gone (another tab); drop it quietly.
      if ((err as { status?: number }).status === 404) removeFiles([file.id]);
      else toast((err as Error).message, "error");
    }
    void refreshSummary();
  }, []);

  const removeSelected = useCallback(async () => {
    const ids = [...selected];
    try {
      const { deleted, missing } = await deleteFiles(ids);
      removeFiles([...deleted, ...missing]);
      const msg = `Deleted ${deleted.length} ${deleted.length === 1 ? "file" : "files"}${missing.length ? ` (${missing.length} already gone)` : ""}`;
      toast(msg, "success");
      announce(msg);
      setSelected(new Set());
      setSelecting(false);
    } catch (err) {
      toast((err as Error).message, "error");
    }
    void refreshSummary();
  }, [selected]);

  const copySelected = useCallback(async () => {
    const links = files
      .filter((f) => selected.has(f.id))
      .map((f) => f.watchUrl ?? f.url);
    try {
      await navigator.clipboard.writeText(links.join("\n"));
      toast(
        `Copied ${links.length} ${links.length === 1 ? "link" : "links"}`,
        "success",
      );
    } catch {
      toast("Copy failed. Your browser blocked clipboard access.", "error");
    }
  }, [files, selected]);

  // ----- selection -----
  const activate = useCallback(
    (id: string) => (e: MouseEvent | KeyboardEvent) => {
      if (!selecting) {
        open(id);
        return;
      }
      setSelected((s) =>
        e.shiftKey ? rangeSelect(order, anchor, id, s) : toggleId(s, id),
      );
      setAnchor(id);
    },
    [selecting, order, anchor, open],
  );

  // ----- keyboard -----
  const columns = () => {
    const tiles = gridRef.current?.querySelectorAll<HTMLElement>("[data-tile]");
    if (!tiles || tiles.length === 0) return 1;
    const top = tiles[0]!.offsetTop;
    let n = 0;
    for (const t of tiles) {
      if (t.offsetTop !== top) break;
      n += 1;
    }
    return n || 1;
  };
  const focusAt = (i: number) => {
    if (i < 0 || i >= order.length) return;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(order[i]!)}"]`)
      ?.focus();
  };
  const tileKeys = (id: string) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    const i = order.indexOf(id);
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns(),
    };
    if (e.key in moves) {
      e.preventDefault();
      focusAt(i + moves[e.key]!);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(id)(e);
    } else if (e.key === "x" || e.key === " ") {
      e.preventDefault();
      setSelecting(true);
      setSelected((s) => toggleId(s, id));
      setAnchor(id);
    }
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      if (e.key === "/" && !typing && !openId) {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "Escape" && selecting && !openId) {
        setSelecting(false);
        setSelected(new Set());
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "a" &&
        selecting &&
        !typing
      ) {
        e.preventDefault();
        setSelected(new Set(order));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting, order, openId]);

  const selectedBytes = files
    .filter((f) => selected.has(f.id))
    .reduce((n, f) => n + f.size, 0);

  return (
    <>
      <StorageStrip />
      {files.length === 0 ? (
        <main className="empty">
          <img src="/assets/mascot.png" alt="" width="128" height="128" />
          <h2>No files yet</h2>
          <p className="muted">
            Drop a file anywhere, paste, or press <strong>Upload</strong>.
            Uploads from <code>/upload</code> in Discord land here too.
          </p>
        </main>
      ) : (
        <main className="gallery-main">
          <div className="toolbar">
            <label className="toolbar-label" htmlFor="filter">
              Filter
            </label>
            <input
              ref={filterRef}
              className="toolbar-input"
              type="search"
              id="filter"
              placeholder="Filter by filename  ( / )"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="seg" role="radiogroup" aria-label="Kind">
              {(["all", "image", "video"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => setKind(k)}
                >
                  {k === "all" ? "All" : k === "image" ? "Img" : "Vid"}
                </button>
              ))}
            </div>
            <label className="toolbar-label" htmlFor="sort">
              Sort
            </label>
            <select
              className="toolbar-select"
              id="sort"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              {SORTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button small"
              aria-pressed={selecting}
              onClick={() => {
                setSelecting((s) => !s);
                setSelected(new Set());
              }}
            >
              {selecting ? "Done" : "Select"}
            </button>
            <span className="toolbar-count">
              {visible.length} of {files.length}
            </span>
          </div>
          <div
            className="sheet"
            id="sheet"
            role="grid"
            aria-label="Your uploads"
            aria-multiselectable={selecting || undefined}
            ref={gridRef}
          >
            {visible.map((f) => (
              <FileTile
                key={f.id}
                file={f}
                selecting={selecting}
                selected={selected.has(f.id)}
                fresh={fresh.has(f.id)}
                onActivate={activate(f.id)}
                onOpen={() => open(f.id)}
                onDelete={() => removeOne(f)}
                onKeyDown={tileKeys(f.id)}
              />
            ))}
          </div>
          {visible.length === 0 && (
            <p className="sheet-empty">No files match that filter.</p>
          )}
          <p className="sheet-note">
            Oldest files are cleared as storage fills. Keep your own copy of
            anything that matters.
          </p>
        </main>
      )}

      {selecting && selected.size > 0 && (
        <div className="select-bar panel" role="region" aria-label="Selection">
          <div className="select-bar-in">
            <span className="select-bar-count">
              {selected.size} selected · {formatBytes(selectedBytes)}
            </span>
            <button
              type="button"
              className="button small"
              onClick={copySelected}
            >
              Copy links
            </button>
            <ArmButton
              describe={`${selected.size} files`}
              onConfirm={removeSelected}
            />
            <button
              type="button"
              className="button small"
              onClick={() => setSelected(new Set())}
            >
              Esc
            </button>
          </div>
        </div>
      )}

      {openId && (
        <Lightbox
          files={visible}
          openId={openId}
          onClose={close}
          onNavigate={navigate}
          onDelete={removeOne}
        />
      )}
    </>
  );
}
```

Before Task 17 exists, create `web/src/islands/Lightbox.tsx` exporting a component that returns `null`, so this compiles. Task 17 replaces it.

- [ ] **Step 7: Fill the Files page**

`web/src/pages/dashboard/index.astro`:

```astro
---
import Dashboard from "../../layouts/Dashboard.astro";
import FilesView from "../../islands/FilesView";
import { getMyUsage, listMyFiles } from "@server/me/data";
import { dashboardHeaders } from "../../lib/server/headers";

const { deps, user } = Astro.locals;
if (!user) return Astro.redirect("/login?next=%2Fdashboard", 302);
dashboardHeaders(Astro.response.headers);
const [files, summary] = await Promise.all([listMyFiles(deps, user.id), getMyUsage(deps, user.id, "7d")]);
---

<Dashboard title="Dashboard" tab="files">
  <FilesView client:load initialFiles={files} initialSummary={summary} />
</Dashboard>
```

- [ ] **Step 8: Run tests and do a manual check**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

Manual check (sign in as described in Task 14 Step 13):

1. Open `/dashboard` and check:
   - three tiles appear
   - `/` focuses the filter
   - arrow keys move between tiles
   - Select mode, shift-click and Ctrl/Cmd+A work
   - two-click delete works
   - the storage strip and sparkline render
   - the console shows zero errors and zero CSP violations

- [ ] **Step 9: Commit**

```bash
git add web/src/islands web/src/pages/dashboard/index.astro test/pages.test.ts
git commit -m "feat: dashboard Files tab with filter, selection and bulk delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: Lightbox

**Files:**

- Modify: `web/src/islands/Lightbox.tsx` (replace the stub)

**Interfaces:**

- Consumes: `ApiFile`, `CopyButton`, `ArmButton`, `Expiry`, `formatBytes`.
- Produces: `<Lightbox files openId onClose onNavigate onDelete />`. `onDelete(file): Promise<void>`. After a delete it moves to the next file, or closes when none is left.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef } from "react";
import type { ApiFile } from "@server/me/types";
import { formatBytes } from "../lib/format";
import ArmButton from "./ArmButton";
import CopyButton from "./CopyButton";
import Expiry from "./Expiry";

interface Props {
  files: ApiFile[];
  openId: string;
  onClose(): void;
  onNavigate(id: string): void;
  onDelete(file: ApiFile): Promise<void>;
}

export default function Lightbox({
  files,
  openId,
  onClose,
  onNavigate,
  onDelete,
}: Props) {
  const index = files.findIndex((f) => f.id === openId);
  const file = index >= 0 ? files[index] : undefined;
  const dialog = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  // An id that is not (or no longer) in the list closes the viewer.
  useEffect(() => {
    if (!file) onClose();
  }, [file, onClose]);

  useEffect(() => {
    returnTo.current = document.activeElement;
    dialog.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      (returnTo.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && index < files.length - 1) {
        onNavigate(files[index + 1]!.id);
      } else if (e.key === "ArrowLeft" && index > 0) {
        onNavigate(files[index - 1]!.id);
      } else if (e.key === "Tab" && dialog.current) {
        // Keep focus inside the dialog.
        const focusable = dialog.current.querySelectorAll<HTMLElement>(
          "button, a[href], video[controls], select, input",
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [files, index, onClose, onNavigate]);

  if (!file) return null;
  const share = file.watchUrl ?? file.url;
  const video = file.kind === "video";

  async function remove() {
    const next = files[index + 1] ?? files[index - 1];
    await onDelete(file!);
    if (next) onNavigate(next.id);
    else onClose();
  }

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      tabIndex={-1}
      ref={dialog}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="lb-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {video ? (
          <video key={file.id} controls autoPlay playsInline src={file.url} />
        ) : (
          <img key={file.id} src={file.url} alt={file.name} />
        )}
      </div>
      <aside className="lb-side panel">
        <div className="lb-side-in">
          <h2 className="lb-name">{file.name}</h2>
          <dl className="lb-facts">
            <dt>Size</dt>
            <dd>{formatBytes(file.size)}</dd>
            <dt>Dimensions</dt>
            <dd>
              {file.width && file.height
                ? `${file.width}×${file.height}`
                : "unknown"}
            </dd>
            <dt>Uploaded</dt>
            <dd>{new Date(file.createdAt).toLocaleString()}</dd>
            <dt>Lifetime</dt>
            <dd>
              <Expiry at={file.expiresAt} />
            </dd>
          </dl>
          <div className="lb-actions">
            <CopyButton
              text={share}
              label={video ? "Copy page" : "Copy link"}
            />
            {video && <CopyButton text={file.url} label="Copy direct" />}
            <a
              className="button small"
              href={share}
              target="_blank"
              rel="noopener"
            >
              Open
            </a>
            <ArmButton describe={file.name} onConfirm={remove} />
          </div>
          <p className="muted">
            {index + 1} / {files.length} · ← → browse · Esc close
          </p>
        </div>
      </aside>
      <button
        type="button"
        className="button small lb-close"
        onClick={onClose}
        aria-label="Close viewer"
      >
        Esc
      </button>
      {index > 0 && (
        <button
          type="button"
          className="button small lb-prev"
          aria-label="Previous file"
          onClick={() => onNavigate(files[index - 1]!.id)}
        >
          ←
        </button>
      )}
      {index < files.length - 1 && (
        <button
          type="button"
          className="button small lb-next"
          aria-label="Next file"
          onClick={() => onNavigate(files[index + 1]!.id)}
        >
          →
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck, build, manual check**

Run: `pnpm typecheck && pnpm build:web`
Expected: exit 0.

Manual check, signed in as in Task 16:

- Click a tile: the viewer opens and the URL gains `#f=…`.
- ← and → change the file.
- Esc closes it and the URL loses the hash.
- Open it again, then press browser Back: it closes.
- Reload with a hash: it reopens.
- Tab stays inside the dialog.
- Delete from the lightbox advances to the next file.

- [ ] **Step 3: Commit**

```bash
git add web/src/islands/Lightbox.tsx
git commit -m "feat: dashboard lightbox with keyboard nav and deep links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 18: Upload tray, drop-anywhere and paste

**Files:**

- Create: `web/src/islands/UploadTray.tsx`
- Modify: `web/src/layouts/Dashboard.astro`

**Interfaces:**

- Consumes: `queueReducer`, `nextToStart`, `isBusy`, `preflight`, `ACCEPT_ATTR`, `uploadFile`, `readDimensions` (`public/measure.js`), `addFile`, `refreshSummary`, `summaryStore`, `toast`, `CopyButton`, and `ApiLimits`.
- Produces: `<UploadTray limits={ApiLimits} />`. It listens for clicks on `[data-upload-trigger]`, window drag/drop, and document paste. Its TTL is kept in `localStorage["dash:ttl"]`.

- [ ] **Step 1: Implement `UploadTray.tsx`**

```tsx
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ApiLimits } from "@server/me/types";
import { readDimensions } from "../../../public/measure.js";
import { formatBytes } from "../lib/format";
import { ACCEPT_ATTR, preflight } from "../lib/preflight";
import {
  isBusy,
  nextToStart,
  queueReducer,
  type QueueAction,
  type QueueItem,
} from "../lib/queue";
import { addFile, refreshSummary, summaryStore } from "../lib/state";
import { toast } from "../lib/toast";
import { uploadFile } from "../lib/uploader";
import CopyButton from "./CopyButton";

const TTL_KEY = "dash:ttl";

function readTtl(limits: ApiLimits): string {
  try {
    const saved = localStorage.getItem(TTL_KEY);
    if (saved && limits.ttlOptions.some((o) => o.value === saved)) return saved;
  } catch {
    /* storage blocked: fall through */
  }
  return limits.defaultTtl;
}

function Thumb({ file }: { file: File | undefined }) {
  const url = useMemo(
    () =>
      file && file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    [file],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (url) return <img className="tray-thumb" src={url} alt="" />;
  return (
    <span className="tray-thumb pixel">
      {file?.type.startsWith("video/") ? "VID" : "?"}
    </span>
  );
}

const STATUS_TEXT: Record<QueueItem["status"], (i: QueueItem) => string> = {
  queued: () => "waiting",
  uploading: (i) => `${Math.round(i.progress * 100)}%`,
  done: () => "done",
  failed: () => "failed",
  cancelled: () => "cancelled",
};

export default function UploadTray({ limits }: { limits: ApiLimits }) {
  const [items, dispatch] = useReducer(queueReducer, []);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const files = useRef(new Map<string, File>());
  const running = useRef<{ key: string; abort(): void } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [ttl, setTtl] = useState(limits.defaultTtl);
  const ttlRef = useRef(ttl);
  ttlRef.current = ttl;

  useEffect(() => setTtl(readTtl(limits)), [limits]);
  useEffect(() => {
    if (!summaryStore.get()) void refreshSummary();
  }, []);

  const enqueue = useCallback(
    (list: File[]) => {
      if (list.length === 0) return;
      const s = summaryStore.get();
      const pending = itemsRef.current.filter(
        (i) => i.status === "queued" || i.status === "uploading",
      );
      const remaining = s?.rateLimits.uploads.remaining ?? null;
      const quotaFree =
        (s ? s.storage.quota - s.storage.used : limits.maxUserBytes) -
        pending.reduce((n, i) => n + i.size, 0);
      const result = preflight(
        list,
        {
          maxFileBytes: limits.maxFileBytes,
          maxUserBytes: limits.maxUserBytes,
          uploadsRemaining:
            remaining === null ? null : Math.max(0, remaining - pending.length),
        },
        quotaFree,
      );
      if (result.willEvict)
        toast(
          "Not enough free space: your oldest files will be removed to make room.",
          "info",
          7000,
        );
      const add = list.map((f, i) => {
        const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        files.current.set(key, f);
        return {
          key,
          name: f.name || "pasted-image.png",
          size: f.size,
          type: f.type,
          error: result.errors[i] ?? null,
        };
      });
      dispatch({ type: "add", items: add });
      setOpen(true);
    },
    [limits],
  );

  // Run one upload at a time.
  useEffect(() => {
    const next = nextToStart(items);
    if (!next || running.current) return;
    const file = files.current.get(next.key);
    if (!file) {
      dispatch({
        type: "fail",
        key: next.key,
        error: "File is no longer available",
      });
      return;
    }
    dispatch({ type: "start", key: next.key });
    running.current = { key: next.key, abort: () => {} };
    void (async () => {
      const url = URL.createObjectURL(file);
      const dims = await readDimensions(file, url);
      URL.revokeObjectURL(url);
      // Cancelled while measuring: free the slot, then nudge the effect (a
      // progress action always yields a new array) so the next file starts.
      if (
        itemsRef.current.find((i) => i.key === next.key)?.status !== "uploading"
      ) {
        running.current = null;
        dispatch({ type: "progress", key: next.key, progress: 0 });
        return;
      }
      const handle = uploadFile(file, { ttl: ttlRef.current, ...dims }, (p) =>
        dispatch({ type: "progress", key: next.key, progress: p }),
      );
      running.current = { key: next.key, abort: handle.abort };
      let outcome: QueueAction;
      try {
        const result = await handle.promise;
        outcome = { type: "done", key: next.key, result };
        addFile(result);
        void refreshSummary();
      } catch (err) {
        outcome = {
          type: "fail",
          key: next.key,
          error: (err as Error).message,
        };
      }
      // Free the slot *before* dispatching: the dispatch re-runs this effect,
      // which must see the slot empty to start the next queued file.
      running.current = null;
      dispatch(outcome);
    })();
  }, [items]);

  // Upload button, drag anywhere, paste.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest("[data-upload-trigger]"))
        input.current?.click();
    };
    const hasFiles = (e: DragEvent) =>
      [...(e.dataTransfer?.types ?? [])].includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      enqueue([...(e.dataTransfer?.files ?? [])]);
    };
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as Element | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
        return;
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (pasted.length === 0) return;
      e.preventDefault();
      enqueue(pasted);
    };
    document.addEventListener("click", onClick);
    window.addEventListener("dragenter", onOver);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("dragenter", onOver);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, [enqueue]);

  const busy = isBusy(items);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const cancel = (key: string) => {
    if (running.current?.key === key) running.current.abort();
    dispatch({ type: "cancel", key });
  };

  const done = items.filter((i) => i.status === "done").length;

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          enqueue([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-in panel">
            <div>
              <span className="pixel">Drop to upload</span>
            </div>
          </div>
        </div>
      )}
      <section className="tray panel" aria-label="Uploads">
        <div className="tray-in">
          <header className="tray-head">
            <button
              type="button"
              className="tray-toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <span className="pixel">Uploads</span>
              {items.length > 0 && (
                <span className="count">
                  {done}/{items.length}
                </span>
              )}
            </button>
            <label className="tray-ttl">
              <span className="muted">Keep for</span>
              <select
                className="toolbar-select"
                value={ttl}
                onChange={(e) => {
                  setTtl(e.target.value);
                  try {
                    localStorage.setItem(TTL_KEY, e.target.value);
                  } catch {
                    /* per-viewer convenience only */
                  }
                }}
              >
                {limits.ttlOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {items.length > 0 && !busy && (
              <button
                type="button"
                className="button small"
                onClick={() => dispatch({ type: "clearFinished" })}
              >
                Clear
              </button>
            )}
          </header>
          {open &&
            (items.length === 0 ? (
              <p className="muted tray-hint">
                Drop files anywhere, paste an image, or press Upload.
              </p>
            ) : (
              <ul className="tray-list">
                {items.map((i) => (
                  <li key={i.key} className={`tray-row ${i.status}`}>
                    <Thumb file={files.current.get(i.key)} />
                    <div className="tray-main">
                      <span className="tray-name" title={i.name}>
                        {i.name}
                      </span>
                      <span className="muted">
                        {formatBytes(i.size)} · {STATUS_TEXT[i.status](i)}
                      </span>
                      {i.status === "uploading" && (
                        <div
                          className="progress"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(i.progress * 100)}
                          aria-label={`Uploading ${i.name}`}
                        >
                          <div
                            className="progress-bar"
                            style={{ width: `${i.progress * 100}%` }}
                          />
                        </div>
                      )}
                      {i.status === "failed" && i.error && (
                        <span className="status error">{i.error}</span>
                      )}
                    </div>
                    <div className="tray-acts">
                      {i.status === "done" && i.result && (
                        <CopyButton
                          text={i.result.watchUrl ?? i.result.url}
                          label="Copy"
                        />
                      )}
                      {(i.status === "failed" || i.status === "cancelled") &&
                        i.retryable && (
                          <button
                            type="button"
                            className="button small"
                            onClick={() =>
                              dispatch({ type: "retry", key: i.key })
                            }
                          >
                            Retry
                          </button>
                        )}
                      {(i.status === "queued" || i.status === "uploading") && (
                        <button
                          type="button"
                          className="button small"
                          onClick={() => cancel(i.key)}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </section>
    </>
  );
}
```

- [ ] **Step 2: Mount it in the layout**

In `Dashboard.astro`:

- Import `UploadTray` and `limitsFor` (`import { limitsFor } from "@server/me/data";`).
- Replace `<slot name="tray" />` with:

```astro
  <UploadTray client:load transition:persist="upload-tray" limits={limitsFor(Astro.locals.deps.config)} />
```

- [ ] **Step 3: Typecheck, build, manual check**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

Manual check, signed in:

- Drag three images over the page and check the overlay appears.
- Drop them. Rows appear, progress runs one row at a time, and tiles slide into the grid with a gold flash.
- Paste a screenshot and check it queues.
- Pick a `.txt` file and check its row fails immediately as "Only images and videos are accepted", with no Retry.
- Switch to the Usage tab mid-upload and check the tray and its progress survive.
- Reload during an upload and check the browser asks for confirmation.

- [ ] **Step 4: Commit**

```bash
git add web/src/islands/UploadTray.tsx web/src/layouts/Dashboard.astro
git commit -m "feat: multi-file upload tray with drop-anywhere, paste and retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Usage tab with dither-kit charts

**Files:**

- Create: `web/src/islands/UsageView.tsx`
- Modify: `web/src/pages/dashboard/usage.astro`
- Test: `test/pages.test.ts` (append)

**Interfaces:**

- Consumes: `ApiUsage`, `getJson`, `formatBytes`/`formatDay`/`formatClock`/`formatDelta`, `useNow`, and dither-kit's `AreaChart`, `Area`, `BarChart`, `Bar`, `PieChart`, `Pie`, `Legend`, `Grid`, `XAxis`, `YAxis`, `Tooltip`, `DitherGradient`.
- Produces: `<UsageView initial={ApiUsage} />`.
- Do not import `@server/storage/usage` into browser code: it pulls in the Redis-bound store module. Compute the day string with `new Date(ms).toISOString().slice(0, 10)`, as below.

- [ ] **Step 1: Write the failing SSR test**

Append to `test/pages.test.ts`:

```ts
describe("/dashboard/usage", () => {
  it("renders stat tiles for the requested range", async () => {
    h = await makeHarness();
    await seed({ userId: "7", size: 2048 });
    const t = await createAuthSession(h.deps.redis, {
      id: "7",
      username: "neo",
      globalName: "",
      avatar: "",
    });
    const html = await (
      await h.app.fetch(
        new Request("https://uploader.test/dashboard/usage?range=7d", {
          headers: { Cookie: `__Host-session=${t}` },
        }),
      )
    ).text();
    expect(html).toContain("Storage");
    expect(html).toContain("2 KB");
    expect(html).toMatch(/aria-checked="true"[^>]*>7D/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm build:web && pnpm vitest run test/pages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `UsageView.tsx`**

```tsx
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApiRate, ApiUsage, UsageRange } from "@server/me/types";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  DitherGradient,
  Grid,
  Legend,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "../components/dither-kit";
import { getJson } from "../lib/api";
import {
  formatBytes,
  formatClock,
  formatDay,
  formatDelta,
} from "../lib/format";
import { useNow } from "../lib/state";

const RANGES: UsageRange[] = ["7d", "30d", "90d"];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function Stat({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panel">
      <div className="stat-in">
        <span className="pixel stat-label">{label}</span>
        <span className="stat-value">{value}</span>
        {children}
        {sub && <span className="muted">{sub}</span>}
      </div>
    </div>
  );
}

function Meter({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      className={`meter${pct >= 90 ? " warn" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div
        className="meter-fill"
        style={{ width: `${value > 0 ? Math.max(pct, 2) : 0}%` }}
      />
    </div>
  );
}

function LimitRow({ name, rate }: { name: string; rate: ApiRate }) {
  if (rate.remaining === null) {
    return (
      <>
        <span>{name}</span>
        <span className="muted">No limit</span>
        <span />
      </>
    );
  }
  return (
    <>
      <span>{name}</span>
      <Meter
        value={rate.used}
        max={rate.limit}
        label={`${name} used this hour`}
      />
      <span className="strip-num">
        {rate.used}/{rate.limit}
      </span>
    </>
  );
}

function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <DitherGradient from="indigo" direction="up" opacity={0.35} />
    </div>
  );
}

export default function UsageView({ initial }: { initial: ApiUsage }) {
  const [usage, setUsage] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<"uploads" | "bytes">("uploads");
  const [scope, setScope] = useState<"range" | "allTime">("range");
  const reduced = useReducedMotion();
  const now = useNow();

  async function load(range: UsageRange) {
    setLoading(true);
    setError(null);
    try {
      const next = await getJson<ApiUsage>(`/api/me/usage?range=${range}`);
      setUsage(next);
      const url = new URL(location.href);
      url.searchParams.set("range", range);
      history.replaceState(history.state, "", url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const { storage, totals, series, commands, rateLimits } = usage;
  const rows = useMemo(
    () => series.map((p) => ({ ...p, label: formatDay(p.date) })),
    [series],
  );
  const commandRows = useMemo(
    () =>
      Object.entries(scope === "range" ? commands.range : commands.allTime).map(
        ([command, count]) => ({ command: `/${command}`, count }),
      ),
    [commands, scope],
  );
  const mix = [
    { kind: "images", bytes: storage.images.bytes },
    { kind: "videos", bytes: storage.videos.bytes },
  ];
  const uploadsDelta = formatDelta(totals.uploads, totals.prevUploads);
  const bytesDelta = formatDelta(totals.bytes, totals.prevBytes, formatBytes);
  const since = formatDay(
    new Date(usage.trackingSince).toISOString().slice(0, 10),
  );
  const resetIn = rateLimits.uploads.resetAt - now;

  return (
    <main className="usage">
      <div className="usage-head">
        <div className="seg" role="radiogroup" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={usage.range === r}
              disabled={loading}
              onClick={() => load(r)}
            >
              {r.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="muted">Commands tracked since {since}</span>
      </div>

      {error && (
        <p className="status error" role="alert">
          {error}{" "}
          <button
            type="button"
            className="button small"
            onClick={() => load(usage.range)}
          >
            Retry
          </button>
        </p>
      )}

      <div className="stats-grid">
        <Stat
          label="Storage"
          value={`${formatBytes(storage.used)} / ${formatBytes(storage.quota)}`}
        >
          <Meter
            value={storage.used}
            max={storage.quota}
            label="Storage used"
          />
        </Stat>
        <Stat
          label="Files"
          value={String(storage.images.count + storage.videos.count)}
          sub={`img ${storage.images.count} · vid ${storage.videos.count}`}
        />
        <Stat
          label="Uploads"
          value={String(totals.uploads)}
          sub={
            <span className={`delta-${uploadsDelta.dir}`}>
              {uploadsDelta.text}
            </span>
          }
        />
        <Stat
          label="Data in"
          value={formatBytes(totals.bytes)}
          sub={
            <span className={`delta-${bytesDelta.dir}`}>{bytesDelta.text}</span>
          }
        />
      </div>

      <section className="panel" aria-labelledby="activity-h">
        <div className="chart-in">
          <header className="chart-head">
            <h2 id="activity-h">Activity</h2>
            <div className="seg" role="radiogroup" aria-label="Metric">
              <button
                type="button"
                role="radio"
                aria-checked={metric === "uploads"}
                onClick={() => setMetric("uploads")}
              >
                Uploads
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={metric === "bytes"}
                onClick={() => setMetric("bytes")}
              >
                Bytes
              </button>
            </div>
          </header>
          <div className="chart-box">
            {loading ? (
              <Skeleton />
            ) : (
              <AreaChart
                data={rows}
                config={{
                  [metric]: {
                    label: metric === "uploads" ? "Uploads" : "Bytes",
                    color: "cyan",
                  },
                }}
                animate={!reduced}
                bloom={reduced ? "off" : "low"}
              >
                <Grid />
                <XAxis
                  dataKey="label"
                  maxTicks={usage.range === "7d" ? 7 : 8}
                />
                <YAxis
                  tickFormatter={
                    metric === "bytes" ? formatBytes : (n) => String(n)
                  }
                />
                <Area dataKey={metric} variant="gradient" />
                <Tooltip
                  labelKey="label"
                  valueFormatter={
                    metric === "bytes"
                      ? (v) => formatBytes(v)
                      : (v) => String(v)
                  }
                />
              </AreaChart>
            )}
          </div>
        </div>
      </section>

      <div className="chart-row">
        <section className="panel" aria-labelledby="commands-h">
          <div className="chart-in">
            <header className="chart-head">
              <h2 id="commands-h">Commands</h2>
              <div className="seg" role="radiogroup" aria-label="Command scope">
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === "range"}
                  onClick={() => setScope("range")}
                >
                  {usage.range.toUpperCase()}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === "allTime"}
                  onClick={() => setScope("allTime")}
                >
                  All
                </button>
              </div>
            </header>
            <div className="chart-box">
              {loading ? (
                <Skeleton />
              ) : commandRows.length === 0 ? (
                <p className="chart-empty">No commands in this range.</p>
              ) : (
                <BarChart
                  data={commandRows}
                  config={{ count: { label: "Runs", color: "indigo" } }}
                  animate={!reduced}
                >
                  <Grid />
                  <XAxis dataKey="command" />
                  <YAxis />
                  <Bar dataKey="count" />
                  <Tooltip labelKey="command" />
                </BarChart>
              )}
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="mix-h">
          <div className="chart-in">
            <header className="chart-head">
              <h2 id="mix-h">Storage mix</h2>
            </header>
            <div className="chart-box">
              {storage.used === 0 ? (
                <p className="chart-empty">Nothing stored yet.</p>
              ) : (
                <PieChart
                  data={mix}
                  dataKey="bytes"
                  nameKey="kind"
                  innerRadius={0.55}
                  config={{
                    images: { label: "Images", color: "cyan" },
                    videos: { label: "Videos", color: "gold" },
                  }}
                  animate={!reduced}
                >
                  <Pie />
                  <Legend />
                  <Tooltip valueFormatter={(v) => formatBytes(v)} />
                </PieChart>
              )}
            </div>
          </div>
        </section>
      </div>

      <section className="panel" aria-labelledby="limits-h">
        <div className="chart-in">
          <header className="chart-head">
            <h2 id="limits-h">Limits this hour</h2>
            <span className="muted">resets in {formatClock(resetIn)}</span>
          </header>
          <div className="limits-in">
            <LimitRow name="Uploads" rate={rateLimits.uploads} />
            <LimitRow name="Links opened" rate={rateLimits.sessions} />
          </div>
        </div>
      </section>
    </main>
  );
}
```

If `Legend`'s props differ from a no-arg call, check `web/src/components/dither-kit/legend.tsx` and pass what it requires. The kit's `index.ts` exports it.

- [ ] **Step 4: Fill the Usage page**

`web/src/pages/dashboard/usage.astro`:

```astro
---
import Dashboard from "../../layouts/Dashboard.astro";
import UsageView from "../../islands/UsageView";
import { getMyUsage, parseRange } from "@server/me/data";
import { dashboardHeaders } from "../../lib/server/headers";

const { deps, user } = Astro.locals;
if (!user) return Astro.redirect("/login?next=%2Fdashboard%2Fusage", 302);
dashboardHeaders(Astro.response.headers);
const usage = await getMyUsage(deps, user.id, parseRange(Astro.url.searchParams.get("range") ?? undefined));
---

<Dashboard title="Usage" tab="usage">
  <UsageView client:load initial={usage} />
</Dashboard>
```

- [ ] **Step 5: Tests, typecheck, manual check**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

Manual check:

- Charts animate in and the scrub tooltip glides.
- 7D/30D/90D refetch and update `?range=`.
- The "Bytes" toggle reformats the axis.
- Emulating reduced motion in DevTools stops the animations.
- Zero console or CSP errors.
- At 375px wide, the charts stack in one column.

- [ ] **Step 6: Commit**

```bash
git add web/src/islands/UsageView.tsx web/src/pages/dashboard/usage.astro test/pages.test.ts
git commit -m "feat: usage tab with dither-kit activity, command and storage charts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 20: Dashboard end-to-end flows

**Files:**

- Create: `test/e2e/dashboard.spec.ts`

**Interfaces:**

- Consumes: `POST /__e2e/login` (Task 14), `POST /__e2e/reset` (Task 1), `solidPng` (Task 1 fixtures).

- [ ] **Step 1: Write `test/e2e/dashboard.spec.ts`**

```ts
import { test, expect, type Page } from "@playwright/test";
import { solidPng } from "./fixtures.js";

test.use({ reducedMotion: "reduce" });

const png = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: solidPng(32, 32, [91, 84, 214]),
});

async function login(page: Page): Promise<void> {
  await page.request.post("/__e2e/reset");
  const { token } = await (await page.request.post("/__e2e/login")).json();
  await page.context().addCookies([
    {
      name: "__Host-session",
      value: token,
      domain: "localhost",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  return problems;
}

const tiles = (page: Page) => page.locator("[data-tile]");
const pick = (page: Page) => page.locator('input[type="file"][multiple]');

test("signed-out visitors are sent to login with next", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
});

test("files tab renders without console or CSP errors", async ({ page }) => {
  const problems = watchConsole(page);
  await login(page);
  await page.goto("/dashboard");
  await expect(tiles(page)).toHaveCount(3);
  await expect(page.getByRole("meter", { name: "Storage used" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("queue uploads several files, rejects a bad one up front", async ({
  page,
}) => {
  await login(page);
  await page.goto("/dashboard");
  await pick(page).setInputFiles([
    png("one.png"),
    png("two.png"),
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
  ]);
  const tray = page.getByRole("region", { name: "Uploads" });
  await expect(
    tray.getByText("Only images and videos are accepted"),
  ).toBeVisible();
  await expect(tray.locator(".tray-row.done")).toHaveCount(2);
  await expect(tiles(page)).toHaveCount(5);
  await expect(
    tray.locator(".tray-row.failed").getByRole("button", { name: "Retry" }),
  ).toHaveCount(0);
});

test("server rejection shows its message and Retry works", async ({ page }) => {
  await login(page);
  await page.goto("/dashboard");
  let reject = true;
  await page.route("**/api/me/files", async (route) => {
    if (route.request().method() === "POST" && reject) {
      reject = false;
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: "You're uploading too quickly. Try again in 12 minute(s).",
          retryAfterSeconds: 700,
        }),
      });
    }
    return route.continue();
  });
  await pick(page).setInputFiles([png("late.png")]);
  const row = page.locator(".tray-row").filter({ hasText: "late.png" });
  await expect(row.getByText("You're uploading too quickly")).toBeVisible();
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(row).toHaveClass(/done/);
});

test("cancel stops an upload in flight; retry sends it", async ({ page }) => {
  await login(page);
  await page.goto("/dashboard");
  let hold = true;
  await page.route("**/api/me/files", async (route) => {
    if (route.request().method() === "POST" && hold) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    return route.continue().catch(() => {});
  });
  await pick(page).setInputFiles([png("slow.png")]);
  const row = page.locator(".tray-row").filter({ hasText: "slow.png" });
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toHaveClass(/cancelled/);
  hold = false;
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(row).toHaveClass(/done/);
});

test("upload keeps running across a tab switch", async ({ page }) => {
  await login(page);
  await page.goto("/dashboard");
  await page.route("**/api/me/files", async (route) => {
    if (route.request().method() === "POST")
      await new Promise((r) => setTimeout(r, 1500));
    return route.continue();
  });
  await pick(page).setInputFiles([png("travel.png")]);
  await page.getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL(/\/dashboard\/usage$/);
  const row = page.locator(".tray-row").filter({ hasText: "travel.png" });
  await expect(row).toHaveClass(/done/, { timeout: 10_000 });
  await page.getByRole("link", { name: "Files" }).click();
  await expect(tiles(page).filter({ hasText: "travel.png" })).toHaveCount(1);
});

test("lightbox: open, arrow through, Esc and Back close it", async ({
  page,
}) => {
  await login(page);
  await page.goto("/dashboard");
  await tiles(page).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/#f=/);
  const first = await dialog.getAttribute("aria-label");
  await page.keyboard.press("ArrowRight");
  await expect(dialog).not.toHaveAttribute("aria-label", first!);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await tiles(page).first().click();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
});

test("bulk select with shift-click and delete", async ({ page }) => {
  await login(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Select" }).click();
  await tiles(page).nth(0).click();
  await tiles(page)
    .nth(2)
    .click({ modifiers: ["Shift"] });
  const bar = page.getByRole("region", { name: "Selection" });
  await expect(bar).toContainText("3 selected");
  await bar.getByRole("button", { name: "Delete" }).click();
  await bar.getByRole("button", { name: "Delete?" }).click();
  await expect(
    page.getByRole("heading", { name: "No files yet" }),
  ).toBeVisible();
});

test("usage tab renders charts and switches range", async ({ page }) => {
  const problems = watchConsole(page);
  await login(page);
  await page.goto("/dashboard/usage");
  await expect(page.getByRole("radio", { name: "30D" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(".chart-box canvas").first()).toBeVisible();
  await page.getByRole("radio", { name: "7D" }).click();
  await expect(page).toHaveURL(/range=7d/);
  expect(problems).toEqual([]);
});
```

- [ ] **Step 2: Run the whole e2e suite**

Run: `pnpm test:e2e`
Expected: all legacy and dashboard tests pass. When a dashboard test fails, open the trace (`pnpm exec playwright show-trace test-results/…/trace.zip`) and fix the code, not the test, unless the test asserts something the spec doesn't require.

- [ ] **Step 3: Commit**

```bash
git add test/e2e
git commit -m "test: end-to-end flows for the dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: Docs and final verification

**Files:**

- Modify: `README.md`, `Dockerfile` (runtime env comment), `CLAUDE.md`

- [ ] **Step 1: README**

Add a section after the `/gallery` paragraph:

```markdown
## Dashboard

Sign in with Discord at `/login` for a dashboard with everything you have uploaded:

- **Files:** filter, sort, a lightbox, keyboard navigation (`/` filter, arrows, `Enter` open, `x` select), and bulk select with shift-click.
- **Uploading:** drop files anywhere, paste an image, or press **Upload**. Files queue one at a time with their own progress, cancel and retry. Dashboard uploads are stored and linked but not posted to Discord.
- **Usage:** storage against your quota, uploads and data per day (7/30/90 days), per-command counts, and hourly rate-limit headroom.

Sign-in uses OAuth2 with the `identify` scope only. The session is an `HttpOnly` cookie backed by Redis for 30 days. The Discord access token is discarded after reading your id, name and avatar.
```

In **Setup → 1. Discord application**, add:

```markdown
5. Under _OAuth2_, copy the **Client Secret** into `DISCORD_CLIENT_SECRET` and add
   `https://<your-domain>/auth/callback` as a **Redirect**. Without the secret the bot
   works as before and the dashboard says sign-in is not configured.
```

In **Setup → 2. Railway**, add:

```markdown
6. Confirm the Redis plugin persists to disk: `redis-cli CONFIG GET appendonly` should
   print `yes`. File records live only in Redis; if it ever comes back empty the service
   refuses to delete the files on the volume at boot and logs an error instead.
```

Add a **Development** note: `pnpm dev` rebuilds the Astro pages on change (no hot reload), and `pnpm test:e2e` runs the Playwright suite against an in-memory Redis.

- [ ] **Step 2: Dockerfile comment**

Add `DISCORD_CLIENT_SECRET (enables dashboard sign-in)` under `Optional:` in the runtime comment block.

- [ ] **Step 3: CLAUDE.md**

Under Workflow, add: `- Run \`pnpm test:e2e\` when touching anything under \`web/\` or \`public/\`; the legacy-page screenshots must not change.`

- [ ] **Step 4: Full verification**

```bash
pnpm dlx prettier --write .
pnpm dlx prettier --check .
pnpm test
pnpm typecheck
pnpm test:e2e
docker build -t discord-uploader:check .
```

Expected: every command exits 0, and the Docker image builds. If `prettier --write` reformats files, review the diff before committing. It must not touch `web/src/components/dither-kit/` (ignored) or the screenshots.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: dashboard, sign-in setup and Redis persistence check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
