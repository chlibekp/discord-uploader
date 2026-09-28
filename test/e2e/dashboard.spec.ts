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
  await expect(tray.locator(".tray-row.failed")).toHaveCount(1);
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
  // A plain setTimeout(3000) here would keep the route handler alive for the
  // full 3s even after the client cancels, leaking a pending continue() into
  // whichever test runs next in this single worker. Releasing it the moment
  // Cancel is clicked keeps the mock's lifetime inside this test.
  let releaseHold = () => {};
  const holdReleased = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  await page.route("**/api/me/files", async (route) => {
    if (route.request().method() === "POST" && hold) {
      await Promise.race([
        new Promise((r) => setTimeout(r, 3000)),
        holdReleased,
      ]);
    }
    return route.continue().catch(() => {});
  });
  await pick(page).setInputFiles([png("slow.png")]);
  const row = page.locator(".tray-row").filter({ hasText: "slow.png" });
  await row.getByRole("button", { name: "Cancel" }).click();
  releaseHold();
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

test("a malformed #f= hash leaves the files view working", async ({ page }) => {
  const problems = watchConsole(page);
  await login(page);
  await page.goto("/dashboard#f=%E0");
  await expect(tiles(page)).toHaveCount(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tiles(page).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(problems).toEqual([]);
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

test("lightbox: an armed Delete does not carry over to the next file", async ({
  page,
}) => {
  await login(page);
  await page.goto("/dashboard");
  await tiles(page).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const first = await dialog.getAttribute("aria-label");

  // Arrow keys with a modifier belong to the browser/OS, not the viewer.
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(dialog).toHaveAttribute("aria-label", first!);

  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Delete?", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(dialog).not.toHaveAttribute("aria-label", first!);
  // Read once rather than retry: a retrying assertion would pass anyway once
  // the arm times out after 4s.
  expect(await dialog.locator(".button.danger").textContent()).toBe("Delete");
});

test("bulk delete skips selected tiles the filter hides", async ({ page }) => {
  await login(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Select" }).click();
  await tiles(page).filter({ hasText: "cyan-square.png" }).click();
  await tiles(page).filter({ hasText: "gold-wide.png" }).click();
  const bar = page.getByRole("region", { name: "Selection" });
  await expect(bar).toContainText("2 selected");

  await page.getByLabel("Filter", { exact: true }).fill("gold");
  await expect(tiles(page)).toHaveCount(1);
  await expect(bar).toContainText("1 selected");
  await bar.getByRole("button", { name: "Delete" }).click();
  await bar.getByRole("button", { name: "Delete?" }).click();
  await expect(tiles(page)).toHaveCount(0);

  await page.getByLabel("Filter", { exact: true }).fill("");
  await expect(tiles(page)).toHaveCount(2);
  await expect(tiles(page).filter({ hasText: "cyan-square.png" })).toHaveCount(
    1,
  );
  await expect(tiles(page).filter({ hasText: "gold-wide.png" })).toHaveCount(0);
});

test("usage tab renders charts and switches range", async ({ page }) => {
  const problems = watchConsole(page);
  await login(page);
  await page.goto("/dashboard/usage");
  const rangeGroup = page.getByRole("radiogroup", { name: "Range" });
  await expect(rangeGroup.getByRole("radio", { name: "30D" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(".chart-box canvas").first()).toBeVisible();
  await rangeGroup.getByRole("radio", { name: "7D" }).click();
  await expect(page).toHaveURL(/range=7d/);
  expect(problems).toEqual([]);
});
