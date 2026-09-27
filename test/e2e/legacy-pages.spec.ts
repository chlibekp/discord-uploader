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
